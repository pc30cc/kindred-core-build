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
import { idpayProvider } from './providers/idpay.js';
import { nextpayProvider } from './providers/nextpay.js';
import { paypingProvider } from './providers/payping.js';
import { zibalProvider } from './providers/zibal.js';
import { sepProvider } from './providers/sep.js';
import { iyzicoProvider } from './providers/iyzico.js';
import { paytrProvider } from './providers/paytr.js';
import { sipayProvider } from './providers/sipay.js';
import { paratikaProvider } from './providers/paratika.js';
import { craftgateProvider } from './providers/craftgate.js';

// Provider registry
const providers: Record<string, BillingProviderHandler> = {
  stripe: stripeProvider,
  paddle: paddleProvider,
  lemon_squeezy: lemonSqueezyProvider,
  paypal: paypalProvider,
  zarinpal: zarinpalProvider,
  idpay: idpayProvider,
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

  // 1. Check workspace-level billing provider
  const { data: wsConfig } = await supabase
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'billing')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (wsConfig) {
    const handler = getProvider(wsConfig.provider_name);
    if (handler) return { provider: handler, config: { provider: wsConfig.provider_name, ...(wsConfig.config as Record<string, unknown>) } };
  }

  // 2. Check global default (app_runtime_config)
  const { data: globalConfig } = await supabase
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'billing_default_provider')
    .maybeSingle();

  if (globalConfig?.value) {
    const gc = globalConfig.value as Record<string, unknown>;
    const handler = getProvider(gc.provider as string);
    if (handler) return { provider: handler, config: gc as BillingProviderConfig };
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

/**
 * Process a verified webhook event — update subscription state
 */
export async function processWebhookEvent(
  supabaseUrl: string,
  serviceRoleKey: string,
  providerName: string,
  event: WebhookEvent
) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Log the event
  await logBillingEvent(supabaseUrl, serviceRoleKey, {
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
      await supabase.from('workspace_subscriptions').upsert({
        workspace_id: event.workspaceId,
        provider_name: providerName,
        provider_subscription_id: event.providerSubscriptionId || null,
        provider_customer_id: event.providerCustomerId || null,
        status: 'active',
        plan_id: event.planId || null,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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

    if (!freePlan) return { allowed: true }; // No plans = all features available

    const entitlements = freePlan.entitlements as Record<string, boolean> || {};
    const limits = freePlan.limits as Record<string, number> || {};

    if (feature in entitlements) return { allowed: entitlements[feature] };
    if (feature in limits) return { allowed: true, limit: limits[feature] };
    return { allowed: false };
  }

  // Get plan entitlements
  const { data: plan } = await supabase
    .from('billing_plans')
    .select('entitlements, limits')
    .eq('id', sub.plan_id)
    .maybeSingle();

  if (!plan) return { allowed: true };

  const entitlements = plan.entitlements as Record<string, boolean> || {};
  const limits = plan.limits as Record<string, number> || {};

  if (feature in entitlements) return { allowed: entitlements[feature] };
  if (feature in limits) return { allowed: true, limit: limits[feature] };
  return { allowed: true };
}
