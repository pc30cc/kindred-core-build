// ============================================
// PAYMENT INTENTS — server-authoritative checkout amount/purpose.
//
// Checkout amount and purpose (which plan/interval, or an AI-credit top-up)
// must NEVER be trusted from the client. A payment intent is created here
// BEFORE the provider redirect, from server-known prices/config, and
// verify-callback re-reads the SAME row instead of trusting anything the
// browser sends back.
// ============================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type PurchaseType = 'subscription' | 'ai_credit_topup';
export type IntentStatus = 'pending' | 'succeeded' | 'failed' | 'expired' | 'canceled';

export interface PaymentIntentRow {
  id: string;
  workspace_id: string;
  purchase_type: PurchaseType;
  plan_id: string | null;
  billing_interval: 'monthly' | 'yearly' | null;
  provider_name: string;
  amount_irr: number;
  status: IntentStatus;
  provider_ref: string | null;
  metadata: Record<string, unknown>;
  expires_at: string;
  succeeded_at: string | null;
  created_at: string;
  updated_at: string;
}

const INTENT_TTL_MS = 30 * 60 * 1000;

/** Iranian one-time gateways: their checkout amount is fully server-derived. */
export const IRAN_PROVIDERS = new Set([
  'zarinpal', 'zarinpal_test', 'idpay', 'idpay_test', 'iranpardakht_sandbox',
  'nextpay', 'payping', 'zibal', 'sep_shaparak',
]);

export async function createSubscriptionIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    planId: string;
    interval: 'monthly' | 'yearly';
    providerName: string;
    amountIrr: number;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .insert({
      workspace_id: input.workspaceId,
      purchase_type: 'subscription',
      plan_id: input.planId,
      billing_interval: input.interval,
      provider_name: input.providerName,
      amount_irr: input.amountIrr,
      metadata: input.metadata || {},
      expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'Failed to create payment intent');
  return data as PaymentIntentRow;
}

export async function createAiCreditTopupIntent(
  config: ServerConfig,
  input: {
    workspaceId: string;
    providerName: string;
    amountIrr: number;
    metadata?: Record<string, unknown>;
  },
): Promise<PaymentIntentRow> {
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .insert({
      workspace_id: input.workspaceId,
      purchase_type: 'ai_credit_topup',
      provider_name: input.providerName,
      amount_irr: input.amountIrr,
      metadata: input.metadata || {},
      expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message || 'Failed to create payment intent');
  return data as PaymentIntentRow;
}

export async function getPaymentIntent(
  config: ServerConfig,
  intentId: string,
): Promise<PaymentIntentRow | null> {
  const supabase = getServiceClient(config);
  const { data } = await supabase
    .from('billing_payment_intents')
    .select('*')
    .eq('id', intentId)
    .maybeSingle();
  return (data as PaymentIntentRow | null) ?? null;
}

export async function setPaymentIntentProviderRef(
  config: ServerConfig,
  intentId: string,
  providerRef: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  await supabase
    .from('billing_payment_intents')
    .update({ provider_ref: providerRef, updated_at: new Date().toISOString() })
    .eq('id', intentId);
}

/**
 * Atomically claims a pending intent for finalization. Resolves `true`
 * exactly once — a replayed verify-callback (double-click, provider retry)
 * loses the `status = 'pending'` race and gets `false` without re-applying
 * any financial side effect.
 */
export async function claimPaymentIntent(
  config: ServerConfig,
  intentId: string,
): Promise<boolean> {
  const supabase = getServiceClient(config);
  const { data, error } = await supabase
    .from('billing_payment_intents')
    .update({ status: 'succeeded', succeeded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

export async function markPaymentIntentFailed(
  config: ServerConfig,
  intentId: string,
): Promise<void> {
  const supabase = getServiceClient(config);
  await supabase
    .from('billing_payment_intents')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('status', 'pending');
}

export function isIntentUsable(intent: PaymentIntentRow): boolean {
  return intent.status === 'pending' && new Date(intent.expires_at).getTime() > Date.now();
}
