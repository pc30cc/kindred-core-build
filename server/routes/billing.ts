import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  resolveBillingConfig,
  resolveNamedBillingConfig,
  resolvePlatformBillingConfig,
  getProvider,
  getAllProviders,
  processWebhookEvent,
  logBillingEvent,
  checkEntitlement,
} from '../services/billing/index.js';
import {
  cardCallbackRefConflicts,
  handleCardIntentWebhook,
  hasUnappliedPayment,
  intentCurrency,
  invoiceStillCollects,
  isCardInvoiceProvider,
  isLapsedCardIntent,
  releaseIntentCollections,
  settleVerifiedCardPayment,
  type InvoiceIntent,
} from '../services/billing/cardInvoice.js';
import { resolveChargeCurrency } from '../services/billing/chargeCurrency.js';
import type { BillingProviderConfig, WebhookEvent } from '../services/billing/types.js';
import {
  claimBillingWebhookEvent,
  finalizeBillingWebhookEvent,
} from '../services/billing/index.js';
import { serviceClientFor } from '../lib/serviceClient.js';
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
  readPaymentIntent,
  isProcessingInFlight,
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
import {
  assertCurrencyAllowed,
  editionErrorResponse,
  getBillingRegion,
  getPlatformEdition,
} from '../services/billing/edition.js';
import { isProviderAllowedInEdition, isRialCurrency } from '../../shared/edition.js';
import { PADDLE_SANDBOX_PROVIDER, isTestPaymentProvider } from '../../shared/testGateways.js';
import { buildCancelAtPeriodEndPatch, decideResume } from '../services/billing/cancellation.js';
import { resolveWorkspaceAppUrl } from '../services/auth-email.js';
import { requiresReferenceBinding } from '../services/billing/providerBinding.js';
import {
  handleAccountPaymentWebhook,
  readAccountPayment,
  type AccountPaymentRow,
} from '../services/billing/account/index.js';
import {
  buildBoundVerifyParams,
  buildGatewayVerificationMarker,
  evaluateGatewayVerification,
  expectedIntentAmountIrr,
  resolveIrrPlanPrice,
} from '../services/billing/gatewayVerification.js';
import {
  applySubscriptionPayment,
  recordCustomerPayment,
} from '../services/billing/applyPayment.js';
import * as aiLedger from '../services/ai-billing/ledger.js';
import {
  buildTransactionHistory,
  type IntentRowInput,
  type PaymentRowInput,
} from '../services/billing/transactionHistory.js';
import {
  assertLegacyPathAllowed,
  auditV2,
  isV2Active,
  LegacyPathRejectedError,
} from '../services/billing/rollout.js';
import { settleAndApply } from '../services/billing/invoice/settle.js';
import { applyWalletDeposit } from '../services/billing/wallet/index.js';
import { recoverUnappliedInvoices } from '../services/billing/worker/recovery.js';
import { buildWorkspaceBillingReadModel } from '../services/billing/readModel.js';
import { isAllowedBillingCallbackUrl } from '../services/billing/callbackUrl.js';
import type { PlanDefinitionLike } from '../services/billing/entitlementFanout.js';

/** `billing_plans.prices`: currency → interval → amount. */
type PlanPrices = Record<string, Partial<Record<'monthly' | 'yearly', unknown>> | null | undefined>;

/** Intent columns written by Billing Engine V2 that `PaymentIntentRow` does not declare. */
type IntentV2Fields = {
  billing_engine_version?: string | null;
  invoice_id?: string | null;
  wallet_deposit_id?: string | null;
  expected_amount_irr?: number | string | null;
};

/** `err?.message` of an unknown thrown value (undefined when it has none). */
function errorMessageOf(err: unknown): unknown {
  return (err as { message?: unknown } | null | undefined)?.message;
}

/**
 * Customer-friendly receipt for a finalized intent. Everything here comes from
 * server state (intent + resulting payment/subscription/wallet) — the success
 * screen must never trust anything from the redirect query string.
 */
async function buildReceipt(config: ServerConfig, intent: PaymentIntentRow) {
  const supabase = getServiceClient(config);
  const { data: payment } = await supabase
    .from('billing_payments')
    .select('id, amount, currency, paid_at, provider_payment_id, plan_name_snapshot, action_type, billing_interval, created_at, reconciliation_state')
    .eq('payment_intent_id', intent.id)
    .maybeSingle();

  const receipt: Record<string, unknown> = {
    status: intent.status,
    intentId: intent.id,
    invoiceNumber: intent.invoice_number,
    // Minor units of `currency` (whole Rial for IRR).
    amountIrr: intent.amount_irr,
    currency: (payment?.currency as string | null | undefined) || intentCurrency(intent),
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
    const { data: sub, error: subError } = await supabase
      .from('workspace_subscriptions')
      .select('current_period_end, plan_id')
      .eq('workspace_id', intent.workspace_id)
      .maybeSingle();
    if (subError) throw new Error(`billing subscription read failed: ${subError.message}`);
    receipt.periodEnd = (sub?.current_period_end as string | null) || null;
    if (!receipt.planName && sub?.plan_id) {
      const { data: plan, error: planError } = await supabase
        .from('billing_plans')
        .select('name')
        .eq('id', sub.plan_id)
        .maybeSingle();
      if (planError) throw new Error(`billing plan read failed: ${planError.message}`);
      receipt.planName = (plan?.name as string | undefined) || null;
    }
  }

  return receipt;
}

/**
 * `billing_payment_intents.failure_reason` is an internal audit column and
 * can carry a raw exception message (e.g. from `noteIntentFailureAttempt`).
 * It must never reach the client verbatim over `/payment-intent/:intentId` —
 * only a short, code-shaped token passes through; anything free-text
 * collapses to a generic safe code.
 */
function safeFailureCode(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 64 || /[\s:'"]/.test(trimmed)) return 'SETTLEMENT_FAILED';
  return trimmed;
}

/**
 * Stable, safe diagnostic codes for a verify-callback failure. Never a raw
 * exception message or provider response — those can carry credentials or
 * internal details. The customer only ever sees a friendly translated
 * message; this is what a developer greps logs / the intent's
 * `failure_reason` for to know WHICH stage failed.
 */
function logBillingSafeError(input: {
  intentId: string;
  workspaceId: string;
  providerName: string;
  stage: string;
  safeErrorCode: string;
}) {
  console.error('[billing] verify-callback failure', input);
}



export const billingRouter = Router();

function getConfig(req: Request) {
  const c = serverConfigOf(req);
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

// ─── Auth / Authorization ────────────────────────────────────────
//
// Identity is derived from the first-party session cookie
// (server/lib/workspaceAuth.ts); workspace membership/role is verified
// BEFORE any service-role database access or provider request happens.

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

/** Resolves the calling user from the session cookie. Writes 401 and returns null on failure. */
async function requireUser(req: Request, res: Response): Promise<string | null> {
  return requireSessionUser(req, res);
}

type BillingAuth = { userId: string; isAdmin: boolean; role: string | null };

/**
 * Authenticates the caller and verifies they may act on `workspaceId`.
 * `manage: true` additionally requires workspace owner/admin (billing actions).
 * Never reveals whether a workspace exists to a non-member.
 */
async function authorizeWorkspace(
  req: Request,
  res: Response,
  workspaceId: unknown,
  opts: { manage?: boolean } = {},
): Promise<BillingAuth | null> {
  return authorizeWorkspaceAccess(req, res, workspaceId, opts);
}

/** Super-admin (platform) gate — `has_role(uid,'admin')` only. No fallbacks. */
async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as Request & { adminUserId?: string }).adminUserId = userId;
  next();
}

// ─── GET /api/billing/providers — list all billing providers with capabilities ──
// Only those the edition allows: no Iranian gateway in the International edition.
billingRouter.get('/providers', async (req, res) => {
  if (!(await requireUser(req, res))) return;
  try {
    res.json({ providers: getAllProviders(await getPlatformEdition(serverConfigOf(req))) });
  } catch (e: unknown) {
    sendBillingError(res, e);
  }
});

/** Edition errors (503 unknown edition, 4xx not in this edition), else 500. */
function sendBillingError(res: Response, e: unknown) {
  const editionError = editionErrorResponse(e);
  if (editionError) return res.status(editionError.status).json(editionError.body);
  return res.status(500).json({ error: errorMessageOf(e) });
}

// ─── GET /api/billing/plans — list available plans ──────────────────
billingRouter.get('/plans', async (req, res) => {
  const { url, key } = getConfig(req);
  const locale = (req.query.locale as string) || 'en';
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .eq('is_active', true)
    .eq('is_hidden', false)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  // Filter plans based on locale currency display. The Iranian edition keeps
  // its rule exactly (Persian → Rial, Turkish → Lira). Elsewhere the region
  // decides, never the language: Lira on a Turkish-only site, USD in Multi
  // Region and Global for every language, Turkish and Persian included.
  let region: Awaited<ReturnType<typeof getBillingRegion>>;
  try {
    region = await getBillingRegion(serverConfigOf(req));
  } catch (e: unknown) {
    return sendBillingError(res, e);
  }
  const edition = region.edition;
  type PlanListRow = Record<string, unknown> & {
    prices?: Record<string, unknown> | null;
    default_currency?: string | null;
  };
  const displayCurrencyOf = (plan: PlanListRow): string => {
    if (edition !== 'iran') return region.currency;
    if (locale === 'fa') return 'IRR';
    if (locale === 'tr') return 'TRY';
    return plan.default_currency || 'USD';
  };
  const plans = ((data || []) as PlanListRow[]).map((plan) => ({
    ...plan,
    displayPrice: plan.prices?.[displayCurrencyOf(plan)],
    displayCurrency: displayCurrencyOf(plan),
  }));
  res.json({ plans });
});

// ─── GET /api/billing/status/:workspaceId ────────────────────────
billingRouter.get('/status/:workspaceId', async (req, res) => {
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);

  // Lazy-flip stale trials to "expired" so downstream UI/queries see correct status.
  try { await supabase.rpc('expire_stale_trials'); } catch { /* non-fatal */ }
  // Same idea for payment attempts: a pending intent past its TTL is expired,
  // never "canceled" (the customer may simply have closed the tab).
  try { await expireStalePaymentIntents(serverConfigOf(req), workspaceId); } catch { /* non-fatal */ }

  const { data: sub, error: subError } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (subError) return res.status(500).json({ error: 'BILLING_SUBSCRIPTION_READ_FAILED' });

  let subscription: unknown = sub;
  if (sub?.plan_id) {
    const { data: plan, error: planError } = await supabase
      .from('billing_plans')
      .select('*')
      .eq('id', sub.plan_id)
      .maybeSingle();
    if (planError || !plan) return res.status(500).json({ error: 'BILLING_PLAN_READ_FAILED' });
    subscription = { ...sub, billing_plans: plan };
  }

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
  const transactions = buildTransactionHistory(
    (payments || []) as PaymentRowInput[],
    (intents || []) as IntentRowInput[],
  );

  res.json({
    subscription,
    payments: payments || [],
    attempts: ((intents || []) as Array<{ status: string }>).filter((i) => i.status !== 'succeeded'),
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
  /** Iranian gateways always price in IRR; any other value is rejected. */
  currency: z.string().optional(),
});

billingRouter.post('/invoice-preview', async (req, res) => {
  const parsed = invoicePreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const input = parsed.data;
  if (!(await authorizeWorkspace(req, res, input.workspaceId, { manage: true }))) return;

  const { url, key } = getConfig(req);
  try {
    // A Rial proforma for an Iranian gateway: the Iranian edition only.
    assertCurrencyAllowed(await getPlatformEdition(serverConfigOf(req)), 'IRR');
    const resolved = await resolveBillingConfig(url, key, input.workspaceId);
    if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });
    if (!IRAN_PROVIDERS.has(resolved.provider.name)) {
      return res.status(400).json({ error: 'INVOICE_PREVIEW_UNSUPPORTED_PROVIDER' });
    }

    // Iranian gateways charge Rial: a client-chosen currency must never pick
    // the price whose number is then charged as `amount_irr`.
    if (input.currency && input.currency.trim().toUpperCase() !== 'IRR') {
      return res.status(400).json({ error: 'CURRENCY_NOT_SUPPORTED' });
    }

    const supabase = serviceClientFor(url, key);
    const { data: plan } = await supabase
      .from('billing_plans')
      .select('id, name, prices, sort_order')
      .eq('id', input.planId)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });

    const price = resolveIrrPlanPrice(plan.prices, input.interval, input.currency);
    const amount = 'amountIrr' in price ? price.amountIrr : Number.NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'FREE_PLAN_NO_CHECKOUT' });
    }

    const { data: sub, error: subError } = await supabase
      .from('workspace_subscriptions')
      .select('plan_id, status, current_period_end')
      .eq('workspace_id', input.workspaceId)
      .maybeSingle();
    if (subError) throw new Error(`billing subscription read failed: ${subError.message}`);

    const { data: currentPlan, error: currentPlanError } = sub?.plan_id
      ? await supabase.from('billing_plans').select('sort_order').eq('id', sub.plan_id).maybeSingle()
      : { data: null, error: null };
    if (currentPlanError) throw new Error(`billing plan read failed: ${currentPlanError.message}`);

    const actionType = classifyPlanAction({
      currentPlanId: (sub?.plan_id as string | null | undefined) ?? null,
      currentPlanRank: (currentPlan?.sort_order as number | undefined) ?? null,
      currentStatus: (sub?.status as string | null | undefined) ?? null,
      nextPlanId: plan.id,
      nextPlanRank: (plan.sort_order as number | null | undefined) ?? null,
    });

    const window = computeSubscriptionWindow({
      now: new Date(),
      interval: input.interval,
      action: actionType,
      currentPeriodEnd: sub?.current_period_end ? new Date(sub.current_period_end as string) : null,
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
      workspaceNameSnapshot: (workspace?.name as string | null | undefined) ?? null,
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
        workspaceName: intent.workspace_name_snapshot || (workspace?.name as string | null | undefined) || null,
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

  } catch (e: unknown) {
    sendBillingError(res, e);
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
  /**
   * Price currency for non-Iranian providers (default USD). Iranian gateways
   * always charge IRR: the client value is ignored when absent/IRR and
   * rejected otherwise.
   */
  currency: z.string().optional(),
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
    // Rial is never charged in the International edition (and the resolver
    // below never returns an Iranian gateway there).
    const edition = await getPlatformEdition(serverConfigOf(req));
    assertCurrencyAllowed(edition, input.currency);
    const resolved = await resolveBillingConfig(url, key, input.workspaceId);
    if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });
    // The Paddle sandbox is a test gateway on the invoice engine only (see
    // billingCustomer.ts, which also keeps it to the people allowed to test).
    if (resolved.provider.name === PADDLE_SANDBOX_PROVIDER) {
      return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });
    }

    const iranProvider = IRAN_PROVIDERS.has(resolved.provider.name);
    // Iranian gateways charge the number as Rial (`amount_irr`), so the price
    // key is ALWAYS IRR — never the client's choice.
    if (iranProvider && input.currency && input.currency.trim().toUpperCase() !== 'IRR') {
      return res.status(400).json({ error: 'CURRENCY_NOT_SUPPORTED' });
    }
    // Every other gateway charges the price of the currency it is SENT: the
    // requested one when it can charge it, else its fallback (Turkish
    // gateways: TRY) — and then the plan's TRY price, never the requested
    // currency's number relabelled.
    let currency = 'IRR';
    if (!iranProvider) {
      // No currency requested: the region's (USD, or TRY on a Turkish-only
      // site); the Iranian edition keeps its USD default for card gateways.
      const defaultCurrency =
        edition === 'iran' ? 'USD' : (await getBillingRegion(serverConfigOf(req))).currency;
      const charge = resolveChargeCurrency(resolved.provider, input.currency || defaultCurrency);
      if (!charge) return res.status(400).json({ error: 'CURRENCY_NOT_SUPPORTED' });
      currency = charge.currency;
    }

    const supabase = serviceClientFor(url, key);
    const { data: plan } = await supabase
      .from('billing_plans')
      .select('id, prices')
      .eq('id', input.planId)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });
    let amount: number;
    if (iranProvider) {
      const price = resolveIrrPlanPrice(plan.prices, input.interval, currency);
      amount = 'amountIrr' in price ? price.amountIrr : Number.NaN;
    } else {
      amount = Number((plan.prices as PlanPrices | null)?.[currency]?.[input.interval]);
    }
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
    if (!isAllowedBillingCallbackUrl(req, serverConfigOf(req), input.callbackUrl)) {
      return res.status(400).json({ error: 'Invalid callbackUrl' });
    }

    let callbackUrl = input.callbackUrl;
    let intentId: string | undefined;
    let invoiceNumber: string | null = null;
    if (iranProvider) {
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
        // The stored price unit: whole Rial for IRR, minor units (cents /
        // kuruş) for every other currency. Providers convert from it.
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
        } catch (bindError: unknown) {
          await markPaymentIntentFailed(serverConfigOf(req), intentId, String(errorMessageOf(bindError) || 'binding_failed'));
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
  } catch (e: unknown) {
    sendBillingError(res, e);
  }
});

// ─── GET /api/billing/return — legacy browser return from a gateway ──
// New checkouts send the bank straight back to the app payment page. This
// endpoint only exists for sessions created before that change: it forwards
// the raw result to the exact allow-listed payment page saved at checkout and
// never leaves the browser on an API response.
billingRouter.get('/return', async (req, res) => {
  const bounce = (target: string) => res
    .status(303)
    .location(target)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target.replace(/"/g, '&quot;')}"><p>در حال بازگشت به صفحه پرداخت…</p><p><a href="${target.replace(/"/g, '&quot;')}">ادامه</a></p>`);

  try {
    const intentId = typeof req.query.intent === 'string' ? req.query.intent : '';
    const providerName = typeof req.query.provider === 'string' ? req.query.provider : '';
    if (!intentId || !providerName) return res.status(400).type('html').send('<p>درخواست بازگشت پرداخت نامعتبر است.</p>');

    const intent = await getPaymentIntent(serverConfigOf(req), intentId);
    const storedReturn = typeof intent?.metadata?.return_url === 'string'
      ? intent.metadata.return_url
      : '';
    if (!intent || intent.provider_name !== providerName || !storedReturn) {
      return res.status(400).type('html').send('<p>درخواست بازگشت پرداخت نامعتبر است.</p>');
    }

    const destination = new URL(storedReturn);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'intent' || key === 'provider') continue;
      if (typeof value === 'string') destination.searchParams.set(key, value);
    }
    destination.searchParams.set('intent', intent.id);
    destination.searchParams.set('provider', intent.provider_name);
    return bounce(destination.toString());
  } catch {
    return res.status(502).type('html').send('<p>بازگشت از درگاه موقتاً در دسترس نیست.</p>');
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
  // A card gateway confirmed only by its webhook (Lemon Squeezy) has no
  // lookup API; its return is answered from the intent's own state.
  if (!provider || (!provider.verifyPayment && !isCardInvoiceProvider(providerName))) {
    return res.status(400).json({ error: 'Provider does not support payment verification' });
  }

  try {
    // Use the same workspace/global resolution chain as checkout. Reading only
    // provider_configs here broke verification for platform-default gateways.
    const resolved = await resolveNamedBillingConfig(url, key, workspaceId, providerName);
    if (!resolved || resolved.provider.name !== providerName) {
      logBillingSafeError({
        intentId: typeof intentId === 'string' ? intentId : '',
        workspaceId,
        providerName,
        stage: 'provider_resolution',
        safeErrorCode: 'PROVIDER_NOT_CONFIGURED',
      });
      return res.status(400).json({ error: 'PROVIDER_NOT_CONFIGURED' });
    }

    if (isCardInvoiceProvider(providerName)) {
      return await verifyCardCallback(serverConfigOf(req), res, {
        workspaceId,
        providerName,
        config: resolved.config,
        params,
        intentId,
      });
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
        await releaseIntentCollections(cfg, intent.id, `intent_${intent.status}`);
        return res.json({ success: true, verified: false, status: intent.status });
      }
      if (intent.status === 'pending' && !isIntentUsable(intent)) {
        await markPaymentIntentExpired(cfg, intent.id);
        await releaseIntentCollections(cfg, intent.id, 'intent_expired');
        logBillingSafeError({
          intentId: intent.id, workspaceId, providerName,
          stage: 'intent_lifecycle', safeErrorCode: 'INTENT_EXPIRED',
        });
        return res.status(400).json({ error: 'INTENT_EXPIRED' });
      }

      // Identity binding — the callback must carry the same provider
      // reference the checkout session produced for THIS intent.
      const binding = providerRefMatchesIntent(intent, params);
      if (binding.ok === false) {
        await markPaymentIntentFailed(cfg, intent.id, binding.reason);
        await releaseIntentCollections(cfg, intent.id, 'reference_mismatch');
        logBillingSafeError({
          intentId: intent.id, workspaceId, providerName,
          stage: 'reference_binding', safeErrorCode: 'REFERENCE_MISMATCH',
        });
        return res.status(400).json({ error: 'REFERENCE_MISMATCH' });
      }

      const intentV2 = intent as PaymentIntentRow & IntentV2Fields;
      const expectedAmountIrr = expectedIntentAmountIrr(intentV2);

      // Ask the gateway about EXACTLY the transaction bound to this intent:
      // every reference key is the stored `provider_ref` (never a value taken
      // from the callback query) and the amount is the server amount.
      const result = await provider.verifyPayment(
        resolved.config,
        buildBoundVerifyParams(intent, params, expectedAmountIrr),
      );
      if (!result.verified) {
        await markPaymentIntentFailed(cfg, intent.id, 'gateway_not_verified');
        await releaseIntentCollections(cfg, intent.id, 'gateway_not_verified');
        logBillingSafeError({
          intentId: intent.id, workspaceId, providerName,
          stage: 'gateway_verify',
          safeErrorCode: result.status === 'canceled' ? 'GATEWAY_CANCELED' : 'GATEWAY_NOT_VERIFIED',
        });
        return res.json({ success: true, ...result });
      }

      // The gateway said "verified" — now prove it is THIS intent's money:
      // the gateway-confirmed amount must equal the expected amount, and an
      // "already verified" answer is only accepted for an intent that itself
      // already passed verification (idempotent re-callback).
      const decision = evaluateGatewayVerification(intentV2, result);
      if ('reason' in decision) {
        if (decision.reason === 'gateway_already_verified_unbound' ||
            decision.reason === 'gateway_already_verified_reference_mismatch') {
          // Never finalize; leave the intent untouched for reconciliation.
          logBillingSafeError({
            intentId: intent.id, workspaceId, providerName,
            stage: 'gateway_verify', safeErrorCode: 'GATEWAY_ALREADY_VERIFIED_UNBOUND',
          });
          return res.status(409).json({ error: 'PAYMENT_ALREADY_VERIFIED' });
        }
        await markPaymentIntentFailed(cfg, intent.id, decision.reason);
        await releaseIntentCollections(cfg, intent.id, decision.reason);
        logBillingSafeError({
          intentId: intent.id, workspaceId, providerName,
          stage: 'gateway_verify', safeErrorCode: 'GATEWAY_AMOUNT_MISMATCH',
        });
        return res.status(400).json({ error: 'PAYMENT_AMOUNT_MISMATCH' });
      }
      const confirmedAmountIrr = decision.confirmedAmountIrr;

      // pending → processing (or resume a crashed finalization). The claim
      // records the verification so a later "already verified" answer can be
      // tied back to this intent.
      const claim = await claimIntentForProcessing(cfg, intent.id, {
        verification: buildGatewayVerificationMarker(
          result.providerRef || null,
          confirmedAmountIrr,
        ),
        baseMetadata: intent.metadata,
      });
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
      const intentEngine = intentV2.billing_engine_version === 'v2' ? 'v2' : 'v1';
      const invoiceId = intentV2.invoice_id;
      const walletDepositId = intentV2.wallet_deposit_id;

      // ── Wallet deposit ──────────────────────────────────────────────────
      // A deposit buys no service, so it has no invoice and no entitlement
      // effect: it only converts verified gateway money into wallet balance.
      // It is therefore handled BEFORE the engine routing below and is valid
      // under both engines — the wallet is the one purchase V2 does not make
      // invoice-driven.
      if (intent.purchase_type === 'wallet_deposit' && walletDepositId) {
        try {
          const payment = await recordCustomerPayment(cfg, {
            workspaceId,
            providerName,
            providerPaymentId: providerRef,
            paymentIntentId: intent.id,
            invoiceNumber: intent.invoice_number,
            amount: confirmedAmountIrr,
            currency: 'IRR',
            purchaseType: 'wallet_deposit',
            actionType: 'wallet_deposit',
            metadata: { intentId: intent.id, providerRef, depositId: walletDepositId },
          });
          // Idempotent per deposit: a replayed callback credits nothing twice.
          await applyWalletDeposit(cfg, {
            depositId: walletDepositId,
            amountIrr: confirmedAmountIrr,
            paymentId: payment.id,
          });
        } catch (depositError: unknown) {
          await noteIntentFailureAttempt(cfg, intent, String(errorMessageOf(depositError) || depositError));
          logBillingSafeError({
            intentId: intent.id, workspaceId, providerName,
            stage: 'wallet_deposit_finalization', safeErrorCode: 'FINALIZATION_PENDING',
          });
          // The gateway HAS verified this money. A finalization hiccup must
          // never be reported to the customer as "failed" — stay recoverable.
          return res.status(202).json({ success: true, verified: true, pending: true });
        }
        await markIntentSucceeded(cfg, intent.id);
        const doneIntent = await getPaymentIntent(cfg, intent.id);
        return res.json({
          success: true,
          ...result,
          receipt: doneIntent ? await buildReceipt(cfg, doneIntent) : undefined,
        });
      }

      if (intentEngine === 'v1' && (await isV2Active(cfg, workspaceId))) {
        const parked = await recordCustomerPayment(cfg, {
          workspaceId,
          providerName,
          providerPaymentId: providerRef,
          paymentIntentId: intent.id,
          invoiceNumber: intent.invoice_number,
          amount: confirmedAmountIrr,
          currency: 'IRR',
          purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
          actionType: intent.action_type || 'plan_new',
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
            amount: confirmedAmountIrr,
            currency: 'IRR',
            purchaseType: intent.purchase_type === 'ai_credit_topup' ? 'ai_credit_topup' : 'subscription',
            actionType: intent.action_type || 'plan_new',
            metadata: { intentId: intent.id, providerRef, invoiceId },
          });
          await settleAndApply(cfg, {
            invoiceId,
            paymentId: payment.id as string,
            amountIrr: confirmedAmountIrr,
            commandKey: `intent:${intent.id}`,
          });
        } else if (intent.purchase_type === 'ai_credit_topup') {
          await aiLedger.purchaseCredit(cfg, {
            workspaceId,
            amount: String(confirmedAmountIrr),
            commandKey: `intent:${intent.id}`,
            reason: 'ai_credit_topup',
          });
          await recordCustomerPayment(cfg, {
            workspaceId,
            providerName,
            providerPaymentId: providerRef,
            paymentIntentId: intent.id,
            invoiceNumber: intent.invoice_number,
            amount: confirmedAmountIrr,
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
            amount: confirmedAmountIrr,
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
            amount: confirmedAmountIrr,
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
            amount: confirmedAmountIrr,
            currency: 'IRR',
            status: 'success',
            metadata: { intentId: intent.id, actionType: applied.actionType },
          });
        }
      } catch (sideEffectError: unknown) {
        // The customer HAS paid. Keep the intent recoverable and tell the UI
        // this is pending, never "failed" — a retry finishes the job.
        await noteIntentFailureAttempt(cfg, intent, String(errorMessageOf(sideEffectError) || sideEffectError));
        logBillingSafeError({
          intentId: intent.id, workspaceId, providerName,
          stage: 'finalization', safeErrorCode: 'FINALIZATION_PENDING',
        });
        return res.status(202).json({ success: true, verified: true, pending: true });
      }

      await markIntentSucceeded(cfg, intent.id);
      await releaseIntentCollections(cfg, intent.id, 'payment_completed');
      const finalIntent = await getPaymentIntent(cfg, intent.id);
      return res.json({
        success: true,
        ...result,
        receipt: finalIntent ? await buildReceipt(cfg, finalIntent) : undefined,
      });
    }

    // Every checkout creates a payment intent bound to an invoice; a provider
    // outside both branches above has no verified road to a subscription. (A
    // "verified" answer used to be written straight onto the subscription,
    // which the invoice engine forbids.)
    return res.status(400).json({ error: 'PROVIDER_NOT_SUPPORTED' });
  } catch (e: unknown) {
    sendBillingError(res, e);
  }
});

/**
 * The customer's return from a card gateway (Stripe, PayPal, Paddle, Lemon
 * Squeezy) for an invoice payment intent.
 *
 * The return URL proves nothing: the payment is confirmed by asking the
 * provider about the checkout STORED on the intent (its `verifyPayment`), and
 * the amount and currency it reports must equal the invoice's. A "not paid
 * yet" answer leaves the intent alone — the customer may still be paying, and
 * the provider's webhook settles a payment that completes later. Only a
 * definitive cancel / failure / expiry ends the attempt.
 *
 * An attempt that stopped collecting can still have been paid: a superseded
 * or expired checkout is looked up as well where the lookup only READS
 * (Stripe, Paddle), and its money settles the invoice while the invoice still
 * owes exactly that (settleVerifiedCardPayment). A provider whose lookup
 * TAKES the money (PayPal captures the approved order) is asked only for a
 * live attempt — before its deadline, for an invoice that still owes exactly
 * its amount; otherwise nothing is captured and the order lapses at PayPal.
 * Money already recorded for review is reported as under review, never as a
 * failed payment.
 */
async function verifyCardCallback(
  cfg: ServerConfig,
  res: Response,
  input: {
    workspaceId: string;
    providerName: string;
    config: BillingProviderConfig;
    params: unknown;
    intentId: unknown;
  },
) {
  const { workspaceId, providerName } = input;
  const provider = getProvider(providerName);
  if (typeof input.intentId !== 'string' || !input.intentId) {
    return res.status(400).json({ error: 'Missing intentId' });
  }
  const intent = (await getPaymentIntent(cfg, input.intentId)) as InvoiceIntent | null;
  if (!intent || intent.workspace_id !== workspaceId || intent.provider_name !== providerName || !intent.invoice_id) {
    return res.status(400).json({ error: 'Invalid payment intent' });
  }

  if (intent.status === 'succeeded') {
    return res.json({ success: true, verified: true, duplicate: true, receipt: await buildReceipt(cfg, intent) });
  }
  // A finalization claimed moments ago may still be running. One claimed
  // longer ago than PROCESSING_RECLAIM_MS crashed: it is looked up again and
  // settleVerifiedCardPayment re-claims it (claimIntentForProcessing), so the
  // customer's return finishes it instead of waiting for a webhook that may
  // never come.
  if (isProcessingInFlight(intent)) {
    return res.json({ success: true, verified: true, pending: true });
  }
  const stalledProcessing = intent.status === 'processing';
  const lapsed = isLapsedCardIntent(intent);
  if (intent.status !== 'pending' && !stalledProcessing) {
    if (await hasUnappliedPayment(cfg, intent)) {
      return res.status(409).json({ error: 'PAYMENT_UNDER_REVIEW' });
    }
    if (!lapsed || !provider?.verifyPayment || provider.verifyPaymentCaptures) {
      return res.json({ success: true, verified: false, status: intent.status });
    }
  }

  // A return naming another checkout than the one bound to this intent is
  // refused without touching the intent (its real payment may still arrive).
  if (cardCallbackRefConflicts(intent, input.params)) {
    logBillingSafeError({
      intentId: intent.id, workspaceId, providerName,
      stage: 'reference_binding', safeErrorCode: 'REFERENCE_MISMATCH',
    });
    return res.status(400).json({ error: 'REFERENCE_MISMATCH' });
  }

  // Webhook-confirmed gateway: nothing to look up — the screen polls the intent.
  if (!provider?.verifyPayment) return res.json({ success: true, verified: false, pending: true });

  // A stalled finalization already holds the provider's confirmation (its
  // money was taken before the claim): the lookup only reads it back, so the
  // checks guarding a capture do not apply to it.
  if (provider.verifyPaymentCaptures && !stalledProcessing) {
    if (!isIntentUsable(intent)) {
      await markPaymentIntentExpired(cfg, intent.id);
      await releaseIntentCollections(cfg, intent.id, 'intent_expired');
      logBillingSafeError({
        intentId: intent.id, workspaceId, providerName,
        stage: 'intent_lifecycle', safeErrorCode: 'INTENT_EXPIRED',
      });
      return res.json({ success: true, verified: false, status: 'expired' });
    }
    if (!(await invoiceStillCollects(cfg, intent))) {
      await markPaymentIntentFailed(cfg, intent.id, 'invoice_not_payable');
      await releaseIntentCollections(cfg, intent.id, 'invoice_not_payable');
      logBillingSafeError({
        intentId: intent.id, workspaceId, providerName,
        stage: 'intent_lifecycle', safeErrorCode: 'INVOICE_NOT_PAYABLE',
      });
      return res.status(409).json({ error: 'INVOICE_NOT_PAYABLE' });
    }
  }

  const result = await provider.verifyPayment(
    input.config,
    buildBoundVerifyParams(intent, input.params, expectedIntentAmountIrr(intent)),
  );
  if (!result.verified) {
    // A lapsed attempt's checkout is not paid: nothing to end, it already ended.
    if (lapsed) return res.json({ success: true, verified: false, status: intent.status });
    // A stalled finalization was verified before it was claimed; a lookup
    // that does not confirm it now never fails it — it stays recoverable.
    if (stalledProcessing) return res.json({ success: true, verified: true, pending: true });
    const status = result.status || 'pending';
    if (status === 'canceled' || status === 'failed' || status === 'expired') {
      await markPaymentIntentFailed(cfg, intent.id, `gateway_${status}`);
      await releaseIntentCollections(cfg, intent.id, `gateway_${status}`);
      logBillingSafeError({
        intentId: intent.id, workspaceId, providerName,
        stage: 'gateway_verify', safeErrorCode: status === 'canceled' ? 'GATEWAY_CANCELED' : 'GATEWAY_NOT_VERIFIED',
      });
      return res.json({ success: true, verified: false, status });
    }
    return res.json({ success: true, verified: false, pending: true });
  }

  const settlement = await settleVerifiedCardPayment(cfg, {
    intent,
    providerName,
    providerRef: result.providerRef || intent.provider_ref,
    paymentId: result.paymentId,
    amount: result.amount,
    currency: result.currency,
  });
  switch (settlement.outcome) {
    case 'succeeded':
    case 'duplicate': {
      const finalIntent = await getPaymentIntent(cfg, intent.id);
      return res.json({
        success: true,
        verified: true,
        providerRef: result.providerRef,
        receipt: finalIntent ? await buildReceipt(cfg, finalIntent) : undefined,
      });
    }
    case 'in_flight':
      return res.json({ success: true, verified: true, pending: true });
    case 'pending':
      logBillingSafeError({
        intentId: intent.id, workspaceId, providerName,
        stage: 'finalization', safeErrorCode: 'FINALIZATION_PENDING',
      });
      return res.status(202).json({ success: true, verified: true, pending: true });
    default:
      // Money arrived but cannot settle this invoice: recorded for review.
      logBillingSafeError({
        intentId: intent.id, workspaceId, providerName,
        stage: 'settlement', safeErrorCode: 'PAYMENT_UNDER_REVIEW',
      });
      return res.status(409).json({ error: 'PAYMENT_UNDER_REVIEW' });
  }
}

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

/**
 * Providers whose webhook is verified cryptographically: a signature over the
 * raw body (Stripe, Paddle, Lemon Squeezy, PayTR) or PayPal's own
 * verify-webhook-signature API against the configured webhook id. The Paddle
 * sandbox has its own endpoint (`/paddle_sandbox`) and its own secret.
 */
const SIGNED_WEBHOOK_PROVIDERS = new Set(['stripe', 'paddle', 'paddle_sandbox', 'lemon_squeezy', 'paytr', 'paypal']);

/**
 * The workspace a verified platform-level event belongs to when its payload
 * names none: the payment intent it names (custom metadata), or the payment
 * it refers to. Both are this server's own records, reached through
 * identifiers inside a payload whose signature already verified.
 * `foreignIntent`: the event names an intent this database does not have.
 * Throws when a read fails: "not found" is only ever concluded from an
 * answer, never from an error.
 */
async function resolveEventWorkspace(
  cfg: ServerConfig,
  providerName: string,
  event: WebhookEvent,
): Promise<{ workspaceId: string | null; foreignIntent: boolean }> {
  let foreignIntent = false;
  if (event.intentId) {
    const intent = await readPaymentIntent(cfg, event.intentId);
    if (intent && intent.provider_name === providerName) return { workspaceId: intent.workspace_id, foreignIntent };
    foreignIntent = !intent;
  }
  if (event.providerPaymentId) {
    const { data, error } = await getServiceClient(cfg)
      .from('billing_payments')
      .select('workspace_id')
      .eq('provider_name', providerName)
      .eq('provider_payment_id', event.providerPaymentId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`billing payment read failed: ${error.message}`);
    const ws = (data as { workspace_id?: string | null } | null)?.workspace_id;
    if (ws) return { workspaceId: ws, foreignIntent: false };
  }
  return { workspaceId: null, foreignIntent };
}

/**
 * An event for a payment intent this database has never had: a provider
 * account shared with another installation (another copy of this platform
 * on the same Stripe / PayPal account) receives its events too. It is
 * acknowledged — refusing it would only make the provider retry it, and
 * eventually disable the endpoint — and nothing is recorded.
 */
function logForeignIntentEvent(providerName: string, event: WebhookEvent) {
  console.warn(`[billing-webhook] ignored provider=${providerName} reason=unknown_intent intent=${event.intentId} event=${event.providerEventId}`);
}

type WebhookCandidate = { workspaceId: string | null; config: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Generic ops log — never includes body, headers, secrets or signatures. */
function logWebhookRejection(providerName: string, category: string) {
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

  const supabase = serviceClientFor(url, key);
  const cfg = serverConfigOf(req);
  // PayTR re-sends a notification until the body is exactly its expected text.
  const acknowledge = (body: Record<string, unknown>) =>
    provider.webhookAckBody ? res.type('text/plain').send(provider.webhookAckBody) : res.json(body);

  // Candidate configs: each workspace-scoped config, plus the platform-wide
  // one. Verification is attempted against each; only the config whose secret
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
  // The platform-wide credentials: the Providers screen's canonical store
  // (billing_provider_credentials) over the legacy layers. Reading only the
  // default-provider pointer missed every secret saved there — and every
  // provider that is enabled but not the default.
  try {
    const platformConfig = await resolvePlatformBillingConfig(url, key, providerName);
    if (platformConfig) candidates.push({ workspaceId: null, config: platformConfig });
  } catch {
    logWebhookRejection(providerName, 'config_read_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  // Evaluate EVERY candidate: stopping at the first verifying config would
  // hide an ambiguous secret collision between two workspaces, and stopping at
  // the first workspace mismatch would drop a later, correct candidate.
  const accepted: Array<{ event: WebhookEvent; workspaceId: string }> = [];
  let sawMismatch = false;
  let sawUnresolved = false;
  let sawIgnored = false;
  let foreignEvent: WebhookEvent | null = null;

  for (const candidate of candidates) {
    let event: WebhookEvent | null;
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
    // Genuine, but nothing to act on: acknowledged so the provider stops retrying.
    if (event.type === 'ignored') {
      sawIgnored = true;
      continue;
    }

    // Workspace binding: pin to the workspace that owns the verifying config.
    if (candidate.workspaceId) {
      if (event.workspaceId && event.workspaceId !== candidate.workspaceId) {
        sawMismatch = true;
        continue;
      }
      accepted.push({ event, workspaceId: candidate.workspaceId });
      continue;
    }
    if (typeof event.workspaceId === 'string' && event.workspaceId) {
      accepted.push({ event, workspaceId: event.workspaceId });
      continue;
    }
    let resolvedWorkspace: Awaited<ReturnType<typeof resolveEventWorkspace>>;
    try {
      resolvedWorkspace = await resolveEventWorkspace(cfg, providerName, event);
    } catch {
      // Whose event this is cannot be known right now: answered 5xx so the
      // provider retries, never acknowledged as someone else's.
      logWebhookRejection(providerName, 'intent_read_failed');
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
    if (resolvedWorkspace.workspaceId) accepted.push({ event, workspaceId: resolvedWorkspace.workspaceId });
    else if (resolvedWorkspace.foreignIntent) foreignEvent = event;
    else sawUnresolved = true;
  }

  if (accepted.length > 1) {
    logWebhookRejection(providerName, 'ambiguous_candidate_configs');
    return res.status(400).json({ error: 'Webhook rejected' });
  }
  if (accepted.length === 0) {
    if ((sawIgnored || foreignEvent) && !sawMismatch && !sawUnresolved) {
      if (foreignEvent) logForeignIntentEvent(providerName, foreignEvent);
      return acknowledge({ received: true, ignored: true });
    }
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

  // Simple billing: a payment of a workspace account. Its id travels in the
  // provider's signed custom metadata where an invoice checkout's intent id
  // does, so it is looked up first; an id that is not an account payment
  // falls through to the invoice path below.
  if (event.intentId) {
    let accountPayment: AccountPaymentRow | null = null;
    try {
      accountPayment = await readAccountPayment(cfg, event.intentId);
    } catch {
      logWebhookRejection(providerName, 'account_payment_read_failed');
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
    if (accountPayment) {
      if (accountPayment.workspace_id !== workspaceId || accountPayment.provider !== providerName) {
        logWebhookRejection(providerName, 'account_payment_mismatch');
        return res.status(400).json({ error: 'Webhook rejected' });
      }
      let accountClaim;
      try {
        accountClaim = await claimBillingWebhookEvent(url, key, {
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
      if (!accountClaim.claimed) {
        if ('inFlight' in accountClaim) return res.status(409).json({ error: 'Webhook already in progress' });
        return acknowledge({ received: true, duplicate: true });
      }
      try {
        await handleAccountPaymentWebhook(cfg, { providerName, workspaceId, event, payment: accountPayment });
      } catch {
        await finalizeBillingWebhookEvent(url, key, accountClaim.eventRowId, 'failed').catch(() => {});
        logWebhookRejection(providerName, 'account_payment_processing_failed');
        return res.status(500).json({ error: 'Webhook processing failed' });
      }
      await finalizeBillingWebhookEvent(url, key, accountClaim.eventRowId, 'success').catch(() => {});
      return acknowledge({ received: true });
    }
  }

  // An event naming a payment intent settles THAT intent's invoice — and only
  // when the intent is this provider's invoice attempt in this workspace.
  let intent: InvoiceIntent | null = null;
  if (event.intentId) {
    try {
      intent = (await readPaymentIntent(cfg, event.intentId)) as InvoiceIntent | null;
    } catch {
      // A failed read is not an unknown intent: acknowledging it would lose
      // the payment. The provider retries a 5xx.
      logWebhookRejection(providerName, 'intent_read_failed');
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
    if (!intent) {
      logForeignIntentEvent(providerName, event);
      return acknowledge({ received: true, ignored: true });
    }
    if (intent.workspace_id !== workspaceId || intent.provider_name !== providerName || !intent.invoice_id) {
      logWebhookRejection(providerName, 'intent_mismatch');
      return res.status(400).json({ error: 'Webhook rejected' });
    }
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

  if (!claim.claimed) {
    // Another delivery of this event is being processed right now. Not an
    // acknowledgement: if that attempt dies, only a later retry can finish
    // the event (claimBillingWebhookEvent re-claims a stale row).
    if ('inFlight' in claim) return res.status(409).json({ error: 'Webhook already in progress' });
    return acknowledge({ received: true, duplicate: true });
  }

  try {
    if (intent) await handleCardIntentWebhook(cfg, providerName, event, intent);
    else await processWebhookEvent(url, key, providerName, event, { alreadyClaimed: true });
  } catch {
    // Marked failed, so the provider's retry is processed again (see
    // claimBillingWebhookEvent); every step behind it is idempotent.
    await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'failed').catch(() => {});
    logWebhookRejection(providerName, 'processing_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'success').catch(() => {});
  return acknowledge({ received: true });
});

// ─── GET /api/billing/payment-intent/:intentId — status polling ──
//
// The success/failure screen polls this instead of guessing from the redirect
// query string, so a callback that arrived while finalization was still
// `processing` resolves to the real outcome a moment later.
billingRouter.get('/payment-intent/:intentId', async (req, res) => {
  const cfg = serverConfigOf(req);
  let intent = await getPaymentIntent(cfg, req.params.intentId);
  if (!intent) return res.status(404).json({ error: 'Not found' });
  if (!(await authorizeWorkspace(req, res, intent.workspace_id, { manage: true }))) return;

  // Polling is also an immediate recovery signal. A verified invoice payment
  // should not wait for the periodic scheduler before its effect is applied.
  if (intent.status === 'processing' && (intent as PaymentIntentRow & { invoice_id?: string | null }).invoice_id) {
    await recoverUnappliedInvoices(cfg, 25).catch(() => {});
    intent = (await getPaymentIntent(cfg, req.params.intentId)) ?? intent;
  }

  // An attempt whose money was recorded for review did not fail: the screen
  // must say so (also after a reload), not "payment failed".
  const ended = intent.status === 'failed' || intent.status === 'canceled' || intent.status === 'expired';
  const underReview = ended && (await hasUnappliedPayment(cfg, intent).catch(() => false));

  return res.json({
    status: intent.status,
    pending: intent.status === 'pending' || intent.status === 'processing',
    receipt: intent.status === 'succeeded' ? await buildReceipt(cfg, intent) : null,
    failureReason: underReview ? 'PAYMENT_UNDER_REVIEW' : safeFailureCode(intent.failure_reason),
  });
});


// ─── POST /api/billing/subscription/cancel ───────────────────────
billingRouter.post('/subscription/cancel', async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = serviceClientFor(url, key);
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
      // Cancel at period end: the paid remainder stays usable (status is kept
      // active/trialing); the billing tick flips it to 'canceled' once
      // current_period_end has passed. See services/billing/cancellation.ts.
      await supabase.from('workspace_subscriptions')
        .update(buildCancelAtPeriodEndPatch(sub))
        .eq('workspace_id', workspaceId);
    }
    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: errorMessageOf(e) });
  }
});

// ─── POST /api/billing/subscription/resume ───────────────────────
billingRouter.post('/subscription/resume', async (req, res) => {
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = serviceClientFor(url, key);
  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub?.provider_subscription_id) return res.status(400).json({ error: 'No subscription found' });

  // Only a still-running paid period can be resumed. Once it has ended the
  // subscription is over and a new (paid) one must be started instead.
  const decision = decideResume(sub);
  if (decision.ok === false) {
    // (explicit narrowing: this project compiles without strictNullChecks)
    const refused = decision as Extract<typeof decision, { ok: false }>;
    return res.status(409).json({ error: refused.message, code: refused.code });
  }

  const provider = getProvider(sub.provider_name);
  if (!provider?.resumeSubscription) return res.status(400).json({ error: 'Provider does not support resume' });

  const resolved = await resolveBillingConfig(url, key, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing config found' });

  try {
    const result = await provider.resumeSubscription(resolved.config, sub.provider_subscription_id);
    if (result.success) {
      await supabase.from('workspace_subscriptions')
        .update(decision.patch)
        .eq('workspace_id', workspaceId);
      if (decision.statusChanged) {
        await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
          workspaceId,
          source: 'subscription_renewed',
        });
      }
    }
    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: errorMessageOf(e) });
  }
});

// ─── POST /api/billing/portal — customer portal URL ─────────────
billingRouter.post('/portal', async (req, res) => {
  const { workspaceId, returnUrl } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  if (!(await authorizeWorkspace(req, res, workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);

  const supabase = serviceClientFor(url, key);
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
    const result = await provider.getPortalUrl(resolved.config, sub.provider_customer_id, returnUrl || (await resolveWorkspaceAppUrl(serverConfigOf(req), workspaceId, '/billing')));
    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: errorMessageOf(e) });
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
    // Super Admin → Billing → Test sends no credentials: it tests what is
    // STORED for the provider. Values sent in the request (an unsaved form)
    // override the stored ones for this one test.
    const { url, key } = getConfig(req);
    const stored = (await resolvePlatformBillingConfig(url, key, providerName)) || {};
    const supplied = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const result = await provider.testConnection({ ...stored, ...supplied, provider: providerName });
    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: errorMessageOf(e) });
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
  } catch (e: unknown) {
    res.status(500).json({ error: errorMessageOf(e) });
  }
});

// ─── GET /api/billing/events/:workspaceId — billing event history ──
billingRouter.get('/events/:workspaceId', async (req, res) => {
  if (!(await authorizeWorkspace(req, res, req.params.workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
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
  const supabase = serviceClientFor(url, key);

  const [subs, payments, events, plans] = await Promise.all([
    supabase.from('workspace_subscriptions').select('*', { count: 'exact' }),
    supabase.from('billing_payments').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('billing_events').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('billing_plans').select('*').order('sort_order'),
  ]);

  const activeSubs = ((subs.data || []) as Array<{ status: string }>).filter((s) => s.status === 'active' || s.status === 'trialing');

  // The International edition shows no Rial money and no Iranian gateway
  // activity (e.g. history cloned from an Iranian deployment).
  let edition: Awaited<ReturnType<typeof getPlatformEdition>>;
  try {
    edition = await getPlatformEdition(serverConfigOf(req));
  } catch (e: unknown) {
    return sendBillingError(res, e);
  }
  type MoneyRow = { currency?: unknown; provider_name?: unknown };
  const shown = (rows: unknown[] | null) =>
    ((rows || []) as MoneyRow[]).filter(
      (r) =>
        edition === 'iran' ||
        (!isRialCurrency(r.currency) && isProviderAllowedInEdition(String(r.provider_name || ''), edition)),
    );

  res.json({
    totalSubscriptions: subs.count || 0,
    activeSubscriptions: activeSubs.length,
    recentPayments: edition === 'iran' ? payments.data || [] : shown(payments.data),
    recentEvents: edition === 'iran' ? events.data || [] : shown(events.data),
    plans: plans.data || [],
  });
});


// ─── Admin: GET /api/billing/admin/finance-report — platform financial report ──
// Aggregations are computed server-side from the two financial sources of
// truth: billing_payments (settled money) and billing_payment_intents
// (attempts). No client-side guessing of revenue.
/** Columns of `billing_payments` the finance report reads (rows are passed through whole). */
type FinancePaymentRow = Record<string, unknown> & {
  status: string;
  amount: number | string | null;
  refund_amount?: number | string | null;
  paid_at: string | null;
  created_at: string;
  action_type: string | null;
  purchase_type: string | null;
  provider_name: string | null;
  plan_name_snapshot: string | null;
  plan_id: string | null;
  workspace_id: string | null;
};
interface FinancePlanRow {
  id: string;
  name: string;
  slug: string | null;
  prices: PlanPrices | null;
  is_free: boolean | null;
}
interface FinanceWorkspaceRow {
  id: string;
  name: string | null;
  slug: string | null;
}
interface FinanceSubscriptionRow {
  workspace_id: string;
  plan_id: string | null;
  status: string;
  billing_interval: string | null;
}

billingRouter.get('/admin/finance-report', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  // The Iranian edition reports exactly as before (Rial). The International
  // edition reports in USD only: its MRR comes from the USD plan prices and
  // its totals from USD money; any Rial history (e.g. data cloned from an
  // Iranian deployment) is left out, never summed into dollars.
  let edition: Awaited<ReturnType<typeof getPlatformEdition>>;
  let reportCurrency: string;
  try {
    // Iran: IRR. Turkish-only site: TRY. Multi Region / Global: USD.
    ({ edition, currency: reportCurrency } = await getBillingRegion(serverConfigOf(req)));
  } catch (e: unknown) {
    return sendBillingError(res, e);
  }
  const international = edition !== 'iran';
  const inReportCurrency = (code: unknown) =>
    String(code || (international ? '' : 'IRR')).trim().toUpperCase() === reportCurrency;

  const months = Math.min(Math.max(parseInt(String(req.query.months ?? '6'), 10) || 6, 1), 24);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - (months - 1), 1);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const [payments, intents, subs, plans, workspaces] = await Promise.all([
    supabase.from('billing_payments').select('*').gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(5000),
    // `metadata` carries an attempt's currency (read in the International edition only).
    supabase.from('billing_payment_intents').select('id, status, purchase_type, action_type, amount_irr, provider_name, created_at, workspace_id, metadata').gte('created_at', sinceIso).limit(5000),
    supabase.from('workspace_subscriptions').select('workspace_id, plan_id, status, billing_interval'),
    supabase.from('billing_plans').select('id, name, slug, prices, is_free'),
    supabase.from('workspaces').select('id, name, slug').limit(2000),
  ]);

  const paymentRows = ((payments.data || []) as FinancePaymentRow[]).filter(
    (p) => !international || inReportCurrency(p.currency),
  );
  const paid = paymentRows.filter((p) => p.status === 'succeeded' || p.status === 'refunded' || p.status === 'partially_refunded');
  const planById = new Map(((plans.data || []) as FinancePlanRow[]).map((p) => [p.id, p]));
  const workspaceById = new Map(((workspaces.data || []) as FinanceWorkspaceRow[]).map((w) => [w.id, w]));

  const monthKeys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i, 1);
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  const seriesMap = new Map(monthKeys.map((m) => [m, { month: m, revenue: 0, count: 0, subscription: 0, topup: 0, refunded: 0 }]));

  // A test gateway's money (sandbox / simulator, see shared/testGateways.ts)
  // stays in the totals as before, and is marked: `test` on its provider row
  // and on each payment, and summed in `totals.testRevenue`.
  const byProvider = new Map<string, { provider: string; revenue: number; count: number; test: boolean }>();
  const byPlan = new Map<string, { plan: string; revenue: number; count: number }>();
  const byWorkspace = new Map<string, { workspaceId: string; name: string; revenue: number; count: number }>();

  let grossRevenue = 0;
  let refundTotal = 0;
  let testRevenue = 0;

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
    const test = isTestPaymentProvider(provider);
    if (test) testRevenue += amount;
    const prov = byProvider.get(provider) || { provider, revenue: 0, count: 0, test };
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

  // An attempt's currency lives in its metadata (the intent has no column).
  const intentRows = ((intents.data || []) as Array<{ status: string; metadata?: { currency?: unknown } | null }>).filter(
    (i) => !international || inReportCurrency(i.metadata?.currency),
  );
  const byStatus = new Map<string, number>();
  for (const i of intentRows) byStatus.set(i.status, (byStatus.get(i.status) || 0) + 1);
  const attempts = intentRows.length;
  const succeeded = byStatus.get('succeeded') || 0;

  // Recurring revenue snapshot from ACTIVE subscriptions, normalised monthly.
  let mrrIrr = 0;
  const planDistribution = new Map<string, number>();
  for (const s of (subs.data || []) as FinanceSubscriptionRow[]) {
    if (s.status !== 'active' && s.status !== 'trialing') continue;
    const plan = planById.get(s.plan_id);
    if (!plan) continue;
    planDistribution.set(plan.name, (planDistribution.get(plan.name) || 0) + 1);
    if (plan.is_free) continue;
    const price: Partial<Record<'monthly' | 'yearly', unknown>> = plan.prices?.[reportCurrency] || {};
    const monthly = s.billing_interval === 'yearly'
      ? Number(price.yearly || 0) / 12
      : Number(price.monthly || 0);
    mrrIrr += Math.round(monthly);
  }

  res.json({
    // Field names are historic: in the International edition every amount
    // (mrrIrr / arrIrr included) is USD minor units (cents).
    currency: reportCurrency,
    months,
    totals: {
      grossRevenue,
      refundTotal,
      netRevenue: grossRevenue - refundTotal,
      testRevenue,
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
    recentPayments: paymentRows.slice(0, 50).map((p) => ({
      ...p,
      is_test: isTestPaymentProvider(p.provider_name),
      workspace_name: workspaceById.get(p.workspace_id)?.name || null,
    })),
  });
});

// ─── Admin: POST /api/billing/admin/plans — create/update plan ──

billingRouter.post('/admin/plans', requireSuperAdmin, async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
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
      serverConfigOf(req),
      plan.id,
      { previous: previousPlan as PlanDefinitionLike | null, next: data as PlanDefinitionLike | null },
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

  const supabase = serviceClientFor(url, key);
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
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
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
  } catch (e: unknown) {
    res.status(500).json({ error: String(errorMessageOf(e) || e) });
  }
});
