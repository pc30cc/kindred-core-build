// ============================================
// BILLING SERVICE — Provider resolution + dispatch
// ============================================

import { createClient } from '@supabase/supabase-js';
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
import { nextpayProvider } from './providers/nextpay.js';
import { paypingProvider } from './providers/payping.js';
import { zibalProvider } from './providers/zibal.js';
import { sepProvider } from './providers/sep.js';
import { iyzicoProvider } from './providers/iyzico.js';
import { paytrProvider } from './providers/paytr.js';
import { sipayProvider } from './providers/sipay.js';
import { paratikaProvider } from './providers/paratika.js';
import { craftgateProvider } from './providers/craftgate.js';
import type { ServerConfig } from '../../config.js';
import {
  handleWorkspaceEntitlementChanged,
  type EntitlementChangeSource,
} from './entitlementChange.js';

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

export function getAllProviders(): Record<string, { name: string; capabilities: BillingProviderHandler['capabilities'] }> {
  const result: Record<string, { name: string; capabilities: BillingProviderHandler['capabilities'] }> = {};
  for (const [key, p] of Object.entries(providers)) {
    result[key] = { name: p.name, capabilities: p.capabilities };
  }
  return result;
}

/**
 * Resolve billing provider config for a workspace.
 * Resolution chain: workspace override → global default
 */
export async function resolveBillingConfig(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<{ provider: BillingProviderHandler; config: BillingProviderConfig } | null> {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

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
      return { provider: handler, config: { provider: wsConfig.provider_name, ...(wsConfig.config as Record<string, unknown>) } };
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
    return { provider: handler, config: { ...value, ...inner, provider: name } as BillingProviderConfig };
  }

  // Preserve an older workspace override when no usable global provider exists.
  if (wsConfig) {
    const handler = getProvider(wsConfig.provider_name);
    if (handler) return { provider: handler, config: { provider: wsConfig.provider_name, ...(wsConfig.config as Record<string, unknown>) } };
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
  const supabase = createClient(supabaseUrl, serviceRoleKey);
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
  | { claimed: false; duplicate: true };

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
 * `{ claimed: false, duplicate: true }` for a replay. Any other database
 * failure REJECTS — the caller must abort without side effects.
 */
export async function claimBillingWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: BillingWebhookClaimInput,
): Promise<BillingEventClaim> {
  if (!input.providerName) throw new Error('claimBillingWebhookEvent: providerName required');
  if (!input.providerEventId) throw new Error('claimBillingWebhookEvent: providerEventId required');
  if (!input.workspaceId) throw new Error('claimBillingWebhookEvent: workspaceId required');

  const supabase = createClient(supabaseUrl, serviceRoleKey);
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
    if (isUniqueViolation(error)) return { claimed: false, duplicate: true };
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
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  await supabase
    .from('billing_events')
    .update({
      status: outcome,
      ...(outcome === 'success' ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', eventRowId);
}

/**
 * Adds one billing interval to `from`, using real calendar month/year
 * arithmetic (not a fixed day count) so a monthly period always ends on the
 * same day-of-month and a yearly one on the same day-of-year.
 */
function addBillingInterval(from: Date, interval: 'monthly' | 'yearly'): Date {
  const d = new Date(from.getTime());
  if (interval === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/**
 * The new subscription period end for a payment event. Prefers the real
 * billing interval carried on the event (set from the payment intent for
 * Iranian gateways); only falls back to a flat 30 days for providers whose
 * webhook payload does not carry an interval.
 */
export function computePeriodEnd(now: Date, interval: WebhookEvent['interval']): Date {
  if (interval === 'monthly' || interval === 'yearly') return addBillingInterval(now, interval);
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
}

/**
 * Process a verified webhook event — update subscription state
 */
export async function processWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
  event: WebhookEvent,
  opts: { alreadyClaimed?: boolean } = {},
) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

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

  // Update subscription based on event type
  if (!event.workspaceId) return;

  switch (event.type) {
    case 'checkout_completed':
    case 'subscription_created':
    case 'payment_succeeded':
    case 'invoice_paid': {
      // Upsert subscription
      const periodStart = new Date();
      await supabase.from('workspace_subscriptions').upsert({
        workspace_id: event.workspaceId,
        provider_name: providerName,
        provider_subscription_id: event.providerSubscriptionId || null,
        provider_customer_id: event.providerCustomerId || null,
        status: 'active',
        plan_id: event.planId || null,
        current_period_start: periodStart.toISOString(),
        current_period_end: computePeriodEnd(periodStart, event.interval).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id' });

      // Record payment
      if (event.amount) {
        await supabase.from('billing_payments').insert({
          workspace_id: event.workspaceId,
          provider_name: providerName,
          provider_payment_id: event.providerPaymentId || event.providerEventId,
          amount: event.amount,
          currency: event.currency || 'USD',
          status: 'succeeded',
        });
      }
      break;
    }

    case 'subscription_canceled': {
      await supabase.from('workspace_subscriptions')
        .update({ status: 'canceled', cancel_at_period_end: true, updated_at: new Date().toISOString() })
        .eq('workspace_id', event.workspaceId);
      break;
    }

    case 'payment_failed':
    case 'invoice_failed': {
      await supabase.from('workspace_subscriptions')
        .update({ status: 'past_due', updated_at: new Date().toISOString() })
        .eq('workspace_id', event.workspaceId);
      break;
    }

    case 'refund_processed': {
      if (event.providerPaymentId) {
        await supabase.from('billing_payments')
          .update({ status: 'refunded' })
          .eq('provider_payment_id', event.providerPaymentId);
      }
      break;
    }
  }

  // Every provider-driven subscription transition is an entitlement change:
  // funnel it so the cache is cleared and KB catch-up is enqueued exactly
  // once per event, on grants as well as on downgrades.
  const ENTITLEMENT_CHANGING: Record<string, EntitlementChangeSource | undefined> = {
    checkout_completed: 'subscription_created',
    subscription_created: 'subscription_created',
    payment_succeeded: 'payment_succeeded',
    invoice_paid: 'subscription_renewed',
    subscription_canceled: 'subscription_canceled',
    payment_failed: 'provider_webhook',
    invoice_failed: 'provider_webhook',
  };
  const changeSource = ENTITLEMENT_CHANGING[event.type];
  if (changeSource) {
    await handleWorkspaceEntitlementChanged(
      { supabaseUrl, supabaseServiceRoleKey: serviceRoleKey } as ServerConfig,
      { workspaceId: event.workspaceId, source: changeSource },
    );
  }
}

/**
 * Check if a workspace has access to a feature based on plan entitlements
 */
export async function checkEntitlement(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  feature: string
): Promise<{ allowed: boolean; limit?: number; used?: number }> {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Get workspace subscription
  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('plan_id, status')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub || !['active', 'trialing'].includes(sub.status || '')) {
    // Check free plan entitlements
    const { data: freePlan } = await supabase
      .from('billing_plans')
      .select('entitlements, limits')
      .eq('slug', 'free')
      .maybeSingle();

    if (!freePlan) return { allowed: false }; // FAIL-CLOSED: no plans = deny

    const entitlements = freePlan.entitlements as Record<string, boolean> || {};
    const limits = freePlan.limits as Record<string, number> || {};

    if (feature in entitlements) return { allowed: entitlements[feature] };
    if (feature in limits) return { allowed: true, limit: limits[feature] };
    return { allowed: false }; // FAIL-CLOSED: feature not in plan = deny
  }

  // Get plan entitlements
  const { data: plan } = await supabase
    .from('billing_plans')
    .select('entitlements, limits')
    .eq('id', sub.plan_id)
    .maybeSingle();

  if (!plan) return { allowed: false }; // FAIL-CLOSED: missing plan = deny

  const entitlements = plan.entitlements as Record<string, boolean> || {};
  const limits = plan.limits as Record<string, number> || {};

  if (feature in entitlements) return { allowed: entitlements[feature] };
  if (feature in limits) return { allowed: true, limit: limits[feature] };
  return { allowed: false }; // FAIL-CLOSED: feature not in plan = deny
}
