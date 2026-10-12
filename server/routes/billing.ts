// ============================================================================
// Billing: the public plan list and the payment gateways' webhooks.
//
// Billing v2 (invoices, payment intents, the v2 wallet and its customer and
// Super Admin routes) was removed in phase 7 (docs/billing/SIMPLE_BILLING.md).
// What stays here:
//   * GET /api/billing/plans, the public plan list (read by the landing page);
//   * POST /api/billing/webhook/:provider, mounted separately with a raw body
//     parser (server/index.ts): account payments, refunds and saved cards.
// The simple billing's own routes are in billingAccount.ts and
// billingAccountAi.ts.
// ============================================================================

import { Router, raw, type Request, type Response } from 'express';
import {
  getProvider,
  resolvePlatformBillingConfig,
  claimBillingWebhookEvent,
  finalizeBillingWebhookEvent,
} from '../services/billing/index.js';
import type { WebhookEvent } from '../services/billing/types.js';
import { serviceClientFor } from '../lib/serviceClient.js';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { editionErrorResponse, getBillingRegion } from '../services/billing/edition.js';
import {
  findAccountPaymentByProviderPayment,
  handleAccountPaymentWebhook,
  readAccountPayment,
  type AccountPaymentRow,
} from '../services/billing/account/index.js';
import { cardEventOwner, handleCardEvent } from '../services/billing/account/card.js';

/** `err?.message` of an unknown thrown value (undefined when it has none). */
function errorMessageOf(err: unknown): unknown {
  return (err as { message?: unknown } | null | undefined)?.message;
}

export const billingRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

function getConfig(req: Request) {
  const c = serverConfigOf(req);
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

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

// ─── POST /api/billing/webhook/:provider — handle provider webhooks ──
//
// Public by necessity (external providers call it), but fail-closed:
// only providers whose `verifyWebhook` performs a cryptographic signature
// check over the exact raw body are accepted. Everything else is rejected
// without touching the database.
//
// What a verified event can act on (simple billing): a payment or refund of
// a workspace account payment, and a saved card's Paddle subscription. Billing
// v2 was removed in phase 7: an event naming neither (for example a late
// event about an old v2 payment intent) is acknowledged and logged as REVIEW,
// so a person can look at it; nothing is applied. When its workspace is known
// it is also kept in billing_events (claimed, metadata.review).
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

/** Gateways whose subscriptions can be a saved card's (simple billing, phase 3b). */
const CARD_PROVIDERS = new Set(['paddle', 'paddle_sandbox']);

/**
 * The workspace a verified platform-level event belongs to when its payload
 * names none: the account payment it names (custom metadata), the account
 * payment it refers to, or the saved card whose subscription it names. All
 * are this server's own records, reached through identifiers inside a payload
 * whose signature already verified.
 * `foreignIntent`: the event names a payment or subscription this database
 * has no account payment or card for (another installation's, or an old
 * billing v2 intent, payment or subscription).
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
    // A simple-billing account payment carries its id where an intent's would be.
    const accountPayment = await readAccountPayment(cfg, event.intentId);
    if (accountPayment && accountPayment.provider === providerName) return { workspaceId: accountPayment.workspace_id, foreignIntent };
    foreignIntent = !accountPayment;
  }
  if (event.providerPaymentId) {
    const accountPayment = await findAccountPaymentByProviderPayment(cfg, providerName, event.providerPaymentId);
    if (accountPayment) return { workspaceId: accountPayment.workspace_id, foreignIntent: false };
  }
  if (event.providerSubscriptionId && CARD_PROVIDERS.has(providerName)) {
    const { data, error } = await getServiceClient(cfg)
      .from('billing_account_cards')
      .select('workspace_id')
      .eq('provider', providerName)
      .eq('subscription_id', event.providerSubscriptionId)
      .maybeSingle();
    if (error) throw new Error(`card read failed: ${error.message}`);
    const ws = (data as { workspace_id?: string | null } | null)?.workspace_id;
    if (ws) return { workspaceId: ws, foreignIntent: false };
  }
  // Named something, and none of it is ours.
  if (event.providerPaymentId || event.providerSubscriptionId) foreignIntent = true;
  return { workspaceId: null, foreignIntent };
}

/**
 * A verified event that names no account payment and no saved card: a
 * provider account shared with another installation (another copy of this
 * platform on the same Stripe / PayPal account) receives its events too, and
 * a gateway may still send a late event about a billing v2 payment intent
 * (v2 was removed in phase 7; its intents lived 30-45 minutes). It is
 * acknowledged — refusing it would only make the provider retry it, and
 * eventually disable the endpoint — nothing is applied, and it is logged as
 * REVIEW so a person can check the gateway's panel.
 */
function logReviewEvent(providerName: string, event: WebhookEvent, workspaceId: string | null = null) {
  console.warn('[billing] REVIEW: webhook names no account payment or card', {
    provider: providerName,
    eventType: event.type,
    ref: event.intentId ?? event.providerPaymentId ?? event.providerSubscriptionId ?? null,
    event: event.providerEventId ?? null,
    workspaceId,
    amount: event.amount ?? null,
    currency: event.currency ?? null,
  });
}

/**
 * A saved card's event (Paddle, simple billing phase 3b): whose it is comes
 * from our own records only (the card of its subscription, or the card
 * checkout that created it). One that is not ours (another installation's
 * subscription on the same Paddle account; RESPOK's database is a clone of
 * WebYar's, so its workspace ids exist here too) is acknowledged and nothing
 * is done: never claimed, never cancelled. Ours is claimed, handled (card.ts
 * handleCardEvent) and finalized; a failure answers 500 so Paddle delivers
 * it again.
 */
async function handleCardWebhook(
  ctx: {
    res: Response;
    cfg: ServerConfig;
    url: string;
    key: string;
    providerName: string;
    acknowledge: (body: Record<string, unknown>) => unknown;
  },
  event: WebhookEvent,
  configWorkspaceId: string | null,
) {
  const { res, cfg, url, key, providerName, acknowledge } = ctx;
  const providerEventId = typeof event.providerEventId === 'string' ? event.providerEventId.trim() : '';
  if (!providerEventId) {
    logWebhookRejection(providerName, 'missing_provider_event_id');
    return res.status(400).json({ error: 'Webhook rejected' });
  }
  let owner: Awaited<ReturnType<typeof cardEventOwner>>;
  try {
    owner = await cardEventOwner(cfg, providerName, event);
  } catch {
    logWebhookRejection(providerName, 'card_read_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (!owner) {
    console.warn(`[billing-webhook] ignored provider=${providerName} reason=foreign_card subscription=${event.providerSubscriptionId ?? '-'} event=${providerEventId}`);
    return acknowledge({ received: true, ignored: true });
  }
  // A workspace's own Paddle config only verifies that workspace's cards.
  if (configWorkspaceId && configWorkspaceId !== owner.workspaceId) {
    logWebhookRejection(providerName, 'workspace_mismatch');
    return res.status(400).json({ error: 'Webhook rejected' });
  }
  if (event.workspaceId && event.workspaceId !== owner.workspaceId) {
    console.error(`[billing-webhook] REVIEW provider=${providerName} card event ${providerEventId} names workspace ${event.workspaceId}; its card is workspace ${owner.workspaceId}'s`);
  }
  event.workspaceId = owner.workspaceId;

  let claim;
  try {
    claim = await claimBillingWebhookEvent(url, key, {
      providerName,
      providerEventId,
      workspaceId: owner.workspaceId,
      eventType: 'card_event',
      amount: event.amount,
      currency: event.currency,
      metadata: event.raw,
    });
  } catch {
    logWebhookRejection(providerName, 'claim_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (!claim.claimed) {
    if ('inFlight' in claim) return res.status(409).json({ error: 'Webhook already in progress' });
    return acknowledge({ received: true, duplicate: true });
  }
  try {
    await handleCardEvent(cfg, { providerName, event, owner });
  } catch (e) {
    // Marked failed: Paddle's retry is processed again (each step is idempotent).
    await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'failed').catch(() => {});
    console.warn(`[billing-webhook] card event ${providerEventId} provider=${providerName} failed: ${e instanceof Error ? e.message : String(e)}`);
    logWebhookRejection(providerName, 'card_event_processing_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  await finalizeBillingWebhookEvent(url, key, claim.eventRowId, 'success').catch(() => {});
  return acknowledge({ received: true });
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
  // A saved card's events (Paddle subscriptions, simple billing phase 3b) are
  // kept apart: they are routed below by our own card row or card checkout,
  // never by the workspace their copied custom_data names (P6).
  const cardEvents: Array<{ event: WebhookEvent; configWorkspaceId: string | null }> = [];
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
    if (event.type === 'card_event') {
      cardEvents.push({ event, configWorkspaceId: candidate.workspaceId });
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

  if (cardEvents.length) {
    if (cardEvents.length > 1 || accepted.length) {
      logWebhookRejection(providerName, 'ambiguous_candidate_configs');
      return res.status(400).json({ error: 'Webhook rejected' });
    }
    return handleCardWebhook(
      { res, cfg, url, key, providerName, acknowledge },
      cardEvents[0].event,
      cardEvents[0].configWorkspaceId,
    );
  }

  if (accepted.length > 1) {
    logWebhookRejection(providerName, 'ambiguous_candidate_configs');
    return res.status(400).json({ error: 'Webhook rejected' });
  }
  if (accepted.length === 0) {
    if ((sawIgnored || foreignEvent) && !sawMismatch && !sawUnresolved) {
      if (foreignEvent) logReviewEvent(providerName, foreignEvent);
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
  // provider's signed custom metadata; a refund may name only the provider's
  // transaction. Anything else is acknowledged and logged as REVIEW below.
  let accountPayment: AccountPaymentRow | null = null;
  try {
    if (event.intentId) accountPayment = await readAccountPayment(cfg, event.intentId);
    if (!accountPayment && event.type === 'refund_processed' && event.providerPaymentId) {
      accountPayment = await findAccountPaymentByProviderPayment(cfg, providerName, event.providerPaymentId);
    }
  } catch {
    logWebhookRejection(providerName, 'account_payment_read_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (accountPayment) {
    if (accountPayment.workspace_id !== workspaceId || accountPayment.provider !== providerName) {
      logWebhookRejection(providerName, 'account_payment_mismatch');
      return res.status(400).json({ error: 'Webhook rejected' });
    }
    // Only a payment or a refund moves an account's money. Other events about
    // it are acknowledged WITHOUT being claimed, so nothing is recorded as
    // processed that was not.
    if (event.type !== 'payment_succeeded' && event.type !== 'refund_processed') {
      return acknowledge({ received: true, ignored: true });
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

  // Nothing of this server's own: no account payment and no saved card (a
  // late event about an old billing v2 intent or subscription, money sent
  // outside a checkout). Nothing is applied, and it is never dropped
  // silently: the claim keeps it in billing_events (marked for review, and a
  // replay is acknowledged as a duplicate), and it is logged as REVIEW for a
  // person to check against the gateway's panel.
  let reviewClaim;
  try {
    reviewClaim = await claimBillingWebhookEvent(url, key, {
      providerName,
      providerEventId,
      workspaceId,
      eventType: event.type,
      amount: event.amount,
      currency: event.currency,
      metadata: { review: 'no_account_payment_or_card', payload: event.raw ?? null },
    });
  } catch {
    logWebhookRejection(providerName, 'claim_failed');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (!reviewClaim.claimed) {
    if ('inFlight' in reviewClaim) return res.status(409).json({ error: 'Webhook already in progress' });
    return acknowledge({ received: true, duplicate: true });
  }
  logReviewEvent(providerName, event, workspaceId);
  await finalizeBillingWebhookEvent(url, key, reviewClaim.eventRowId, 'success').catch(() => {});
  return acknowledge({ received: true, ignored: true });
});
