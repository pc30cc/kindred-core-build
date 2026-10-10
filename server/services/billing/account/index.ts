// ============================================================================
// SIMPLE BILLING — prepaid accounts (docs/billing/SIMPLE_BILLING.md).
//
// A workspace has one account with a balance in one fixed currency. Money
// comes in through a gateway (a top-up, or a payment for a purchase) and is
// settled by ONE SQL function (billing_account_settle_payment, migration 259)
// that credits the net amount and writes the receipt in the same transaction.
//
// Nothing here trusts the browser for an amount: the payment row is created
// from server-known numbers before the redirect, and the gateway's own answer
// (verifyPayment, or its signed webhook) is compared with that row.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getProvider } from '../index.js';
import { getPlatformEdition } from '../../platformRegion.js';
import { getBillingRegion } from '../edition.js';
import { assignedPlanApplies } from '../planSelection.js';
import { normalizeCurrencyCode } from '../providers/minorAmount.js';
import {
  ALREADY_VERIFIED_STATUS,
  buildBoundVerifyParams,
  providerRefMatchesIntent,
} from '../gatewayVerification.js';
import { requiresReferenceBinding } from '../providerBinding.js';
import type { BillingProviderConfig, WebhookEvent } from '../types.js';
import type { Edition } from '../../../../shared/edition.js';
import {
  BILLING_PROFILE_KEYS,
  SELLER_KEYS,
  cleanProfile,
  vatPercentFor,
  type AccountPaymentStatus,
  type BillingProfile,
  type SellerProfile,
} from '../../../../shared/simpleBilling.js';

export class AccountBillingError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details: Record<string, unknown> | null = null,
  ) {
    super(code);
    this.name = 'AccountBillingError';
  }
}

export interface BillingSettingsRow {
  edition: Edition;
  seller: SellerProfile;
  vat_percent: Record<string, unknown>;
  receipt_prefix: string;
  ai_packs: Record<string, unknown>;
}

export interface AccountRow {
  workspace_id: string;
  currency: string;
  balance_minor: number;
  auto_renew: boolean;
  scheduled_plan_id: string | null;
  scheduled_interval: string | null;
  next_period_prepaid_minor: number | null;
  card_provider: string | null;
  billing_profile: BillingProfile;
  created_at: string;
  updated_at: string;
}

export interface AccountPaymentRow {
  id: string;
  workspace_id: string;
  provider: string;
  currency: string;
  amount_minor: number;
  net_minor: number;
  tax_minor: number;
  tax_percent: number | null;
  purpose: string;
  purpose_detail: Record<string, unknown>;
  status: AccountPaymentStatus;
  provider_ref: string | null;
  provider_payment_id: string | null;
  failure_reason: string | null;
  ledger_id: string | null;
  return_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface LedgerRow {
  id: string;
  workspace_id: string;
  kind: string;
  amount_minor: number;
  balance_after: number;
  currency: string;
  plan_id: string | null;
  billing_interval: string | null;
  period_start: string | null;
  period_end: string | null;
  payment_id: string | null;
  receipt_number: string | null;
  net_minor: number | null;
  tax_minor: number | null;
  tax_percent: number | null;
  buyer: Record<string, unknown> | null;
  seller: Record<string, unknown> | null;
  description: Record<string, unknown>;
  created_at: string;
}

/** How long a gateway attempt may still be paid: an Iranian redirect is minutes, a card checkout up to 45. */
export const ACCOUNT_PAYMENT_TTL_MS = 60 * 60 * 1000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toAccount(row: Record<string, unknown>): AccountRow {
  return {
    workspace_id: String(row.workspace_id),
    currency: String(row.currency),
    balance_minor: num(row.balance_minor),
    auto_renew: row.auto_renew === true,
    scheduled_plan_id: (row.scheduled_plan_id as string | null) ?? null,
    scheduled_interval: (row.scheduled_interval as string | null) ?? null,
    next_period_prepaid_minor: row.next_period_prepaid_minor === null || row.next_period_prepaid_minor === undefined
      ? null
      : num(row.next_period_prepaid_minor),
    card_provider: (row.card_provider as string | null) ?? null,
    billing_profile: cleanProfile(row.billing_profile, BILLING_PROFILE_KEYS),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

function toPayment(row: Record<string, unknown>): AccountPaymentRow {
  return {
    ...(row as unknown as AccountPaymentRow),
    amount_minor: num(row.amount_minor),
    net_minor: num(row.net_minor),
    tax_minor: num(row.tax_minor),
    tax_percent: row.tax_percent === null || row.tax_percent === undefined ? null : num(row.tax_percent),
    purpose_detail: asRecord(row.purpose_detail),
  };
}

function toLedger(row: Record<string, unknown>): LedgerRow {
  return {
    ...(row as unknown as LedgerRow),
    amount_minor: num(row.amount_minor),
    balance_after: num(row.balance_after),
    net_minor: row.net_minor === null || row.net_minor === undefined ? null : num(row.net_minor),
    tax_minor: row.tax_minor === null || row.tax_minor === undefined ? null : num(row.tax_minor),
    tax_percent: row.tax_percent === null || row.tax_percent === undefined ? null : num(row.tax_percent),
    description: asRecord(row.description),
  };
}

function dbError(e: { message?: string } | null | undefined, fallback: string): never {
  throw new Error(e?.message || fallback);
}

// ─── Settings ──────────────────────────────────────────────────────────────

/** The running edition's billing settings; an edition with no row yet has empty ones. */
export async function getBillingSettings(config: ServerConfig, edition?: Edition): Promise<BillingSettingsRow> {
  const ed = edition ?? (await getPlatformEdition(config));
  const { data, error } = await getServiceClient(config)
    .from('billing_settings')
    .select('edition, seller, vat_percent, receipt_prefix, ai_packs')
    .eq('edition', ed)
    .maybeSingle();
  if (error) dbError(error, 'billing settings read failed');
  const row = asRecord(data);
  return {
    edition: ed,
    seller: cleanProfile(row.seller, SELLER_KEYS),
    vat_percent: asRecord(row.vat_percent),
    receipt_prefix: typeof row.receipt_prefix === 'string' && row.receipt_prefix ? row.receipt_prefix : 'R',
    ai_packs: asRecord(row.ai_packs),
  };
}

// ─── Accounts ──────────────────────────────────────────────────────────────

export async function readAccount(config: ServerConfig, workspaceId: string): Promise<AccountRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) dbError(error, 'billing account read failed');
  return data ? toAccount(data as Record<string, unknown>) : null;
}

/** The account, created on first use in the region's currency (an existing one keeps its own). */
export async function ensureAccount(config: ServerConfig, workspaceId: string): Promise<AccountRow> {
  const existing = await readAccount(config, workspaceId);
  if (existing) return existing;
  const { currency } = await getBillingRegion(config);
  const { data, error } = await getServiceClient(config).rpc('billing_account_ensure', {
    p_workspace_id: workspaceId,
    p_currency: currency,
  });
  if (error) dbError(error, 'billing account create failed');
  const row = Array.isArray(data) ? data[0] : data;
  return toAccount(asRecord(row));
}

/** The currency this workspace pays in: its account's, else the region's. */
export async function accountCurrency(config: ServerConfig, workspaceId: string): Promise<string> {
  const account = await readAccount(config, workspaceId);
  if (account) return account.currency;
  return (await getBillingRegion(config)).currency;
}

export async function updateBillingProfile(
  config: ServerConfig,
  workspaceId: string,
  profile: unknown,
): Promise<AccountRow> {
  await ensureAccount(config, workspaceId);
  const clean = cleanProfile(profile, BILLING_PROFILE_KEYS);
  const { data, error } = await getServiceClient(config)
    .from('billing_accounts')
    .update({ billing_profile: clean, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select('*')
    .single();
  if (error) dbError(error, 'billing profile update failed');
  return toAccount(data as Record<string, unknown>);
}

// ─── What the workspace sees ──────────────────────────────────────────────

export interface AccountPlanView {
  plan_id: string | null;
  slug: string | null;
  name: string | null;
  localized: Record<string, unknown>;
  is_free: boolean;
  status: string | null;
  billing_interval: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
}

/** The plan the workspace is on now (Free when its subscription no longer applies). */
export async function currentPlanView(config: ServerConfig, workspaceId: string): Promise<AccountPlanView> {
  const sb = getServiceClient(config);
  const { data: sub, error: subError } = await sb
    .from('workspace_subscriptions')
    .select('plan_id, status, billing_interval, current_period_start, current_period_end, trial_end, free_fallback_at, cancel_at_period_end')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (subError) dbError(subError, 'subscription read failed');
  const applies = assignedPlanApplies(sub as Parameters<typeof assignedPlanApplies>[0]);
  const query = sb.from('billing_plans').select('id, slug, name, localized, is_free');
  const { data: plan, error: planError } = applies
    ? await query.eq('id', (sub as { plan_id: string }).plan_id).maybeSingle()
    : await query.eq('slug', 'free').eq('is_active', true).maybeSingle();
  if (planError) dbError(planError, 'plan read failed');
  const p = asRecord(plan);
  const s = asRecord(sub);
  return {
    plan_id: (p.id as string) ?? null,
    slug: (p.slug as string) ?? null,
    name: (p.name as string) ?? null,
    localized: asRecord(p.localized),
    is_free: p.is_free === true,
    status: applies ? ((s.status as string) ?? null) : null,
    billing_interval: applies ? ((s.billing_interval as string) ?? null) : null,
    current_period_start: applies ? ((s.current_period_start as string) ?? null) : null,
    current_period_end: applies ? ((s.current_period_end as string) ?? null) : null,
    trial_end: applies ? ((s.trial_end as string) ?? null) : null,
  };
}

export interface AccountView {
  edition: Edition;
  currency: string;
  balance_minor: number;
  auto_renew: boolean;
  billing_profile: BillingProfile;
  vat_percent: number | null;
  plan: AccountPlanView;
  has_account: boolean;
}

export async function getAccountView(config: ServerConfig, workspaceId: string): Promise<AccountView> {
  const [account, region, plan] = await Promise.all([
    readAccount(config, workspaceId),
    getBillingRegion(config),
    currentPlanView(config, workspaceId),
  ]);
  const currency = account?.currency ?? region.currency;
  const settings = await getBillingSettings(config, region.edition);
  return {
    edition: region.edition,
    currency,
    balance_minor: account?.balance_minor ?? 0,
    auto_renew: account?.auto_renew ?? false,
    billing_profile: account?.billing_profile ?? {},
    vat_percent: vatPercentFor(settings.vat_percent, currency),
    plan,
    has_account: Boolean(account),
  };
}

export async function listLedger(
  config: ServerConfig,
  workspaceId: string,
  page: { page: number; pageSize: number },
): Promise<{ items: LedgerRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(Math.trunc(page.pageSize) || 20, 1), 100);
  const current = Math.max(Math.trunc(page.page) || 1, 1);
  const from = (current - 1) * pageSize;
  const { data, error, count } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) dbError(error, 'ledger read failed');
  return {
    items: ((data as Record<string, unknown>[] | null) ?? []).map(toLedger),
    total: count ?? 0,
    page: current,
    pageSize,
  };
}

/** One ledger row of this workspace that carries a receipt, or null. */
export async function getReceipt(config: ServerConfig, workspaceId: string, ledgerId: string): Promise<LedgerRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('*')
    .eq('id', ledgerId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) dbError(error, 'receipt read failed');
  if (!data) return null;
  const row = toLedger(data as Record<string, unknown>);
  return row.receipt_number ? row : null;
}

// ─── Gateway attempts ──────────────────────────────────────────────────────

export async function createAccountPayment(
  config: ServerConfig,
  input: {
    workspaceId: string;
    provider: string;
    currency: string;
    netMinor: number;
    taxMinor: number;
    taxPercent: number | null;
    purpose?: string;
    purposeDetail?: Record<string, unknown>;
    createdBy: string | null;
  },
): Promise<AccountPaymentRow> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .insert({
      workspace_id: input.workspaceId,
      provider: input.provider,
      currency: input.currency,
      amount_minor: input.netMinor + input.taxMinor,
      net_minor: input.netMinor,
      tax_minor: input.taxMinor,
      tax_percent: input.taxPercent,
      purpose: input.purpose ?? 'topup',
      purpose_detail: input.purposeDetail ?? {},
      status: 'pending',
      created_by: input.createdBy,
    })
    .select('*')
    .single();
  if (error) dbError(error, 'payment create failed');
  return toPayment(data as Record<string, unknown>);
}

export async function readAccountPayment(config: ServerConfig, paymentId: string): Promise<AccountPaymentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return null;
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .select('*')
    .eq('id', paymentId)
    .maybeSingle();
  if (error) dbError(error, 'payment read failed');
  return data ? toPayment(data as Record<string, unknown>) : null;
}

export async function patchAccountPayment(
  config: ServerConfig,
  paymentId: string,
  patch: Partial<Pick<AccountPaymentRow, 'provider_ref' | 'return_url' | 'status' | 'failure_reason'>>,
  onlyIfStatus?: AccountPaymentStatus,
): Promise<void> {
  let query = getServiceClient(config)
    .from('billing_account_payments')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', paymentId);
  if (onlyIfStatus) query = query.eq('status', onlyIfStatus);
  const { error } = await query;
  if (error) dbError(error, 'payment update failed');
}

/** Ends a pending attempt that did not succeed. A succeeded payment is never touched. */
export async function failAccountPayment(
  config: ServerConfig,
  paymentId: string,
  status: Exclude<AccountPaymentStatus, 'pending' | 'succeeded'>,
  reason: string,
): Promise<void> {
  await patchAccountPayment(config, paymentId, { status, failure_reason: reason.slice(0, 500) }, 'pending');
}

export function isAccountPaymentLapsed(payment: Pick<AccountPaymentRow, 'created_at'>, now = Date.now()): boolean {
  const at = Date.parse(payment.created_at);
  return Number.isFinite(at) && now - at > ACCOUNT_PAYMENT_TTL_MS;
}

export interface SettleResult {
  replayed: boolean;
  ledger_id: string;
  payment_id: string;
  receipt_number?: string;
  balance_minor?: number;
}

/** Credits a payment the gateway confirmed (amount and currency as the GATEWAY reported them). */
export async function settleAccountPayment(
  config: ServerConfig,
  input: { paymentId: string; amountMinor: number; currency: string; providerPaymentId?: string | null },
): Promise<SettleResult> {
  const { data, error } = await getServiceClient(config).rpc('billing_account_settle_payment', {
    p_payment_id: input.paymentId,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_provider_payment_id: input.providerPaymentId ?? null,
  });
  if (error) {
    const message = error.message || '';
    if (message.includes('billing_payment_amount_mismatch')) throw new AccountBillingError('PAYMENT_AMOUNT_MISMATCH', 409);
    if (message.includes('currency_mismatch')) throw new AccountBillingError('PAYMENT_CURRENCY_MISMATCH', 409);
    dbError(error, 'payment settlement failed');
  }
  return asRecord(data) as unknown as SettleResult;
}

// ─── Confirming a payment with the gateway ───────────────────────────────

export interface VerifyOutcome {
  status: 'succeeded' | 'pending' | 'failed';
  reason?: string;
  ledgerId?: string | null;
  receiptNumber?: string | null;
  balanceMinor?: number;
}

async function succeededOutcome(config: ServerConfig, payment: AccountPaymentRow): Promise<VerifyOutcome> {
  let receiptNumber: string | null = null;
  let balance: number | undefined;
  if (payment.ledger_id) {
    const { data } = await getServiceClient(config)
      .from('billing_account_ledger')
      .select('receipt_number, balance_after')
      .eq('id', payment.ledger_id)
      .maybeSingle();
    const row = asRecord(data);
    receiptNumber = (row.receipt_number as string) ?? null;
    balance = row.balance_after === undefined ? undefined : num(row.balance_after);
  }
  return { status: 'succeeded', ledgerId: payment.ledger_id, receiptNumber, balanceMinor: balance };
}

/**
 * The customer came back from the gateway: ask the gateway about exactly the
 * checkout bound to this payment (the STORED reference, the SERVER amount),
 * and settle when it confirms the full amount in the payment's currency.
 *
 *   - a callback naming another checkout fails nothing and settles nothing;
 *   - "not paid yet" stays pending (the customer may still pay); only a
 *     definitive cancel/fail ends the attempt;
 *   - an "already verified" answer settles only a payment the gateway itself
 *     reports with the full amount (Iranian gateways repeat the amount).
 */
export async function verifyAccountPayment(
  config: ServerConfig,
  input: {
    payment: AccountPaymentRow;
    providerConfig: BillingProviderConfig;
    params: unknown;
  },
): Promise<VerifyOutcome> {
  const { payment } = input;
  if (payment.status === 'succeeded') return succeededOutcome(config, payment);

  const provider = getProvider(payment.provider);
  if (!provider?.verifyPayment) return { status: 'pending', reason: 'webhook_only' };

  const bindable = { provider_name: payment.provider, provider_ref: payment.provider_ref };
  const binding = providerRefMatchesIntent(bindable, input.params);
  if (binding.ok === false) return { status: 'failed', reason: 'REFERENCE_MISMATCH' };

  const result = await provider.verifyPayment(
    input.providerConfig,
    buildBoundVerifyParams(bindable, input.params, payment.amount_minor),
  );

  if (!result.verified) {
    const status = result.status || 'pending';
    if (payment.status === 'pending' && (status === 'canceled' || status === 'failed' || status === 'expired')) {
      await failAccountPayment(config, payment.id, status === 'canceled' ? 'canceled' : 'failed', `gateway_${status}`);
      return { status: 'failed', reason: `gateway_${status}` };
    }
    if (payment.status !== 'pending') return { status: 'failed', reason: payment.failure_reason || payment.status };
    return { status: 'pending' };
  }

  const confirmed = typeof result.amount === 'number' && Number.isFinite(result.amount) ? result.amount : null;
  if (confirmed === null) {
    // "Already verified" without an amount (a second return to an Iranian
    // gateway): nothing proves this attempt's money from here. A settled
    // payment was answered above; anything else waits for review.
    console.error(`[billing-account] REVIEW payment=${payment.id} provider=${payment.provider} verified without an amount (status ${result.status ?? '-'})`);
    return { status: result.status === ALREADY_VERIFIED_STATUS ? 'pending' : 'failed', reason: 'gateway_amount_missing' };
  }
  // Iranian gateways answer in Rial without naming it; card gateways name it.
  const currency = normalizeCurrencyCode(result.currency) || payment.currency;
  if (confirmed !== payment.amount_minor || currency !== payment.currency) {
    console.warn(`[billing-account] payment=${payment.id} provider=${payment.provider} gateway amount ${confirmed} ${currency} != ${payment.amount_minor} ${payment.currency}`);
    if (payment.status === 'pending') {
      await failAccountPayment(config, payment.id, 'failed', 'gateway_amount_mismatch');
    }
    return { status: 'failed', reason: 'PAYMENT_AMOUNT_MISMATCH' };
  }

  const settled = await settleAccountPayment(config, {
    paymentId: payment.id,
    amountMinor: confirmed,
    currency,
    providerPaymentId: result.paymentId || result.providerRef || null,
  });
  return {
    status: 'succeeded',
    ledgerId: settled.ledger_id,
    receiptNumber: settled.receipt_number ?? null,
    balanceMinor: settled.balance_minor,
  };
}

/**
 * A signed provider webhook named one of our payments (its custom metadata
 * carries the payment id where invoices carry an intent id). Only a payment
 * event of this provider, for this workspace, in the full amount settles it.
 */
export async function handleAccountPaymentWebhook(
  config: ServerConfig,
  input: { providerName: string; workspaceId: string; event: WebhookEvent; payment: AccountPaymentRow },
): Promise<'settled' | 'replayed' | 'ignored' | 'mismatch'> {
  const { payment, event } = input;
  if (payment.workspace_id !== input.workspaceId || payment.provider !== input.providerName) {
    throw new AccountBillingError('WEBHOOK_PAYMENT_MISMATCH', 400);
  }
  if (event.type !== 'payment_succeeded') return 'ignored';
  if (payment.status === 'succeeded') return 'replayed';
  const amount = typeof event.amount === 'number' && Number.isFinite(event.amount) ? event.amount : null;
  const currency = normalizeCurrencyCode(event.currency) || '';
  if (amount === null || amount !== payment.amount_minor || currency !== payment.currency) {
    // Retrying cannot change what the provider reports: acknowledged, never
    // credited, and logged for review (the money is real but not this amount).
    console.error(`[billing-account] REVIEW webhook payment=${payment.id} provider=${payment.provider} amount ${amount} ${currency} != ${payment.amount_minor} ${payment.currency}`);
    return 'mismatch';
  }
  const settled = await settleAccountPayment(config, {
    paymentId: payment.id,
    amountMinor: amount,
    currency,
    providerPaymentId: event.providerPaymentId || event.providerRef || null,
  });
  return settled.replayed ? 'replayed' : 'settled';
}

/** Whether a provider's checkout must be bound to a reference before it may be reported as open. */
export function accountPaymentNeedsBinding(providerName: string): boolean {
  return requiresReferenceBinding(providerName);
}
