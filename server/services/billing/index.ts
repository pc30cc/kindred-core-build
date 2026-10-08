// ============================================
// BILLING SERVICE — Provider resolution + dispatch
// ============================================

import { serviceClientFor } from '../../lib/serviceClient.js';
import type { BillingProviderHandler, BillingProviderConfig, CheckoutRequest, WebhookEvent } from './types.js';
import { stripeProvider } from './providers/stripe.js';
import { paddleProvider } from './providers/paddle.js';
import { lemonSqueezyProvider } from './providers/lemonsqueezy.js';
import { paypalProvider } from './providers/paypal.js';
import { zarinpalProvider } from './providers/zarinpal.js';
import { zarinpalTestProvider } from './providers/zarinpal-test.js';
import { idpayProvider } from './providers/idpay.js';
import { idpayTestProvider } from './providers/idpay-test.js';
import { iranPardakhtSandboxProvider } from './providers/iranpardakht-sandbox.js';
import { internalTestProvider, INTERNAL_TEST_PROVIDER } from './providers/internal-test.js';
import { resolvePublicApiOrigin } from './callbackUrl.js';
import { nextpayProvider } from './providers/nextpay.js';
import { paypingProvider } from './providers/payping.js';
import { zibalProvider } from './providers/zibal.js';
import { sepProvider } from './providers/sep.js';
import { iyzicoProvider } from './providers/iyzico.js';
import { paytrProvider } from './providers/paytr.js';
import { sipayProvider } from './providers/sipay.js';
import { paratikaProvider } from './providers/paratika.js';
import { craftgateProvider } from './providers/craftgate.js';
import { addBillingInterval } from './periods.js';
import { recordProviderRefund } from './refunds.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { getPlatformEdition, isProviderAllowedInEdition } from './edition.js';


// Provider registry
const providers: Record<string, BillingProviderHandler> = {
  stripe: stripeProvider,
  paddle: paddleProvider,
  lemon_squeezy: lemonSqueezyProvider,
  paypal: paypalProvider,
  zarinpal: zarinpalProvider,
  zarinpal_test: zarinpalTestProvider,
  idpay: idpayProvider,
  idpay_test: idpayTestProvider,
  iranpardakht_sandbox: iranPardakhtSandboxProvider,
  // Self-hosted simulated gateway for exercising the financial pipeline.
  internal_test: internalTestProvider,
  nextpay: nextpayProvider,
  payping: paypingProvider,
  zibal: zibalProvider,
  sep_shaparak: sepProvider,
  iyzico: iyzicoProvider,
  paytr: paytrProvider,
  sipay: sipayProvider,
  paratika: paratikaProvider,
  craftgate: craftgateProvider,
};

export function getProvider(name: string): BillingProviderHandler | null {
  return providers[name] || null;
}

/**
 * The internal test gateway serves its own "bank page" from THIS deployment
 * (`/api/billing/test-gateway`) and must never derive that host from a
 * client-supplied callback URL (see providers/internal-test.ts). Every
 * resolution path funnels through here so the canonical PUBLIC API origin is
 * populated exactly once, from the platform's own domain configuration — an
 * explicit `gateway_base_url` already set (e.g. by an operator override)
 * always wins.
 */
async function withGatewayBaseUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
  config: BillingProviderConfig,
): Promise<BillingProviderConfig> {
  if (providerName !== INTERNAL_TEST_PROVIDER) return config;
  if (typeof config.gateway_base_url === 'string' && config.gateway_base_url.trim()) return config;
  const apiOrigin = await resolvePublicApiOrigin(supabaseUrl, serviceRoleKey);
  return { ...config, gateway_base_url: apiOrigin };
}

/**
 * The ONE canonical, platform-wide credential source for a billing provider
 * (`billing_provider_credentials`, keyed only by provider_name — see
 * database/migrations/137_billing_provider_credentials.sql). It always wins
 * over any legacy value still carried on `config` (a pre-migration
 * `billing_gateways.config` / `app_runtime_config.default_billing_provider`
 * copy) — a workspace-specific override applied by the caller AFTER this
 * still wins over the platform-wide canonical value, as intended.
 */
async function withCanonicalCredentials(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
  config: BillingProviderConfig,
): Promise<BillingProviderConfig> {
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from('billing_provider_credentials')
    .select('config')
    .eq('provider_name', providerName)
    .maybeSingle();
  if (error) {
    // 42P01 = undefined_table: migration 137 has not been applied yet on
    // this deployment. Degrade to the legacy sources already merged into
    // `config` rather than breaking every checkout/verify call — a missing
    // canonical layer is never less safe than the pre-migration behavior.
    // Any OTHER error (permissions, a real query failure) still fails loud.
    if ((error as { code?: string }).code === '42P01') return config;
    throw new Error(`billing provider credentials read failed: ${error.message}`);
  }
  const canonical = data?.config as Record<string, unknown> | null | undefined;
  if (!canonical || Object.keys(canonical).length === 0) return config;
  return { ...config, ...canonical, provider: providerName };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys that only point at a provider and configure nothing. */
const POINTER_KEYS = new Set(['provider', 'provider_name', 'config']);

/**
 * The platform-wide configuration of ONE provider, independent of any
 * workspace and of which provider is the current default. Precedence
 * (lowest → highest):
 *   1. billing_gateways.config        — legacy, pre-migration fallback
 *   2. app_runtime_config value       — legacy, only when it names this provider
 *                                       (both historical shapes)
 *   3. billing_provider_credentials   — the canonical Providers-screen store
 * Resolves null when none of them configures anything.
 *
 * Used where no workspace is known yet: webhook verification (a provider
 * calls in with a signature made with the secret stored here) and the
 * Super Admin connection test.
 */
export async function resolvePlatformBillingConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
): Promise<BillingProviderConfig | null> {
  if (!getProvider(providerName)) return null;
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  const [gatewayResult, globalResult] = await Promise.all([
    supabase.from('billing_gateways').select('config').eq('provider_name', providerName).maybeSingle(),
    supabase
      .from('app_runtime_config')
      .select('key, value')
      .in('key', ['default_billing_provider', 'billing_default_provider']),
  ]);
  if (gatewayResult.error) throw new Error(`billing provider config read failed: ${gatewayResult.error.message}`);
  if (globalResult.error) throw new Error(`billing provider config read failed: ${globalResult.error.message}`);

  let merged: Record<string, unknown> = isPlainRecord(gatewayResult.data?.config) ? { ...gatewayResult.data.config } : {};
  for (const row of (globalResult.data || []) as Array<{ key: string; value: unknown }>) {
    if (!isPlainRecord(row.value)) continue;
    if ((row.value.provider_name || row.value.provider) !== providerName) continue;
    const inner = isPlainRecord(row.value.config) ? row.value.config : {};
    merged = { ...merged, ...row.value, ...inner };
  }
  const config = await withCanonicalCredentials(supabaseUrl, serviceRoleKey, providerName, {
    ...merged,
    provider: providerName,
  });
  if (!Object.keys(config).some((k) => !POINTER_KEYS.has(k))) return null;
  return { ...config, provider: providerName };
}

/**
 * Every registered provider, or — with `edition` — only those that edition
 * may list (no Iranian gateway in the International edition).
 */
export function getAllProviders(
  edition?: 'iran' | 'international',
): Record<string, { name: string; capabilities: BillingProviderHandler['capabilities'] }> {
  const result: Record<string, { name: string; capabilities: BillingProviderHandler['capabilities'] }> = {};
  for (const [key, p] of Object.entries(providers)) {
    if (edition && !isProviderAllowedInEdition(key, edition)) continue;
    result[key] = { name: p.name, capabilities: p.capabilities };
  }
  return result;
}

/**
 * Resolve the configuration for one explicitly selected gateway. Activation
 * remains owned by billing_gateways; credentials may come from that canonical
 * row or from the Providers screen's global/workspace provider setting.
 */
export async function resolveNamedBillingConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  providerName: string,
): Promise<{ provider: BillingProviderHandler; config: BillingProviderConfig } | null> {
  const provider = getProvider(providerName);
  if (!provider) return null;
  // An Iranian gateway does not exist in the International edition.
  const edition = await getPlatformEdition({ supabaseUrl, supabaseServiceRoleKey: serviceRoleKey });
  if (!isProviderAllowedInEdition(providerName, edition)) return null;
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  const [gatewayResult, workspaceResult, globalResult] = await Promise.all([
    supabase.from('billing_gateways').select('config').eq('provider_name', providerName).maybeSingle(),
    supabase
      .from('provider_configs')
      .select('config')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'billing')
      .eq('provider_name', providerName)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('app_runtime_config').select('value').eq('key', 'default_billing_provider').maybeSingle(),
  ]);
  for (const result of [gatewayResult, workspaceResult, globalResult]) {
    if (result.error) throw new Error(`billing provider config read failed: ${result.error.message}`);
  }

  const globalValue = globalResult.data?.value as Record<string, unknown> | null | undefined;
  const globalName = globalValue && (globalValue.provider_name || globalValue.provider);
  const globalConfig = globalName === providerName && globalValue
    ? ((globalValue.config && typeof globalValue.config === 'object' ? globalValue.config : {}) as Record<string, unknown>)
    : {};

  // Precedence (lowest -> highest):
  //   1. billing_gateways.config          — legacy, pre-migration fallback only
  //   2. app_runtime_config .config       — legacy, pre-migration fallback only
  //   3. billing_provider_credentials     — the ONE canonical Providers source
  //   4. provider_configs (this workspace) — workspace-specific override, always wins
  // `billing_gateways` is operational state (enabled/disabled, test marker,
  // currencies, display) — it must never silently override a credential
  // entered in Providers.
  let config: BillingProviderConfig = {
    provider: providerName,
    ...((gatewayResult.data?.config as Record<string, unknown> | null) || {}),
    ...globalConfig,
  };
  config = await withCanonicalCredentials(supabaseUrl, serviceRoleKey, providerName, config);
  config = { ...config, ...((workspaceResult.data?.config as Record<string, unknown> | null) || {}) };

  return {
    provider,
    config: await withGatewayBaseUrl(supabaseUrl, serviceRoleKey, providerName, config),
  };
}

/**
 * Resolve billing provider config for a workspace.
 * Resolution chain: workspace override → global default.
 *
 * In the International edition an Iranian gateway is never the answer: a
 * workspace or platform default naming one resolves to null ("no provider
 * configured"), so callers fall back to the payable international gateways.
 */
export async function resolveBillingConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<{ provider: BillingProviderHandler; config: BillingProviderConfig } | null> {
  const edition = await getPlatformEdition({ supabaseUrl, supabaseServiceRoleKey: serviceRoleKey });
  const resolved = await resolveDefaultBillingConfig(supabaseUrl, serviceRoleKey, workspaceId);
  if (resolved && !isProviderAllowedInEdition(resolved.provider.name, edition)) {
    console.warn('[billing] default provider is not available in this edition; ignoring it', {
      workspaceId,
      provider: resolved.provider.name,
      edition,
    });
    return null;
  }
  return resolved;
}

async function resolveDefaultBillingConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<{ provider: BillingProviderHandler; config: BillingProviderConfig } | null> {
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);

  // 1. Check workspace-level billing providers. Legacy data can contain more
  // than one active row for the same workspace/type, so always resolve the
  // newest row deterministically instead of letting PostgREST pick one.
  const { data: wsConfigs, error: wsConfigError } = await supabase
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'billing')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(2);

  if (wsConfigError) {
    console.error('[billing] failed to resolve workspace provider config', {
      workspaceId,
      error: wsConfigError.message,
    });
  }

  const wsConfig = wsConfigs?.[0];

  // 2. Check global default (app_runtime_config).
  // Two historical shapes are supported:
  //   key `default_billing_provider` → { provider_name, config }  (admin UI)
  //   key `billing_default_provider` → { provider, ...config }    (legacy)
  const { data: globalRows } = await supabase
    .from('app_runtime_config')
    .select('key, value, updated_at')
    .in('key', ['default_billing_provider', 'billing_default_provider']);

  const modernGlobalRow = (globalRows || []).find((r: { key: string }) => r.key === 'default_billing_provider');
  const workspaceUpdatedAt = wsConfig?.updated_at ? Date.parse(wsConfig.updated_at) : 0;
  const globalUpdatedAt = modernGlobalRow?.updated_at ? Date.parse(modernGlobalRow.updated_at) : 0;

  // A newly saved platform default must replace a stale legacy workspace row.
  // A workspace override saved afterwards still takes precedence as intended.
  if (wsConfig && workspaceUpdatedAt >= globalUpdatedAt) {
    const handler = getProvider(wsConfig.provider_name);
    if (handler) {
      if ((wsConfigs?.length || 0) > 1) {
        console.warn('[billing] multiple active workspace provider configs; using newest', {
          workspaceId,
          selectedProvider: wsConfig.provider_name,
          selectedConfigId: wsConfig.id,
          activeConfigCountAtLeast: wsConfigs?.length,
        });
      }
      console.info('[billing] resolved workspace provider', {
        workspaceId,
        provider: wsConfig.provider_name,
        configId: wsConfig.id,
        updatedAt: wsConfig.updated_at,
      });
      const withCanonical = await withCanonicalCredentials(
        supabaseUrl, serviceRoleKey, wsConfig.provider_name, { provider: wsConfig.provider_name },
      );
      return {
        provider: handler,
        config: await withGatewayBaseUrl(supabaseUrl, serviceRoleKey, wsConfig.provider_name, {
          ...withCanonical,
          ...(wsConfig.config as Record<string, unknown>), // workspace override always wins
        }),
      };
    }
  }

  for (const key of ['default_billing_provider', 'billing_default_provider']) {
    const row = (globalRows || []).find((r: { key: string }) => r.key === key);
    const value = row?.value as Record<string, unknown> | null | undefined;
    if (!value) continue;
    const name = (value.provider_name || value.provider) as string | undefined;
    if (!name) continue;
    const handler = getProvider(name);
    if (!handler) continue;
    const inner = (value.config && typeof value.config === 'object' ? value.config : {}) as Record<string, unknown>;
    console.info('[billing] resolved global provider', {
      workspaceId,
      provider: name,
      configKey: key,
    });
    const legacyConfig = { ...value, ...inner, provider: name } as BillingProviderConfig;
    const withCanonical = await withCanonicalCredentials(supabaseUrl, serviceRoleKey, name, legacyConfig);
    return {
      provider: handler,
      config: await withGatewayBaseUrl(supabaseUrl, serviceRoleKey, name, withCanonical),
    };
  }

  // Preserve an older workspace override when no usable global provider exists.
  if (wsConfig) {
    const handler = getProvider(wsConfig.provider_name);
    if (handler) {
      const withCanonical = await withCanonicalCredentials(
        supabaseUrl, serviceRoleKey, wsConfig.provider_name, { provider: wsConfig.provider_name },
      );
      return {
        provider: handler,
        config: await withGatewayBaseUrl(supabaseUrl, serviceRoleKey, wsConfig.provider_name, {
          ...withCanonical,
          ...(wsConfig.config as Record<string, unknown>),
        }),
      };
    }
  }

  return null;
}

/**
 * Log a billing event to billing_events table
 */
export async function logBillingEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  event: {
    workspace_id?: string;
    event_type: string;
    provider_name: string;
    provider_event_id?: string;
    amount?: number;
    currency?: string;
    status: string;
    metadata?: unknown;
  }
) {
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  await supabase.from('billing_events').insert({
    workspace_id: event.workspace_id || '00000000-0000-0000-0000-000000000000',
    event_type: event.event_type,
    provider_name: event.provider_name,
    provider_event_id: event.provider_event_id,
    amount: event.amount,
    currency: event.currency,
    status: event.status,
    metadata: event.metadata || {},
  });
}

// ─── Webhook idempotency (replay / duplicate protection) ───────────────
//
// `billing_events` carries a unique index on
// `(provider_name, provider_event_id) WHERE provider_event_id IS NOT NULL`.
// A verified webhook MUST atomically claim its provider event row BEFORE any
// financial side effect runs. A duplicate delivery loses the race on that
// index and is acknowledged without re-applying anything.

export type BillingEventClaim =
  | { claimed: true; eventRowId: string }
  | { claimed: false; duplicate: true }
  /** Another delivery holds the claim right now (`received`, not yet stale). */
  | { claimed: false; inFlight: true };

/**
 * A `received` row older than this is a delivery whose processing died (a
 * crash or a restart between the claim and the outcome): the provider's next
 * retry may take it over. Processing a webhook takes seconds.
 */
export const STALE_WEBHOOK_CLAIM_MS = 5 * 60 * 1000;

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === PG_UNIQUE_VIOLATION;
}

export interface BillingWebhookClaimInput {
  providerName: string;
  providerEventId: string;
  workspaceId: string;
  eventType: string;
  amount?: number;
  currency?: string;
  metadata?: unknown;
}

/**
 * Atomically claims a provider webhook event.
 *
 * Resolves `{ claimed: true }` exactly once per
 * `(provider_name, provider_event_id)` pair. Resolves
 * `{ claimed: false, duplicate: true }` for a replay, and
 * `{ claimed: false, inFlight: true }` while another delivery is processing
 * it. A row whose processing failed, or that sat in `received` for longer
 * than STALE_WEBHOOK_CLAIM_MS, is taken over by the provider's retry. Any
 * other database failure REJECTS — the caller must abort without side effects.
 *
 * `created_at` of a row is the time of its latest claim: a take-over moves it
 * (compare-and-set on the value read), so exactly one retry wins and the new
 * claim is not itself stale.
 */
export async function claimBillingWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: BillingWebhookClaimInput,
): Promise<BillingEventClaim> {
  if (!input.providerName) throw new Error('claimBillingWebhookEvent: providerName required');
  if (!input.providerEventId) throw new Error('claimBillingWebhookEvent: providerEventId required');
  if (!input.workspaceId) throw new Error('claimBillingWebhookEvent: workspaceId required');

  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from('billing_events')
    .insert({
      workspace_id: input.workspaceId,
      event_type: input.eventType,
      provider_name: input.providerName,
      provider_event_id: input.providerEventId,
      amount: input.amount,
      currency: input.currency,
      status: 'received',
      metadata: input.metadata || {},
    })
    .select('id')
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      // A delivery whose processing FAILED earlier may be re-processed by the
      // provider's retry: the failed row is taken back atomically (only one
      // concurrent retry can move it off `failed`). Everything behind it is
      // idempotent (intent claim, unique payment per intent, settlement
      // command key), so a retry finishes the job instead of being dropped
      // as a duplicate.
      const claimedAt = new Date().toISOString();
      const { data: retaken, error: retakeError } = await supabase
        .from('billing_events')
        .update({ status: 'received', created_at: claimedAt })
        .eq('provider_name', input.providerName)
        .eq('provider_event_id', input.providerEventId)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle();
      const retakenId = (retaken as { id?: unknown } | null)?.id;
      if (!retakeError && typeof retakenId === 'string' && retakenId.length > 0) {
        return { claimed: true, eventRowId: retakenId };
      }

      // Still `received`: being processed, or abandoned by a crashed attempt.
      // A stale one is taken over the same way, keyed on the claim time read.
      const { data: current, error: readError } = await supabase
        .from('billing_events')
        .select('id, status, created_at')
        .eq('provider_name', input.providerName)
        .eq('provider_event_id', input.providerEventId)
        .maybeSingle();
      const row = current as { id?: unknown; status?: unknown; created_at?: unknown } | null;
      if (readError || !row || row.status !== 'received') return { claimed: false, duplicate: true };
      const claimedBefore = typeof row.created_at === 'string' ? Date.parse(row.created_at) : Number.NaN;
      if (!Number.isFinite(claimedBefore) || Date.now() - claimedBefore < STALE_WEBHOOK_CLAIM_MS) {
        return { claimed: false, inFlight: true };
      }
      const { data: stolen, error: stealError } = await supabase
        .from('billing_events')
        .update({ created_at: claimedAt })
        .eq('id', row.id as string)
        .eq('status', 'received')
        .eq('created_at', row.created_at as string)
        .select('id')
        .maybeSingle();
      const stolenId = (stolen as { id?: unknown } | null)?.id;
      if (!stealError && typeof stolenId === 'string' && stolenId.length > 0) {
        return { claimed: true, eventRowId: stolenId };
      }
      return { claimed: false, inFlight: true };
    }
    throw new Error('billing event claim failed');
  }
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('billing event claim failed');
  return { claimed: true, eventRowId: id };
}

/** Finalises a claimed event row. `processed_at` is only set on success. */
export async function finalizeBillingWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  eventRowId: string,
  outcome: 'success' | 'failed',
): Promise<void> {
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);
  await supabase
    .from('billing_events')
    .update({
      status: outcome,
      ...(outcome === 'success' ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', eventRowId);
}

/**
 * The new subscription period end for a payment event. Prefers the real
 * billing interval carried on the event (set from the payment intent for
 * Iranian gateways); only falls back to a flat 30 days for providers whose
 * webhook payload does not carry an interval.
 *
 * Calendar arithmetic (month-end clamping, leap years) lives in ./periods.ts.
 */
export function computePeriodEnd(now: Date, interval: WebhookEvent['interval']): Date {
  if (interval === 'monthly' || interval === 'yearly') return addBillingInterval(now, interval);
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
}


/**
 * A verified webhook event that is NOT bound to a payment intent (events
 * carrying an intent id are settled through the invoice engine, see
 * ./cardInvoice.ts).
 *
 * Every workspace is on the invoice engine, where only a paid invoice may
 * change the subscription: `workspace_subscriptions` refuses any other write
 * to the plan or the period (migration 117's trigger). So an unbound event
 * never grants, extends, cancels or suspends anything here. What it can do:
 *
 *   - a refund is recorded on the payment it refunds;
 *   - money that arrived without an invoice (e.g. from an old subscription or
 *     a payment link) is recorded as UNAPPLIED, for finance to reconcile —
 *     never discarded, never applied;
 *   - everything else is only logged.
 */
export async function processWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
  event: WebhookEvent,
  opts: { alreadyClaimed?: boolean } = {},
) {
  const supabase = serviceClientFor(supabaseUrl, serviceRoleKey);

  // Log the event — skipped when the caller already claimed a
  // `billing_events` row for this provider event (idempotent webhook path),
  // otherwise the second insert would trip the unique index.
  if (!opts.alreadyClaimed) await logBillingEvent(supabaseUrl, serviceRoleKey, {
    workspace_id: event.workspaceId,
    event_type: event.type,
    provider_name: providerName,
    provider_event_id: event.providerEventId,
    amount: event.amount,
    currency: event.currency,
    status: event.type.includes('failed') ? 'failed' : 'success',
    metadata: event.raw,
  });

  if (!event.workspaceId) return;

  switch (event.type) {
    case 'refund_processed':
      await recordProviderRefund(supabase, providerName, event);
      return;

    case 'checkout_completed':
    case 'subscription_created':
    case 'payment_succeeded':
    case 'invoice_paid': {
      if (!event.amount) return;
      // Replay-safe via the unique index on (provider_name, provider_payment_id).
      const { error: paymentError } = await supabase.from('billing_payments').insert({
        workspace_id: event.workspaceId,
        provider_name: providerName,
        provider_payment_id: event.providerPaymentId || event.providerEventId,
        amount: event.amount,
        currency: event.currency || 'USD',
        status: 'succeeded',
        purchase_type: 'subscription',
        action_type: 'plan_new',
        paid_at: new Date().toISOString(),
        reconciliation_state: 'unapplied',
        reconciliation_reason: 'provider_payment_without_invoice',
        metadata: { providerEventId: event.providerEventId, eventType: event.type },
      });
      // A replayed provider payment id is expected and must not fail the event.
      if (paymentError && paymentError.code !== '23505') throw new Error(paymentError.message);
      return;
    }

    default:
      // subscription_updated / subscription_canceled / payment_failed /
      // invoice_failed: the invoice engine owns the subscription; nothing to apply.
      return;
  }
}

/**
 * Whether a workspace's plan grants a feature — the GET /api/billing/entitlement
 * answer. Delegates to the enforcement check (featureGating.ts over
 * check_workspace_entitlement), so it applies the same plan selection and the
 * same `override ?? plan ?? registry default` rule as every gate and as
 * GET /api/plans/workspace/:id/effective. It used to read billing_plans
 * itself, deny every key the plan JSON did not mention, and keep a
 * past-due or canceled-at-period-end workspace on Free.
 */
export async function checkEntitlement(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  feature: string
): Promise<{ allowed: boolean; limit?: number; used?: number }> {
  const result = await checkEntitlementFromDB(supabaseUrl, serviceRoleKey, workspaceId, feature);
  return result.limitValid && typeof result.limit === 'number'
    ? { allowed: result.allowed, limit: result.limit }
    : { allowed: result.allowed };
}
