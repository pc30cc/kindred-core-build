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
import { extractProviderRefCandidates, requiresReferenceBinding } from '../providerBinding.js';
import { IRANIAN_PAYMENT_PROVIDERS } from '../../../../shared/edition.js';
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

const IRANIAN = new Set<string>(IRANIAN_PAYMENT_PROVIDERS);

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
  /** The period start a prepayment was made for (migration 261). */
  next_period_start: string | null;
  /** The live saved card (migration 262 keeps them): its gateway, Paddle customer and subscription. */
  card_provider: string | null;
  /** Kept after the card is gone: the next card checkout reuses the Paddle customer. */
  card_customer_id: string | null;
  card_subscription_id: string | null;
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
  /** What spending the payment on its purpose did (migration 261); null for a top-up. */
  purpose_result: Record<string, unknown> | null;
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
  verified_amount_minor: number | null;
  verified_at: string | null;
  refunded_minor: number;
  closed_at: string | null;
  /**
   * Where the payment came from (migration 262): a checkout the customer
   * paid; one that also saved a card (card_setup); a renewal Paddle charged
   * on the card by itself (card_renewal); a charge we asked Paddle for, or
   * one we did not expect (card_charge).
   */
  source: AccountPaymentSource;
  /** The saved card a card payment belongs to. */
  card_id: string | null;
  /** card_charge: when Paddle was asked to charge (from then on it is looked up, never asked again). */
  charge_requested_at: string | null;
  /** Why a card payment was credited but needs a person (amount_mismatch, unexpected_charge:<origin>, …). */
  review: string | null;
}

export type AccountPaymentSource = 'checkout' | 'card_setup' | 'card_renewal' | 'card_charge';

const PAYMENT_SOURCES = new Set<string>(['checkout', 'card_setup', 'card_renewal', 'card_charge']);

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
  /** The plan a plan, renewal or upgrade row paid for (history only). */
  plan_name?: string | null;
  plan_localized?: Record<string, unknown> | null;
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
    next_period_start: (row.next_period_start as string | null) ?? null,
    card_provider: (row.card_provider as string | null) ?? null,
    card_customer_id: (row.card_customer_id as string | null) ?? null,
    card_subscription_id: (row.card_subscription_id as string | null) ?? null,
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
    purpose_result: row.purpose_result && typeof row.purpose_result === 'object'
      ? (row.purpose_result as Record<string, unknown>)
      : null,
    verified_amount_minor: row.verified_amount_minor === null || row.verified_amount_minor === undefined ? null : num(row.verified_amount_minor),
    refunded_minor: num(row.refunded_minor),
    // A row read before migration 262 (or a test double) is a checkout.
    source: PAYMENT_SOURCES.has(String(row.source)) ? (row.source as AccountPaymentSource) : 'checkout',
    card_id: (row.card_id as string | null | undefined) ?? null,
    charge_requested_at: (row.charge_requested_at as string | null | undefined) ?? null,
    review: (row.review as string | null | undefined) ?? null,
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
  const items = ((data as Record<string, unknown>[] | null) ?? []).map(toLedger);
  // The plan each row paid for, by name, so the history says what it was.
  const planIds = [...new Set(items.map((i) => i.plan_id).filter((id): id is string => Boolean(id)))];
  if (planIds.length) {
    const { data: plans } = await getServiceClient(config).from('billing_plans').select('id, name, localized').in('id', planIds);
    const byId = new Map(((plans as Record<string, unknown>[] | null) ?? []).map((p) => [String(p.id), p]));
    for (const item of items) {
      const plan = item.plan_id ? byId.get(item.plan_id) : undefined;
      item.plan_name = plan ? String(plan.name ?? '') : null;
      item.plan_localized = plan ? asRecord(plan.localized) : null;
    }
  }
  return {
    items,
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
    /** A checkout that also saves a card is 'card_setup'; every other checkout the default. */
    source?: Extract<AccountPaymentSource, 'checkout' | 'card_setup'>;
  },
): Promise<AccountPaymentRow> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .insert({
      // Only a card checkout names its source: every other row is the
      // column's default ('checkout'), written exactly as before 262.
      ...(input.source && input.source !== 'checkout' ? { source: input.source } : {}),
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
  patch: Partial<Pick<AccountPaymentRow, 'provider_ref' | 'return_url' | 'status' | 'failure_reason' | 'closed_at'>>,
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
  /** The payment's purpose, and what spending it on that purpose did (migration 261). */
  purpose?: string;
  purpose_result?: Record<string, unknown> | null;
}

function rpcError(error: { message?: string }): never {
  const message = error.message || '';
  if (message.includes('billing_payment_amount_mismatch')) throw new AccountBillingError('PAYMENT_AMOUNT_MISMATCH', 409);
  if (message.includes('currency_mismatch')) throw new AccountBillingError('PAYMENT_CURRENCY_MISMATCH', 409);
  if (message.includes('billing_payment_reference_reused')) throw new AccountBillingError('PAYMENT_REFERENCE_REUSED', 409);
  if (message.includes('billing_payment_not_verified')) throw new AccountBillingError('PAYMENT_NOT_VERIFIED', 409);
  throw new Error(message || 'payment settlement failed');
}

/**
 * Records what the gateway confirmed (amount and currency as the GATEWAY
 * reported them, and its own transaction id) before anything is credited.
 * The transaction id is unique per provider: one real payment can settle
 * only one attempt.
 */
export async function recordAccountPaymentVerification(
  config: ServerConfig,
  input: { paymentId: string; amountMinor: number; currency: string; providerPaymentId: string },
): Promise<void> {
  const { error } = await getServiceClient(config).rpc('billing_account_record_verification', {
    p_payment_id: input.paymentId,
    p_amount_minor: input.amountMinor,
    p_currency: input.currency,
    p_provider_payment_id: input.providerPaymentId,
  });
  if (error) rpcError(error);
}

/** Credits a payment whose confirmation was recorded. Idempotent. */
export async function settleAccountPayment(config: ServerConfig, paymentId: string): Promise<SettleResult> {
  const { data, error } = await getServiceClient(config).rpc('billing_account_settle_payment', { p_payment_id: paymentId });
  if (error) rpcError(error);
  const settled = asRecord(data) as unknown as SettleResult;
  if (!settled.replayed) {
    // The receipt mail, and for a purchase the entitlements and plan mail,
    // after the money is committed; never in the way of the answer.
    void import('./effects.js')
      .then((m) => m.afterAccountSettlement(config, settled))
      .catch((e) => console.warn('[billing-account] after settlement:', e instanceof Error ? e.message : e));
  }
  return settled;
}

/** Records the gateway's confirmation, then credits it. */
async function confirmAndSettle(
  config: ServerConfig,
  payment: AccountPaymentRow,
  confirmed: { amountMinor: number; currency: string; providerPaymentId: string },
): Promise<SettleResult> {
  await recordAccountPaymentVerification(config, { paymentId: payment.id, ...confirmed });
  return settleAccountPayment(config, payment.id);
}

export interface VerifyOutcome {
  status: 'succeeded' | 'pending' | 'failed';
  reason?: string;
  ledgerId?: string | null;
  receiptNumber?: string | null;
  balanceMinor?: number;
  /** A payment for a plan, renewal or upgrade: what spending it did ({ action } or { error }). */
  purpose?: string;
  purposeResult?: Record<string, unknown> | null;
}

/** Adds what the payment was spent on to a success, so the return page can say whether it happened. */
async function withPurpose(config: ServerConfig, paymentId: string, outcome: VerifyOutcome): Promise<VerifyOutcome> {
  if (outcome.status !== 'succeeded') return outcome;
  const payment = await readAccountPayment(config, paymentId).catch(() => null);
  if (!payment || payment.purpose === 'topup') return outcome;
  return { ...outcome, purpose: payment.purpose, purposeResult: payment.purpose_result };
}

async function succeededOutcome(config: ServerConfig, ledgerId: string | null): Promise<VerifyOutcome> {
  let receiptNumber: string | null = null;
  let balance: number | undefined;
  if (ledgerId) {
    const { data } = await getServiceClient(config)
      .from('billing_account_ledger')
      .select('receipt_number, balance_after')
      .eq('id', ledgerId)
      .maybeSingle();
    const row = asRecord(data);
    receiptNumber = (row.receipt_number as string) ?? null;
    balance = row.balance_after === undefined ? undefined : num(row.balance_after);
  }
  return { status: 'succeeded', ledgerId, receiptNumber, balanceMinor: balance };
}

function settledOutcome(settled: SettleResult): VerifyOutcome {
  return {
    status: 'succeeded',
    ledgerId: settled.ledger_id,
    receiptNumber: settled.receipt_number ?? null,
    balanceMinor: settled.balance_minor,
  };
}

/** Card gateways send back their own reference; Iranian gateways must echo ours exactly. */
function isCardGateway(providerName: string): boolean {
  return !IRANIAN.has(providerName);
}

/**
 * The customer came back from the gateway: ask the gateway about exactly the
 * checkout bound to this payment (the STORED reference, the SERVER amount),
 * record its confirmation, then credit it.
 *
 *   - a payment whose confirmation was already recorded is credited from that
 *     record, without asking the gateway again (an Iranian gateway takes the
 *     money at verify; a settlement that failed afterwards is finished here);
 *   - a callback naming another checkout fails nothing and settles nothing; a
 *     card return without any reference is looked up by the stored one;
 *   - "not paid yet" stays pending; only a definitive cancel/fail ends it;
 *   - an "already verified" answer never settles an attempt that has no
 *     recorded confirmation of its own: the gateway transaction may be
 *     another attempt's (SEP / PayPing verify by an unbound reference);
 *   - a gateway transaction already recorded for another payment is refused
 *     (unique per provider): one real payment settles one attempt;
 *   - a charge made on a saved card has no checkout to ask about: an upgrade
 *     charge is looked up on the card's subscription (resolveCardCharge), a
 *     renewal Paddle charged is settled by its own events only.
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
  if (payment.status === 'succeeded') return withPurpose(config, payment.id, await succeededOutcome(config, payment.ledger_id));
  if (payment.source === 'card_charge') {
    // Loaded on use: card.ts imports this module.
    const { resolveCardCharge } = await import('./card.js');
    return resolveCardCharge(config, payment);
  }
  if (payment.source === 'card_renewal' && !payment.verified_at) {
    if (payment.status !== 'pending') return { status: 'failed', reason: payment.failure_reason || payment.status };
    return { status: 'pending', reason: 'card_renewal' };
  }
  if (payment.verified_at) return withPurpose(config, payment.id, settledOutcome(await settleAccountPayment(config, payment.id)));

  const provider = getProvider(payment.provider);
  if (!provider?.verifyPayment) return { status: 'pending', reason: 'webhook_only' };

  const bindable = { provider_name: payment.provider, provider_ref: payment.provider_ref };
  const card = isCardGateway(payment.provider);
  const candidates = extractProviderRefCandidates(payment.provider, input.params);
  if (!(card && candidates.length === 0)) {
    const binding = providerRefMatchesIntent(bindable, input.params);
    if (binding.ok === false) return { status: 'failed', reason: 'REFERENCE_MISMATCH' };
  }

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

  if (result.status === ALREADY_VERIFIED_STATUS) {
    console.error(`[billing-account] REVIEW payment=${payment.id} provider=${payment.provider} gateway says already verified, but this attempt recorded no confirmation`);
    return { status: 'pending', reason: 'gateway_already_verified' };
  }

  const confirmed = typeof result.amount === 'number' && Number.isFinite(result.amount) ? result.amount : null;
  // Iranian gateways answer in Rial without naming it; card gateways name it.
  const currency = normalizeCurrencyCode(result.currency) || payment.currency;
  const gatewayTxn = (result.paymentId || result.providerRef || payment.provider_ref || '').trim();
  if (confirmed === null || confirmed !== payment.amount_minor || currency !== payment.currency || !gatewayTxn) {
    console.error(`[billing-account] REVIEW payment=${payment.id} provider=${payment.provider} gateway ${confirmed} ${currency} ref=${gatewayTxn || '-'} != ${payment.amount_minor} ${payment.currency}`);
    if (payment.status === 'pending') await failAccountPayment(config, payment.id, 'failed', 'gateway_amount_mismatch');
    return { status: 'failed', reason: 'PAYMENT_AMOUNT_MISMATCH' };
  }

  try {
    return withPurpose(
      config,
      payment.id,
      settledOutcome(await confirmAndSettle(config, payment, { amountMinor: confirmed, currency, providerPaymentId: gatewayTxn })),
    );
  } catch (e) {
    if (e instanceof AccountBillingError && e.code === 'PAYMENT_REFERENCE_REUSED') {
      console.error(`[billing-account] REVIEW payment=${payment.id} provider=${payment.provider} gateway transaction ${gatewayTxn} already settled another payment`);
      return { status: 'failed', reason: 'PAYMENT_REFERENCE_REUSED' };
    }
    throw e;
  }
}

/**
 * A signed provider webhook about one of our payments (its custom metadata
 * carries the payment id where invoices carry an intent id, or a refund names
 * its transaction): a payment of this provider and workspace in the full
 * amount is credited; a refund takes its credit back.
 */
export async function handleAccountPaymentWebhook(
  config: ServerConfig,
  input: { providerName: string; workspaceId: string; event: WebhookEvent; payment: AccountPaymentRow },
): Promise<'settled' | 'replayed' | 'refunded' | 'ignored' | 'mismatch'> {
  const { payment, event } = input;
  if (payment.workspace_id !== input.workspaceId || payment.provider !== input.providerName) {
    throw new AccountBillingError('WEBHOOK_PAYMENT_MISMATCH', 400);
  }

  if (event.type === 'refund_processed') {
    // Paddle reports each refund (its adjustment id, its amount); Stripe,
    // PayPal and Lemon Squeezy the running total refunded on the payment, so
    // the new part is that total minus what was already taken back.
    let refundId: string;
    let amount: number | null;
    if (event.refundId) {
      refundId = event.refundId;
      amount = typeof event.amount === 'number' ? event.amount : null;
    } else if (typeof event.refundedTotal === 'number') {
      const refunds = asRecord(payment.purpose_detail.refunds);
      const already = Object.values(refunds).reduce<number>((sum, r) => sum + num(asRecord(r).amount_minor), 0);
      refundId = `total:${event.refundedTotal}`;
      amount = event.refundedTotal - already;
    } else {
      refundId = (event.providerEventId || '').trim();
      amount = typeof event.amount === 'number' ? event.amount : null;
    }
    if (!refundId || amount === null || !Number.isFinite(amount) || amount <= 0) return 'ignored';
    const { data, error } = await getServiceClient(config).rpc('billing_account_refund_payment', {
      p_payment_id: payment.id,
      p_refund_id: refundId,
      p_amount_minor: amount,
    });
    if (error) throw new Error(error.message || 'refund failed');
    const res = asRecord(data);
    if (num(res.shortfall_minor) > 0) {
      console.error(`[billing-account] REVIEW refund payment=${payment.id} provider=${payment.provider} could not take back ${res.shortfall_minor} (already spent)`);
    }
    if (event.chargeback) await afterChargeback(config, payment, refundId, amount);
    return res.replayed === true ? 'replayed' : 'refunded';
  }

  if (event.type !== 'payment_succeeded') return 'ignored';
  // A Paddle transaction is the checkout bound to this payment, or not this
  // payment at all: one a subscription made carries the checkout's intent_id
  // in its copied custom_data, and must never read as a replay of it (P5).
  const reported = (event.providerPaymentId || event.providerRef || '').trim();
  if (CARD_EVENT_PROVIDERS.has(payment.provider) && (!reported || reported !== payment.provider_ref)) {
    console.error(`[billing-account] REVIEW webhook payment=${payment.id} provider=${payment.provider} transaction ${reported || '-'} is not its checkout ${payment.provider_ref || '-'}`);
    return 'mismatch';
  }
  if (payment.status === 'succeeded') return 'replayed';
  if (payment.verified_at) {
    const settled = await settleAccountPayment(config, payment.id);
    return settled.replayed ? 'replayed' : 'settled';
  }
  const amount = typeof event.amount === 'number' && Number.isFinite(event.amount) ? event.amount : null;
  const currency = normalizeCurrencyCode(event.currency) || '';
  const gatewayTxn = (event.providerPaymentId || event.providerRef || '').trim();
  if (amount === null || amount !== payment.amount_minor || currency !== payment.currency || !gatewayTxn) {
    // Retrying cannot change what the provider reports: acknowledged, never
    // credited, and logged for review (the money is real but not this amount).
    console.error(`[billing-account] REVIEW webhook payment=${payment.id} provider=${payment.provider} amount ${amount} ${currency} != ${payment.amount_minor} ${payment.currency}`);
    return 'mismatch';
  }
  try {
    const settled = await confirmAndSettle(config, payment, { amountMinor: amount, currency, providerPaymentId: gatewayTxn });
    return settled.replayed ? 'replayed' : 'settled';
  } catch (e) {
    if (e instanceof AccountBillingError && e.code === 'PAYMENT_REFERENCE_REUSED') {
      console.error(`[billing-account] REVIEW webhook payment=${payment.id} transaction ${gatewayTxn} already settled another payment`);
      return 'mismatch';
    }
    throw e;
  }
}

/** Gateways whose transactions can come from a saved card's subscription (phase 3b). */
const CARD_EVENT_PROVIDERS = new Set(['paddle', 'paddle_sandbox']);

/**
 * A chargeback took a payment's money back (recorded above as a refund): the
 * card it came from (the payment's own, else the workspace's live card on the
 * same gateway) stops at once, so nothing more is charged to it, and a person
 * looks at it. The card is marked canceling first (which also turns
 * auto-renew off), so the job retries a cancel Paddle did not confirm. Never
 * throws: the refund is recorded.
 */
async function afterChargeback(config: ServerConfig, payment: AccountPaymentRow, refundId: string, amount: number): Promise<void> {
  console.error(`[billing-account] REVIEW chargeback ${refundId} payment=${payment.id} provider=${payment.provider} ${amount} ${payment.currency} taken back`);
  if (!CARD_EVENT_PROVIDERS.has(payment.provider)) return;
  try {
    // Loaded on use: card.ts imports this module.
    const card = await import('./card.js');
    const live = payment.card_id ? null : await card.readLiveCard(config, payment.workspace_id);
    const cardId = payment.card_id ?? (live && live.provider === payment.provider ? live.id : null);
    if (!cardId) return;
    const { error } = await getServiceClient(config).rpc('billing_card_set_status', {
      p_card_id: cardId,
      p_status: 'canceling',
      p_reason: 'chargeback',
    });
    if (error) throw new Error(error.message || 'card status update failed');
    if (!(await card.cancelCardNow(config, cardId, 'chargeback'))) {
      console.error(`[billing-account] REVIEW chargeback ${refundId}: card ${cardId} not cancelled at Paddle yet (the job retries it)`);
    }
  } catch (e) {
    console.error(`[billing-account] REVIEW chargeback ${refundId}: card not stopped:`, e instanceof Error ? e.message : e);
  }
}

/** The account payment a provider transaction settled (refunds name the transaction, not our id). */
export async function findAccountPaymentByProviderPayment(
  config: ServerConfig,
  providerName: string,
  providerPaymentId: string,
): Promise<AccountPaymentRow | null> {
  if (!providerPaymentId) return null;
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .select('*')
    .eq('provider', providerName)
    .eq('provider_payment_id', providerPaymentId)
    .maybeSingle();
  if (error) dbError(error, 'payment read failed');
  return data ? toPayment(data as Record<string, unknown>) : null;
}

/** A payment the customer opened a checkout for (as opposed to a charge on a saved card). */
export function isCheckoutPayment(payment: Partial<Pick<AccountPaymentRow, 'source'>>): boolean {
  return !payment.source || payment.source === 'checkout' || payment.source === 'card_setup';
}

/** Iranian bank checkouts expire on their own within minutes; card checkouts may stay payable. */
export const SHORT_LIVED_CHECKOUT_PROVIDERS: readonly string[] = IRANIAN_PAYMENT_PROVIDERS;

/**
 * Ends an attempt nobody paid within its window. A card checkout is closed at
 * the provider first (best effort), so it cannot be paid later from an old
 * tab; a confirmed close lets the attempt be pruned after 30 days.
 *
 * Only a checkout expires: a charge on a saved card (an upgrade charge, a
 * renewal Paddle made) has no checkout to close, and Paddle may have taken
 * it; it is resolved by looking it up (card.ts), never ended here.
 */
export async function expireAccountPayment(
  config: ServerConfig,
  payment: AccountPaymentRow,
  providerConfig: BillingProviderConfig | null,
): Promise<void> {
  if (!isCheckoutPayment(payment)) return;
  await failAccountPayment(config, payment.id, 'expired', 'expired');
  const provider = getProvider(payment.provider);
  if (!payment.provider_ref || !provider?.closeCheckout || !providerConfig) return;
  const closed = await provider.closeCheckout(providerConfig, payment.provider_ref).catch(() => false);
  if (closed) await patchAccountPayment(config, payment.id, { closed_at: new Date().toISOString() });
}

/** Whether a provider's checkout must be bound to a reference before it may be reported as open. */
export function accountPaymentNeedsBinding(providerName: string): boolean {
  return requiresReferenceBinding(providerName);
}
