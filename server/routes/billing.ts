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

export const billingRouter = Router();

function getConfig(req: any) {
  const c = (req as any).serverConfig;
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

// ─── Auth / Authorization ────────────────────────────────────────
//
// Billing routes previously accepted the publishable anon key (or nothing at
// all) as identity, so any visitor could read/modify any workspace's
// subscription by passing a `workspaceId`. Identity is now derived from a real
// Supabase user JWT and workspace membership/role is verified BEFORE any
// service-role database access or provider request happens.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serverConfigOf(req: any): ServerConfig {
  return (req as any).serverConfig as ServerConfig;
}

/** Resolves the calling user from the Bearer JWT. Writes 401 and returns null on failure. */
async function requireUser(req: any, res: any): Promise<string | null> {
  const config = serverConfigOf(req);
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  // Publishable anon key and service-role key are not user identities.
  if (!token || token === config.supabaseAnonKey || token === config.supabaseServiceRoleKey) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  try {
    const { data, error } = await getServiceClient(config).auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid token' });
      return null;
    }
    return data.user.id;
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
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
  const userId = await requireUser(req, res);
  if (!userId) return null;

  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspaceId' });
    return null;
  }

  const config = serverConfigOf(req);
  if (await isGlobalAdmin(config, userId)) return { userId, isAdmin: true, role: null };

  const sb = getServiceClient(config);
  const { data: isMember } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  const role = ((member as { role?: string } | null)?.role) ?? null;

  if (opts.manage && role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'Insufficient workspace permissions' });
    return null;
  }
  return { userId, isAdmin: false, role };
}

/** Super-admin (platform) gate — `has_role(uid,'admin')` only. No fallbacks. */
async function requireSuperAdmin(req: any, res: any, next: any) {
  const userId = await requireUser(req, res);
  if (!userId) return;
  if (!(await isGlobalAdmin(serverConfigOf(req), userId))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
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
    .limit(20);

  res.json({ subscription: sub, payments: payments || [] });
});

// ─── POST /api/billing/checkout — create checkout session ────────
const checkoutSchema = z.object({
  workspaceId: z.string().uuid(),
  planId: z.string(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  currency: z.string().default('USD'),
  callbackUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
  customerName: z.string().optional(),
  amount: z.number().optional(),
  phone: z.string().optional(),
});

billingRouter.post('/checkout', async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });

  const input = parsed.data;
  if (!(await authorizeWorkspace(req, res, input.workspaceId, { manage: true }))) return;
  const { url, key } = getConfig(req);
  try {
    const resolved = await resolveBillingConfig(url, key, input.workspaceId);
    if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });

    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId: input.workspaceId,
      planId: input.planId,
      interval: input.interval,
      currency: input.currency,
      callbackUrl: input.callbackUrl,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      metadata: {
        amount: String(input.amount || 0),
        phone: input.phone || '',
      },
    });

    await logBillingEvent(url, key, {
      workspace_id: input.workspaceId,
      event_type: 'checkout_initiated',
      provider_name: resolved.provider.name,
      amount: input.amount,
      currency: input.currency,
      status: 'pending',
      metadata: { planId: input.planId, sessionId: result.sessionId },
    });

    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/billing/verify-callback — verify callback from gateway ──
billingRouter.post('/verify-callback', async (req, res) => {
  const { workspaceId, provider: providerName, params } = req.body;
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
