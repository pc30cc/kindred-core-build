import { Router, raw } from 'express';
import { z } from 'zod';
import {
  resolveBillingConfig,
  getProvider,
  getAllProviders,
  processWebhookEvent,
  logBillingEvent,
  checkEntitlement,
} from '../services/billing/index.js';
import {
  claimBillingWebhookEvent,
  finalizeBillingWebhookEvent,
} from '../services/billing/index.js';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import {
  handleWorkspaceEntitlementChanged,
  handlePlanDefinitionChanged,
} from '../services/billing/entitlementChange.js';
import {
  requireUser as requireSessionUser,
  authorizeWorkspaceAccess,
  requirePlatformAdmin,
} from '../lib/workspaceAuth.js';
import {
  createSubscriptionIntent,
  getPaymentIntent,
  setPaymentIntentProviderRef,
  claimIntentForProcessing,
  markIntentSucceeded,
  markPaymentIntentFailed,
  markPaymentIntentExpired,
  expireStalePaymentIntents,
  markPaymentIntentCanceled,
  noteIntentFailureAttempt,
  providerRefMatchesIntent,
  isIntentUsable,
  IRAN_PROVIDERS,
  type PaymentIntentRow,
} from '../services/billing/paymentIntent.js';
import { classifyPlanAction, computeSubscriptionWindow } from '../services/billing/periods.js';
import { requiresReferenceBinding } from '../services/billing/providerBinding.js';
import {
  applySubscriptionPayment,
  recordCustomerPayment,
} from '../services/billing/applyPayment.js';
import * as aiLedger from '../services/ai-billing/ledger.js';
import { buildTransactionHistory } from '../services/billing/transactionHistory.js';
import {
  assertLegacyPathAllowed,
  auditV2,
  isV2Active,
  LegacyPathRejectedError,
} from '../services/billing/rollout.js';
import { settleAndApply } from '../services/billing/invoice/settle.js';
import { buildWorkspaceBillingReadModel } from '../services/billing/readModel.js';

/**
 * Customer-friendly receipt for a finalized intent. Everything here comes from
 * server state (intent + resulting payment/subscription/wallet) — the success
 * screen must never trust anything from the redirect query string.
 */
async function buildReceipt(config: ServerConfig, intent: PaymentIntentRow) {
  const supabase = getServiceClient(config);
  const { data: payment } = await supabase
    .from('billing_payments')
    .select('id, amount, currency, paid_at, provider_payment_id, plan_name_snapshot, action_type, billing_interval, created_at')
    .eq('payment_intent_id', intent.id)
    .maybeSingle();

  const receipt: Record<string, unknown> = {
    status: intent.status,
    intentId: intent.id,
    invoiceNumber: intent.invoice_number,
    amountIrr: intent.amount_irr,
    purchaseType: intent.purchase_type,
    actionType: (payment?.action_type as string | null) || intent.action_type || null,
    providerName: intent.provider_name,
    providerRef: (payment?.provider_payment_id as string | null) || intent.provider_ref || null,
    orderId: (payment?.id as string | undefined) || intent.id,
    paidAt: (payment?.paid_at as string | null) || intent.succeeded_at || null,
    planName: (payment?.plan_name_snapshot as string | null) || null,
    billingInterval: (payment?.billing_interval as string | null) || intent.billing_interval || null,
  };

  if (intent.purchase_type === 'ai_credit_topup') {
    try {
      receipt.newAiBalanceIrr = await aiLedger.availableBalance(config, intent.workspace_id);
    } catch { /* balance is a nicety, never a blocker */ }
  } else {
    const { data: sub } = await supabase
      .from('workspace_subscriptions')
      .select('current_period_end, plan_id, billing_plans(name)')
      .eq('workspace_id', intent.workspace_id)
      .maybeSingle();
    receipt.periodEnd = (sub?.current_period_end as string | null) || null;
    if (!receipt.planName) {
      receipt.planName = ((sub as any)?.billing_plans?.name as string | undefined) || null;
    }
  }

  return receipt;
}


export const billingRouter = Router();

function getConfig(req: any) {
  const c = (req as any).serverConfig;
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

// ─── Auth / Authorization ────────────────────────────────────────
//
// Identity is derived from the first-party session cookie
// (server/lib/workspaceAuth.ts); workspace membership/role is verified
// BEFORE any service-role database access or provider request happens.

function serverConfigOf(req: any): ServerConfig {
  return (req as any).serverConfig as ServerConfig;
}

/**
 * The gateway return URL must belong to this deployment. Accepts the request's
 * own origin (the normal same-origin reverse-proxy topology) plus any
 * explicitly configured CORS origin. Everything else is an open redirect.
 */
function isAllowedCallbackUrl(req: any, raw: string): boolean {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.hostname !== 'localhost' && target.hostname !== '127.0.0.1') {
    return false;
  }

  const allowed = new Set<string>();
  const host = req.get?.('host');
  if (host) allowed.add(`${req.protocol}://${host}`);
  const originHeader = req.get?.('origin');
  if (originHeader) {
    // Only trusted because mutating requests already passed the origin check
    // in workspaceAuth (verifyOriginForMutation).
    allowed.add(originHeader);
  }
  for (const o of serverConfigOf(req)?.corsOrigins || []) {
    if (o && o !== '*') {
      try { allowed.add(new URL(o).origin); } catch { /* ignore malformed config */ }
    }
  }

  return allowed.has(target.origin);
}


/** Resolves the calling user from the session cookie. Writes 401 and returns null on failure. */
async function requireUser(req: any, res: any): Promise<string | null> {
  return requireSessionUser(req, res);
}

type BillingAuth = { userId: string; isAdmin: boolean; role: string | null };

/**
 * Authenticates the caller and verifies they may act on `workspaceId`.
 * `manage: true` additionally requires workspace owner/admin (billing actions).
 * Never reveals whether a workspace exists to a non-member.
 */
async function authorizeWorkspace(
  req: any,
  res: any,
  workspaceId: unknown,
  opts: { manage?: boolean } = {},
): Promise<BillingAuth | null> {
  return authorizeWorkspaceAccess(req, res, workspaceId, opts);
}

/** Super-admin (platform) gate — `has_role(uid,'admin')` only. No fallbacks. */
async function requireSuperAdmin(req: any, res: any, next: any) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as any).adminUserId = userId;
  next();
}

// ─── GET /api/billing/providers — list all billing providers with capabilities ──
billingRouter.get('/providers', async (req, res) => {
  if (!(await requireUser(req, res))) return;
  res.json({ providers: getAllProviders() });
});

// ─── GET /api/billing/plans — list available plans ──────────────────
billingRouter.get('/plans', async (req, res) => {
  const { url, key } = getConfig(req);
  const locale = (req.query.locale as string) || 'en';
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .eq('is_active', true)
    .eq('is_hidden', false)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // Filter plans based on locale currency display
  const plans = (data || []).map((plan: any) => ({
    ...plan,
    displayPrice: plan.prices?.[locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : plan.default_currency || 'USD'],
    displayCurrency: locale === 'fa' ? 'IRR' : locale === 'tr' ? 'TRY' : plan.default_currency || 'USD',
  }));
  res.json({ plans });
});

// ─── GET /api/billing/status/:workspaceId ────────────────────────
billingRouter.get('/status/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);

  // Lazy-flip stale trials to "expired" so downstream UI/queries see correct status.
  try { await supabase.rpc('expire_stale_trials' as any); } catch { /* non-fatal */ }
  // Same idea for payment attempts: a pending intent past its TTL is expired,
  // never "canceled" (the customer may simply have closed the tab).
  try { await expireStalePaymentIntents(serverConfigOf(req), workspaceId); } catch { /* non-fatal */ }

  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*, billing_plans(*)')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const { data: payments } = await supabase
    .from('billing_payments')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(30);

  // Payment ATTEMPTS live in billing_payment_intents (never faked into
  // billing_payments). An abandoned/canceled/failed/expired attempt is a real
  // event in the customer's history and must stay visible.
  const { data: intents } = await supabase
    .from('billing_payment_intents')
    .select('id, created_at, updated_at, succeeded_at, amount_irr, final_amount_irr, status, purchase_type, action_type, provider_name, provider_ref, invoice_number, billing_interval, plan_id, plan_name_snapshot, failure_reason, metadata, billing_plans(name)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(30);

  // Unified, de-duplicated customer-facing history (payment wins, intent
  // enriches). The raw arrays stay for backward compatibility.
  const transactions = buildTransactionHistory((payments || []) as any, (intents || []) as any);

  res.json({
    subscription: sub,
    payments: payments || [],
    attempts: (intents || []).filter((i: any) => i.status !== 'succeeded'),
    transactions,
  });
});


// ─── POST /api/billing/invoice-preview ───────────────────────────
//
// Issues the invoice the customer sees BEFORE being sent to the bank. The
// invoice is a real, server-created payment intent (with a unique invoice
// number), so the amount shown is exactly the amount charged and an abandoned
// invoice stays visible in the transaction history.
const invoicePreviewSchema = z.object({
  workspaceId: z.string().uuid(),
  planId: z.string(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  currency: z.string().default('IRR'),
});

billingRouter.post('/invoice-preview', async (req, res) => {
  const parsed = invoicePreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const input = parsed.data;
  if (!(await authorizeWorkspace(req, res, input.workspaceId, { manage: true }))) return;

  const { url, key } = getConfig(req);
  try {
    const resolved = await resolveBillingConfig(url, key, input.workspaceId);
    if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });
    if (!IRAN_PROVIDERS.has(resolved.provider.name)) {
      return res.status(400).json({ error: 'INVOICE_PREVIEW_UNSUPPORTED_PROVIDER' });
    }

    const supabase = createClient(url, key);
    const currency = input.currency.toUpperCase();
    const { data: plan } = await supabase
      .from('billing_plans')
      .select('id, name, prices, sort_order')
      .eq('id', input.planId)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });

    const amount = Number((plan.prices as any)?.[currency]?.[input.interval]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'FREE_PLAN_NO_CHECKOUT' });
    }

    const { data: sub } = await supabase
      .from('workspace_subscriptions')
      .select('plan_id, status, current_period_end, billing_plans(sort_order)')
      .eq('workspace_id', input.workspaceId)
      .maybeSingle();

    const actionType = classifyPlanAction({
      currentPlanId: (sub as any)?.plan_id ?? null,
      currentPlanRank: ((sub as any)?.billing_plans?.sort_order as number | undefined) ?? null,
      currentStatus: (sub as any)?.status ?? null,
      nextPlanId: plan.id,
      nextPlanRank: (plan as any).sort_order ?? null,
    });

    const window = computeSubscriptionWindow({
      now: new Date(),
      interval: input.interval,
      action: actionType,
      currentPeriodEnd: (sub as any)?.current_period_end ? new Date((sub as any).current_period_end) : null,
    });

    const { data: workspace } = await supabase
      .from('workspaces')
      .select('name')
      .eq('id', input.workspaceId)
      .maybeSingle();

    // Re-opening the proforma dialog for the SAME purchase must show the SAME
    // document number — a new number per dialog open would flood the history
    // with phantom attempts. Only a still-usable, unbound, identical intent is
    // reused; anything else gets a fresh proforma.
    const { data: reusable } = await supabase
      .from('billing_payment_intents')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .eq('status', 'pending')
      .eq('plan_id', plan.id)
      .eq('billing_interval', input.interval)
      .eq('amount_irr', amount)
      .eq('provider_name', resolved.provider.name)
      .is('provider_ref', null)
      .not('invoice_number', 'is', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const intent = (reusable as PaymentIntentRow | null) || await createSubscriptionIntent(serverConfigOf(req), {
      workspaceId: input.workspaceId,
      planId: plan.id,
      interval: input.interval,
      providerName: resolved.provider.name,
      amountIrr: amount,
      actionType,
      planNameSnapshot: plan.name,
      workspaceNameSnapshot: (workspace as any)?.name ?? null,
      periodStart: window.start.toISOString(),
      periodEnd: window.end.toISOString(),
      metadata: { origin: 'invoice_preview' },
    });

    res.json({
      invoice: {
        intentId: intent.id,
        // "پیش‌فاکتور" document number — NOT a legal/tax invoice number.
        invoiceNumber: intent.invoice_number,
        issuedAt: intent.created_at,
        expiresAt: intent.expires_at,
        planId: plan.id,
        planName: intent.plan_name_snapshot || plan.name,
        workspaceName: intent.workspace_name_snapshot || (workspace as any)?.name || null,
        interval: input.interval,
        actionType,
        amountIrr: intent.amount_irr ?? amount,
        discountIrr: intent.discount_irr ?? 0,
        totalIrr: intent.final_amount_irr ?? amount,
        periodStart: intent.period_start || window.start.toISOString(),
        periodEnd: intent.period_end || window.end.toISOString(),
        stacked: window.stacked,
        providerName: resolved.provider.name,
      },
    });

  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/invoice/:intentId/cancel ──────────────────
// The customer closed the invoice without paying. Recorded truthfully.
billingRouter.post('/invoice/:intentId/cancel', async (req, res) => {
  const intentId = String(req.params.intentId || '');
  const cfg = serverConfigOf(req);
  const intent = await getPaymentIntent(cfg, intentId);
  if (!intent) return res.status(404).json({ error: 'Not found' });
  if (!(await authorizeWorkspace(req, res, intent.workspace_id, { manage: true }))) return;
  await markPaymentIntentCanceled(cfg, intentId);
  res.json({ success: true });
});

// ─── POST /api/billing/checkout — create checkout session ────────
//
// The charged amount is NEVER taken from the client. It is always looked up
// server-side from `billing_plans.prices[currency][interval]`. For the
// Iranian one-time gateways (which read the amount back off the request),
// a `billing_payment_intents` row is created first and its id is appended to
// the callback URL, so verify-callback can re-derive the amount/plan/interval
// from that row instead of trusting anything the browser sends back.
const checkoutSchema = z.object({
  workspaceId: z.string().uuid(),
  planId: z.string(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  currency: z.string().default('USD'),
  callbackUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
  phone: z.string().optional(),
  /** Invoice the customer just confirmed (from /invoice-preview). Reused instead of issuing a second one. */
  intentId: z.string().uuid().optional(),
});

billingRouter.post('/checkout', async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });

  const input = parsed.data;
  if (!(await authorizeWorkspace(req, res, input.workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);
  try {
    // Billing Engine V2 boundary. For a V2-owned workspace the legacy
    // "checkout → applySubscriptionPayment" path does not exist any more: the
    // invoice is the only commercial authority. An old deployed client gets a
    // structured incompatibility response, never an unsafe V1 fallback.
    try {
      await assertLegacyPathAllowed(serverConfigOf(req), {
        workspaceId: input.workspaceId,
        path: 'legacy_plan_checkout',
        nextAction: 'CREATE_INVOICE',
      });
    } catch (guard) {
      if (guard instanceof LegacyPathRejectedError) {
        return res.status(409).json({ error: 'BILLING_V2_REQUIRED', nextAction: guard.nextAction });
      }
      throw guard;
    }
    const resolved = await resolveBillingConfig(url, key, input.workspaceId);
    if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });

    const supabase = createClient(url, key);
    const currency = input.currency.toUpperCase();
    const { data: plan } = await supabase
      .from('billing_plans')
      .select('id, prices')
      .eq('id', input.planId)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });
    const amount = Number((plan.prices as any)?.[currency]?.[input.interval]);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: `Plan has no ${currency} price for interval ${input.interval}` });
    }
    // A zero-price (free) plan must never open a payment gateway: gateways
    // reject 0 amounts and the customer would land on a broken bank page.
    if (amount <= 0) {
      return res.status(400).json({ error: 'FREE_PLAN_NO_CHECKOUT' });
    }

    // Open-redirect guard: the return URL is attacker-controllable input and
    // is handed to the bank, so it must point back at this deployment.
    if (!isAllowedCallbackUrl(req, input.callbackUrl)) {
      return res.status(400).json({ error: 'Invalid callbackUrl' });
    }

    let callbackUrl = input.callbackUrl;
    let intentId: string | undefined;
    let invoiceNumber: string | null = null;
    if (IRAN_PROVIDERS.has(resolved.provider.name)) {
      let intent: PaymentIntentRow | null = null;
      if (input.intentId) {
        // Reuse the invoice the customer already saw — but only when it still
        // describes exactly this purchase. Anything else is rejected instead of
        // silently charging a different amount than the invoice showed.
        const existing = await getPaymentIntent(serverConfigOf(req), input.intentId);
        const matches =
          existing &&
          existing.workspace_id === input.workspaceId &&
          existing.status === 'pending' &&
          existing.plan_id === input.planId &&
          existing.billing_interval === input.interval &&
          existing.amount_irr === amount &&
          existing.provider_name === resolved.provider.name;
        if (!matches) return res.status(409).json({ error: 'INVOICE_NO_LONGER_VALID' });
        intent = existing;
      } else {
        intent = await createSubscriptionIntent(serverConfigOf(req), {
          workspaceId: input.workspaceId,
          planId: input.planId,
          interval: input.interval,
          providerName: resolved.provider.name,
          amountIrr: amount,
        });
      }
      intentId = intent!.id;
      invoiceNumber = intent!.invoice_number;
      const sep = callbackUrl.includes('?') ? '&' : '?';
      callbackUrl = `${callbackUrl}${sep}intent=${intent!.id}&provider=${encodeURIComponent(resolved.provider.name)}`;
    }


    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId: input.workspaceId,
      planId: input.planId,
      interval: input.interval,
      currency,
      callbackUrl,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      metadata: {
        amount: String(amount),
        phone: input.phone || '',
      },
    });

    // Fail-closed reference binding: for a provider that has a bindable
    // checkout reference, an intent that is not bound (gateway returned no
    // reference, or the DB write failed) must NOT be reported as a successful
    // checkout — the callback could otherwise be finalized with any payment.
    if (intentId) {
      const ref = result.providerRef || result.authority || result.sessionId || '';
      const bindingRequired = requiresReferenceBinding(resolved.provider.name);
      if (bindingRequired || ref) {
        try {
          await setPaymentIntentProviderRef(serverConfigOf(req), intentId, ref);
        } catch (bindError: any) {
          await markPaymentIntentFailed(serverConfigOf(req), intentId, String(bindError?.message || 'binding_failed'));
          if (bindingRequired) {
            return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
          }
        }
      }
    }

    await logBillingEvent(url, key, {
      workspace_id: input.workspaceId,
      event_type: 'checkout_initiated',
      provider_name: resolved.provider.name,
      amount,
      currency,
      status: 'pending',
      metadata: { planId: input.planId, sessionId: result.sessionId, intentId },
    });

    res.json({ success: true, ...result, intentId, invoiceNumber });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/verify-callback — verify callback from gateway ──
//
// `params` are the raw, untrusted redirect query params from the gateway
// (Authority/Status, trackId, RefNum, ...). For the Iranian one-time gateways
// an `intentId` is REQUIRED and the whole finalization is a state machine:
//
//   1. re-read the server-created intent (amount/plan/interval/purpose);
//   2. bind the callback to the payment reference stored on that intent
//      (fail-closed: intent A can never be finalized with payment B);
//   3. ask the gateway to verify, with the SERVER amount;
//   4. atomically claim `pending → processing`;
//   5. apply the idempotent financial side effect (plan period or AI credit)
//      and write the customer-facing `billing_payments` row;
//   6. only then mark the intent `succeeded`.
//
// If step 5 crashes the intent stays `processing` and is recoverable: a retry
// re-runs the same idempotent side effect and completes. No replay can ever
// apply a period, a credit or a payment row twice.
billingRouter.post('/verify-callback', async (req, res) => {
  const { workspaceId, provider: providerName, params, intentId } = req.body;
  if (!workspaceId || !providerName) return res.status(400).json({ error: 'Missing workspaceId or provider' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const provider = getProvider(providerName);
  if (!provider || !provider.verifyPayment) return res.status(400).json({ error: 'Provider does not support payment verification' });

  try {
    // Use the same workspace/global resolution chain as checkout. Reading only
    // provider_configs here broke verification for platform-default gateways.
    const resolved = await resolveBillingConfig(url, key, workspaceId);
    if (!resolved || resolved.provider.name !== providerName) {
      return res.status(400).json({ error: 'Provider not configured' });
    }

    if (IRAN_PROVIDERS.has(providerName)) {
      const cfg = serverConfigOf(req);
      if (typeof intentId !== 'string' || !intentId) {
        return res.status(400).json({ error: 'Missing intentId' });
      }
      const intent = await getPaymentIntent(cfg, intentId);
      // Cross-workspace / cross-provider finalization is impossible.
      if (!intent || intent.workspace_id !== workspaceId || intent.provider_name !== providerName) {
        return res.status(400).json({ error: 'Invalid payment intent' });
      }

      if (intent.status === 'succeeded') {
        return res.json({
          success: true,
          verified: true,
          duplicate: true,
          receipt: await buildReceipt(cfg, intent),
        });
      }
      if (intent.status === 'failed' || intent.status === 'canceled' || intent.status === 'expired') {
        return res.json({ success: true, verified: false, status: intent.status });
      }
      if (intent.status === 'pending' && !isIntentUsable(intent)) {
        await markPaymentIntentExpired(cfg, intent.id);
        return res.status(400).json({ error: 'Payment intent expired' });
      }

      // Identity binding — the callback must carry the same provider
      // reference the checkout session produced for THIS intent.
      const binding = providerRefMatchesIntent(intent, params);
      if (binding.ok === false) {
        await markPaymentIntentFailed(cfg, intent.id, binding.reason);
        return res.status(400).json({ error: 'Payment reference does not match this order' });
      }

      const result = await provider.verifyPayment(resolved.config, {
        ...params,
        amount: String(intent.amount_irr),
      });
      if (!result.verified) {
        await markPaymentIntentFailed(cfg, intent.id, 'gateway_not_verified');
        return res.json({ success: true, ...result });
      }

      // pending → processing (or resume a crashed finalization).
      const claim = await claimIntentForProcessing(cfg, intent.id);
      if (claim.claimed === false) {
        if (claim.reason === 'in_flight') {
          // Another request is finalizing right now — genuinely pending.
          return res.json({ success: true, verified: true, pending: true });
        }
        const latest = await getPaymentIntent(cfg, intent.id);
        return res.json({
          success: true,
          verified: latest?.status === 'succeeded',
          duplicate: true,
          receipt: latest ? await buildReceipt(cfg, latest) : undefined,
        });
      }

      const providerRef = result.providerRef || intent.provider_ref || null;

      // ── Callback routing (Phase B rule 12) ──────────────────────────────
      // The intent's OWN immutable engine stamp decides how verified money is
      // applied — never the workspace's current rollout state. A V2 intent
      // settles its invoice; a V1 intent applies the legacy path. A V1 intent
      // arriving at a workspace that is already V2-owned must never bypass V2:
      // cutover policy guarantees no BOUND legacy intent survives activation,
      // so reaching this branch means something is wrong. The money is parked
      // for reconciliation instead of being applied or discarded.
      const intentEngine = (intent as any).billing_engine_version === 'v2' ? 'v2' : 'v1';
      const invoiceId = (intent as any).invoice_id as string | null | undefined;

      if (intentEngine === 'v1' && (await isV2Active(cfg, workspaceId))) {
        const parked = await recordCustomerPayment(cfg, {
          workspaceId,
          providerName,
          providerPaymentId: providerRef,
          paymentIntentId: intent.id,
          invoiceNumber: intent.invoice_number,
          amount: intent.amount_irr,
          currency: 'IRR',
          purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
          actionType: (intent.action_type as any) || 'plan_new',
          metadata: { intentId: intent.id, providerRef, parked: 'legacy_intent_after_v2_cutover' },
        });
        if (parked.id) {
          await getServiceClient(cfg)
            .from('billing_payments')
            .update({
              reconciliation_state: 'unapplied',
              reconciliation_reason: 'legacy_intent_after_v2_cutover',
            })
            .eq('id', parked.id);
        }
        await auditV2(cfg, {
          workspaceId,
          event: 'billing_v2_legacy_path_rejected',
          reason: 'legacy_intent_callback_after_cutover',
          details: { intentId: intent.id, providerRef },
        });
        await noteIntentFailureAttempt(cfg, intent, 'legacy_intent_after_v2_cutover');
        return res.status(409).json({
          error: 'BILLING_V2_REQUIRED',
          nextAction: 'CONTACT_SUPPORT_PAYMENT_PARKED',
        });
      }

      try {
        if (intentEngine === 'v2' && invoiceId) {
          const payment = await recordCustomerPayment(cfg, {
            workspaceId,
            providerName,
            providerPaymentId: providerRef,
            paymentIntentId: intent.id,
            invoiceNumber: intent.invoice_number,
            amount: intent.amount_irr,
            currency: 'IRR',
            purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
            actionType: (intent.action_type as any) || 'plan_new',
            metadata: { intentId: intent.id, providerRef, invoiceId },
          });
          await settleAndApply(cfg, {
            invoiceId,
            paymentId: payment.id as string,
            amountIrr: Number((intent as any).expected_amount_irr ?? intent.amount_irr),
            commandKey: `intent:${intent.id}`,
          });
        } else if (intent.purchase_type === 'ai_credit_topup') {
          await aiLedger.purchaseCredit(cfg, {
            workspaceId,
            amount: String(intent.amount_irr),
            commandKey: `intent:${intent.id}`,
            reason: 'ai_credit_topup',
          });
          await recordCustomerPayment(cfg, {
            workspaceId,
            providerName,
            providerPaymentId: providerRef,
            paymentIntentId: intent.id,
            invoiceNumber: intent.invoice_number,
            amount: intent.amount_irr,
            currency: 'IRR',
            purchaseType: 'ai_credit_topup',
            actionType: 'ai_credit_topup',
            metadata: { intentId: intent.id, providerRef },
          });
          await logBillingEvent(url, key, {
            workspace_id: workspaceId,
            event_type: 'ai_credit_topup',
            provider_name: providerName,
            provider_event_id: providerRef || undefined,
            amount: intent.amount_irr,
            currency: 'IRR',
            status: 'success',
            metadata: { intentId: intent.id },
          });
        } else {
          const applied = await applySubscriptionPayment(cfg, {
            workspaceId,
            planId: intent.plan_id as string,
            interval: (intent.billing_interval || 'monthly') as 'monthly' | 'yearly',
            providerName,
            paymentIntentId: intent.id,
          });
          await recordCustomerPayment(cfg, {
            workspaceId,
            providerName,
            providerPaymentId: providerRef,
            paymentIntentId: intent.id,
            invoiceNumber: intent.invoice_number,
            amount: intent.amount_irr,
            currency: 'IRR',
            purchaseType: 'subscription',
            actionType: applied.actionType,
            planId: applied.planId,
            planNameSnapshot: applied.planName,
            billingInterval: applied.interval,
            metadata: {
              intentId: intent.id,
              providerRef,
              periodStart: applied.periodStart,
              periodEnd: applied.periodEnd,
              stacked: applied.stacked,
            },
          });
          await logBillingEvent(url, key, {
            workspace_id: workspaceId,
            event_type: 'payment_succeeded',
            provider_name: providerName,
            provider_event_id: providerRef || intent.id,
            amount: intent.amount_irr,
            currency: 'IRR',
            status: 'success',
            metadata: { intentId: intent.id, actionType: applied.actionType },
          });
        }
      } catch (sideEffectError: any) {
        // The customer HAS paid. Keep the intent recoverable and tell the UI
        // this is pending, never "failed" — a retry finishes the job.
        await noteIntentFailureAttempt(cfg, intent, String(sideEffectError?.message || sideEffectError));
        // eslint-disable-next-line no-console
        console.error('[billing] finalization failed, intent recoverable', intent.id);
        return res.status(202).json({ success: true, verified: true, pending: true });
      }

      await markIntentSucceeded(cfg, intent.id);
      const finalIntent = await getPaymentIntent(cfg, intent.id);
      return res.json({
        success: true,
        ...result,
        receipt: finalIntent ? await buildReceipt(cfg, finalIntent) : undefined,
      });
    }


    const result = await provider.verifyPayment(
      resolved.config,
      params
    );

    if (result.verified) {
      await processWebhookEvent(url, key, providerName, {
        type: 'payment_succeeded',
        providerEventId: result.providerRef,
        providerPaymentId: result.providerRef,
        workspaceId,
        amount: result.amount,
        raw: params,
      });
    }

    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/webhook/:provider — handle provider webhooks ──
//
// Public by necessity (external providers call it), but fail-closed:
// only providers whose `verifyWebhook` performs a cryptographic signature
// check over the exact raw body may reach `processWebhookEvent`. Everything
// else is rejected without touching the database.
//
// Mounted separately (see server/index.ts) with a raw body parser so the
// signature is computed over the exact bytes the provider signed.
export const billingWebhookRouter = Router();

/** Providers with a cryptographic webhook signature over the raw body. */
const SIGNED_WEBHOOK_PROVIDERS = new Set(['stripe', 'paddle', 'lemon_squeezy', 'paytr']);

type WebhookCandidate = { workspaceId: string | null; config: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Generic ops log — never includes body, headers, secrets or signatures. */
function logWebhookRejection(providerName: string, category: string) {
  // eslint-disable-next-line no-console
  console.warn(`[billing-webhook] rejected provider=${providerName} reason=${category}`);
}

billingWebhookRouter.post('/:provider', raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const { url, key } = getConfig(req);
  const providerName = req.params.provider;
  const provider = getProvider(providerName);
  if (!provider) return res.status(404).json({ error: 'Unknown provider' });

  if (!SIGNED_WEBHOOK_PROVIDERS.has(providerName)) {
    // No signed webhook contract → callback payloads are not proof of payment.
    // These providers must go through the authenticated verify-callback route,
    // which calls the provider's server-to-server verify API.
    logWebhookRejection(providerName, 'no_signed_webhook_contract');
    return res.status(400).json({ error: 'Webhook verification not supported for this provider' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!rawBody) {
    logWebhookRejection(providerName, 'empty_body');
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }

  const supabase = createClient(url, key);

  // Candidate configs: each workspace-scoped config, plus the platform default.
  // Verification is attempted against each; only the config whose secret
  // validates the signature is used, which also pins the workspace.
  const candidates: WebhookCandidate[] = [];
  const { data: wsConfigs } = await supabase
    .from('provider_configs')
    .select('workspace_id, config')
    .eq('provider_type', 'billing')
    .eq('provider_name', providerName)
    .eq('is_active', true)
    .limit(50);
  for (const row of (wsConfigs || []) as Array<{ workspace_id: string | null; config: unknown }>) {
    if (isRecord(row.config)) candidates.push({ workspaceId: row.workspace_id, config: row.config });
  }
  const { data: globalRows } = await supabase
    .from('app_runtime_config')
    .select('key, value')
    .in('key', ['default_billing_provider', 'billing_default_provider']);
  for (const row of (globalRows || []) as Array<{ key: string; value: unknown }>) {
    const globalValue = row.value;
    if (!isRecord(globalValue)) continue;
    const name = (globalValue.provider_name || globalValue.provider) as unknown;
    if (name !== providerName) continue;
    const inner = isRecord(globalValue.config) ? globalValue.config : {};
    candidates.push({ workspaceId: null, config: { ...globalValue, ...inner } });
  }

  // Evaluate EVERY candidate: stopping at the first verifying config would
  // hide an ambiguous secret collision between two workspaces, and stopping at
  // the first workspace mismatch would drop a later, correct candidate.
  const accepted: Array<{ event: NonNullable<Awaited<ReturnType<typeof provider.verifyWebhook>>>; workspaceId: string }> = [];
  let sawMismatch = false;
  let sawUnresolved = false;

  for (const candidate of candidates) {
    let event;
    try {
      event = await provider.verifyWebhook(
        { provider: providerName, ...candidate.config },
        headers,
        rawBody,
      );
    } catch {
      continue; // signature mismatch / malformed payload for this config
    }
    if (!event) continue;

    // Workspace binding: pin to the workspace that owns the verifying config.
    if (candidate.workspaceId) {
      if (event.workspaceId && event.workspaceId !== candidate.workspaceId) {
        sawMismatch = true;
        continue;
      }
      accepted.push({ event, workspaceId: candidate.workspaceId });
    } else if (typeof event.workspaceId === 'string' && event.workspaceId) {
      accepted.push({ event, workspaceId: event.workspaceId });
    } else {
      sawUnresolved = true;
    }
  }

  if (accepted.length > 1) {
    logWebhookRejection(providerName, 'ambiguous_candidate_configs');
    return res.status(400).json({ error: 'Webhook rejected' });
  }
  if (accepted.length === 0) {
    if (sawMismatch) {
      logWebhookRejection(providerName, 'workspace_mismatch');
      return res.status(400).json({ error: 'Webhook rejected' });
    }
    if (sawUnresolved) {
      logWebhookRejection(providerName, 'unresolved_workspace');
      return res.status(400).json({ error: 'Webhook rejected' });
    }
    logWebhookRejection(providerName, 'signature_not_verified');
    return res.status(400).json({ error: 'Webhook not verified' });
  }

  const { event, workspaceId } = accepted[0];
  event.workspaceId = workspaceId;

  // A stable provider event id is required for replay protection.
  const providerEventId = typeof event.providerEventId === 'string' ? event.providerEventId.trim() : '';
  if (!providerEventId) {
    logWebhookRejection(providerName, 'missing_provider_event_id');
    return res.status(400).json({ error: 'Webhook rejected' });
  }

  // Claim BEFORE any financial side effect. A replay loses the unique index
  // race and is acknowledged without touching subscriptions or payments.
  let claim;
  try {
    claim = await claimBillingWebhookEvent(url, key, {
      providerName,
      providerEventId,
      workspaceId,
      eventType: event.type,
      amount: event.amount,
      currency: event.currency,
      metadata: event.raw,
    });
  } catch {
    logWebhookRejection(providerName, 'claim_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  if (!claim.claimed) return res.json({ received: true, duplicate: true });

  try {
    await processWebhookEvent(url, key, providerName, event, { alreadyClaimed: true });
  } catch {
    await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'failed').catch(() => {});
    logWebhookRejection(providerName, 'processing_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'success').catch(() => {});
  return res.json({ received: true });
});

// ─── GET /api/billing/payment-intent/:intentId — status polling ──
//
// The success/failure screen polls this instead of guessing from the redirect
// query string, so a callback that arrived while finalization was still
// `processing` resolves to the real outcome a moment later.
billingRouter.get('/payment-intent/:intentId', async (req, res) => {
  const cfg = serverConfigOf(req);
  const intent = await getPaymentIntent(cfg, req.params.intentId);
  if (!intent) return res.status(404).json({ error: 'Not found' });
  if (!(await authorizeWorkspace(req, res, intent.workspace_id, { manage: true }))) return;

  return res.json({
    status: intent.status,
    pending: intent.status === 'pending' || intent.status === 'processing',
    receipt: intent.status === 'succeeded' ? await buildReceipt(cfg, intent) : null,
    failureReason: intent.failure_reason || null,
  });
});


// ─── POST /api/billing/subscription/cancel ───────────────────────
billingRouter.post('/subscription/cancel', async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = createClient(url, key);
  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub?.provider_subscription_id) return res.status(400).json({ error: 'No active subscription' });

  const provider = getProvider(sub.provider_name);
  if (!provider?.cancelSubscription) return res.status(400).json({ error: 'Provider does not support cancellation' });

  const resolved = await resolveBillingConfig(url, key, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing config found' });

  try {
    const result = await provider.cancelSubscription(resolved.config, sub.provider_subscription_id);
    if (result.success) {
      await supabase.from('workspace_subscriptions')
        .update({ status: 'canceled', cancel_at_period_end: true, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/subscription/resume ───────────────────────
billingRouter.post('/subscription/resume', async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = createClient(url, key);
  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub?.provider_subscription_id) return res.status(400).json({ error: 'No subscription found' });

  const provider = getProvider(sub.provider_name);
  if (!provider?.resumeSubscription) return res.status(400).json({ error: 'Provider does not support resume' });

  const resolved = await resolveBillingConfig(url, key, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing config found' });

  try {
    const result = await provider.resumeSubscription(resolved.config, sub.provider_subscription_id);
    if (result.success) {
      await supabase.from('workspace_subscriptions')
        .update({ status: 'active', cancel_at_period_end: false, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/portal — customer portal URL ─────────────
billingRouter.post('/portal', async (req, res) => {
  const { workspaceId, returnUrl } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = createClient(url, key);
  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub?.provider_customer_id) return res.status(400).json({ error: 'No customer found' });

  const provider = getProvider(sub.provider_name);
  if (!provider?.getPortalUrl) return res.status(400).json({ error: 'Provider does not support customer portal' });

  const resolved = await resolveBillingConfig(url, key, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing config found' });

  try {
    const result = await provider.getPortalUrl(resolved.config, sub.provider_customer_id, returnUrl || '/app/billing');
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/test — test provider connection ───────────
billingRouter.post('/test', async (req, res) => {
  // Accepts an arbitrary provider config (credentials + endpoints) and performs
  // an outbound request, so it is platform-admin only.
  const { provider: providerName, config } = req.body;
  {
    const userId = await requireUser(req, res);
    if (!userId) return;
    if (!(await isGlobalAdmin(serverConfigOf(req), userId))) {
      return res.status(403).json({ error: 'Not authorized' });
    }
  }
  if (!providerName) return res.status(400).json({ error: 'Missing provider name' });

  const provider = getProvider(providerName);
  if (!provider) return res.status(404).json({ error: `Unknown provider: ${providerName}` });

  try {
    const result = await provider.testConnection({ provider: providerName, ...config });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/billing/entitlement — check feature entitlement ────
billingRouter.get('/entitlement', async (req, res) => {
  const workspaceId = req.query.workspaceId as string;
  const feature = req.query.feature as string;
  if (!workspaceId || !feature) return res.status(400).json({ error: 'Missing workspaceId or feature' });
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const { url, key } = getConfig(req);

  try {
    const result = await checkEntitlement(url, key, workspaceId, feature);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/billing/events/:workspaceId — billing event history ──
billingRouter.get('/events/:workspaceId', async (req, res) => {
  if (!(await authorizeWorkspace(req, res, req.params.workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('billing_events')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
});

// ─── Admin: GET /api/billing/admin/overview — platform billing overview ──
billingRouter.get('/admin/overview', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);

  const [subs, payments, events, plans] = await Promise.all([
    supabase.from('workspace_subscriptions').select('*', { count: 'exact' }),
    supabase.from('billing_payments').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('billing_events').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('billing_plans').select('*').order('sort_order'),
  ]);

  const activeSubs = (subs.data || []).filter((s: any) => s.status === 'active' || s.status === 'trialing');

  res.json({
    totalSubscriptions: subs.count || 0,
    activeSubscriptions: activeSubs.length,
    recentPayments: payments.data || [],
    recentEvents: events.data || [],
    plans: plans.data || [],
  });
});


// ─── Admin: GET /api/billing/admin/finance-report — platform financial report ──
// Aggregations are computed server-side from the two financial sources of
// truth: billing_payments (settled money) and billing_payment_intents
// (attempts). No client-side guessing of revenue.
billingRouter.get('/admin/finance-report', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);

  const months = Math.min(Math.max(parseInt(String(req.query.months ?? '6'), 10) || 6, 1), 24);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - (months - 1), 1);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const [payments, intents, subs, plans, workspaces] = await Promise.all([
    supabase.from('billing_payments').select('*').gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(5000),
    supabase.from('billing_payment_intents').select('id, status, purchase_type, action_type, amount_irr, provider_name, created_at, workspace_id').gte('created_at', sinceIso).limit(5000),
    supabase.from('workspace_subscriptions').select('workspace_id, plan_id, status, billing_interval'),
    supabase.from('billing_plans').select('id, name, slug, prices, is_free'),
    supabase.from('workspaces').select('id, name, slug').limit(2000),
  ]);

  const paid = (payments.data || []).filter((p: any) => p.status === 'succeeded' || p.status === 'refunded' || p.status === 'partially_refunded');
  const planById = new Map((plans.data || []).map((p: any) => [p.id, p]));
  const workspaceById = new Map((workspaces.data || []).map((w: any) => [w.id, w]));

  const monthKeys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i, 1);
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  const seriesMap = new Map(monthKeys.map((m) => [m, { month: m, revenue: 0, count: 0, subscription: 0, topup: 0, refunded: 0 }]));

  const byProvider = new Map<string, { provider: string; revenue: number; count: number }>();
  const byPlan = new Map<string, { plan: string; revenue: number; count: number }>();
  const byWorkspace = new Map<string, { workspaceId: string; name: string; revenue: number; count: number }>();

  let grossRevenue = 0;
  let refundTotal = 0;

  for (const p of paid) {
    const amount = Number(p.amount || 0);
    const refund = Number(p.refund_amount || 0);
    grossRevenue += amount;
    refundTotal += refund;
    const key = String(p.paid_at || p.created_at).slice(0, 7);
    const bucket = seriesMap.get(key);
    const isTopup = p.action_type === 'ai_credit_topup' || p.purchase_type === 'ai_credit_topup';
    if (bucket) {
      bucket.revenue += amount;
      bucket.count += 1;
      bucket.refunded += refund;
      if (isTopup) bucket.topup += amount; else bucket.subscription += amount;
    }
    const provider = p.provider_name || 'unknown';
    const prov = byProvider.get(provider) || { provider, revenue: 0, count: 0 };
    prov.revenue += amount; prov.count += 1; byProvider.set(provider, prov);

    const planName = isTopup ? 'ai_credit_topup' : (p.plan_name_snapshot || planById.get(p.plan_id)?.name || 'unknown');
    const pl = byPlan.get(planName) || { plan: planName, revenue: 0, count: 0 };
    pl.revenue += amount; pl.count += 1; byPlan.set(planName, pl);

    if (p.workspace_id) {
      const ws = byWorkspace.get(p.workspace_id) || {
        workspaceId: p.workspace_id,
        name: workspaceById.get(p.workspace_id)?.name || p.workspace_id.slice(0, 8),
        revenue: 0, count: 0,
      };
      ws.revenue += amount; ws.count += 1; byWorkspace.set(p.workspace_id, ws);
    }
  }

  const intentRows = intents.data || [];
  const byStatus = new Map<string, number>();
  for (const i of intentRows) byStatus.set(i.status, (byStatus.get(i.status) || 0) + 1);
  const attempts = intentRows.length;
  const succeeded = byStatus.get('succeeded') || 0;

  // Recurring revenue snapshot from ACTIVE subscriptions, normalised monthly.
  let mrrIrr = 0;
  const planDistribution = new Map<string, number>();
  for (const s of subs.data || []) {
    if (s.status !== 'active' && s.status !== 'trialing') continue;
    const plan = planById.get(s.plan_id);
    if (!plan) continue;
    planDistribution.set(plan.name, (planDistribution.get(plan.name) || 0) + 1);
    if (plan.is_free) continue;
    const irr = (plan.prices as any)?.IRR || {};
    const monthly = s.billing_interval === 'yearly'
      ? Number(irr.yearly || 0) / 12
      : Number(irr.monthly || 0);
    mrrIrr += Math.round(monthly);
  }

  res.json({
    currency: 'IRR',
    months,
    totals: {
      grossRevenue,
      refundTotal,
      netRevenue: grossRevenue - refundTotal,
      paymentCount: paid.length,
      attempts,
      succeeded,
      conversionRate: attempts ? Math.round((succeeded / attempts) * 1000) / 10 : 0,
      avgOrderValue: paid.length ? Math.round(grossRevenue / paid.length) : 0,
      mrrIrr,
      arrIrr: mrrIrr * 12,
    },
    series: monthKeys.map((m) => seriesMap.get(m)!),
    byProvider: [...byProvider.values()].sort((a, b) => b.revenue - a.revenue),
    byPlan: [...byPlan.values()].sort((a, b) => b.revenue - a.revenue),
    byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    topWorkspaces: [...byWorkspace.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    planDistribution: [...planDistribution.entries()].map(([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count),
    recentPayments: (payments.data || []).slice(0, 50).map((p: any) => ({
      ...p,
      workspace_name: workspaceById.get(p.workspace_id)?.name || null,
    })),
  });
});

// ─── Admin: POST /api/billing/admin/plans — create/update plan ──

billingRouter.post('/admin/plans', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const plan = req.body;

  if (plan.id) {
    const { data: previousPlan } = await supabase
      .from('billing_plans')
      .select('is_active, entitlements, limits')
      .eq('id', plan.id)
      .maybeSingle();
    const { data, error } = await supabase.from('billing_plans').update(plan).eq('id', plan.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    // Phase 6-S5-R6 — editing a plan definition changes the effective
    // entitlements of EVERY workspace on that plan; queue a durable fan-out
    // job (skipped automatically when no AI-relevant field moved).
    await handlePlanDefinitionChanged(
      (req as any).serverConfig,
      plan.id,
      { previous: previousPlan as any, next: data as any },
    );
    return res.json({ plan: data });
  }

  const { data, error } = await supabase.from('billing_plans').insert(plan).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plan: data });
});

// ─── Admin: POST /api/billing/admin/grant — manually grant plan ──
billingRouter.post('/admin/grant', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId, planId, status, expiresAt } = req.body;
  if (!workspaceId || !planId) return res.status(400).json({ error: 'Missing workspaceId or planId' });

  // Even an admin grant must not write the subscription window directly once
  // V2 owns the workspace — the invoice is the only authority. The database
  // trigger enforces this too; this returns the structured answer.
  try {
    await assertLegacyPathAllowed(serverConfigOf(req), {
      workspaceId,
      path: 'legacy_admin_grant',
      nextAction: 'CREATE_INVOICE',
    });
  } catch (guard) {
    if (guard instanceof LegacyPathRejectedError) {
      return res.status(409).json({ error: 'BILLING_V2_REQUIRED', nextAction: guard.nextAction });
    }
    throw guard;
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase.from('workspace_subscriptions').upsert({
    workspace_id: workspaceId,
    plan_id: planId,
    provider_name: 'manual',
    status: status || 'active',
    current_period_start: new Date().toISOString(),
    current_period_end: expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id' }).select().single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'admin_grant',
  });
  res.json({ subscription: data });
});

// ─── GET /api/billing/workspaces/:workspaceId/engine ─────────────
//
// STABLE read-only billing contract (Phase D's UI consumes this shape).
// Strictly read-only: for a V2-owned workspace no GET may grant, settle or
// activate anything, so this endpoint only reports persisted financial state.
billingRouter.get('/workspaces/:workspaceId/engine', async (req, res) => {
  const workspaceId = String(req.params.workspaceId || '');
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  try {
    res.json(await buildWorkspaceBillingReadModel(serverConfigOf(req), workspaceId));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
