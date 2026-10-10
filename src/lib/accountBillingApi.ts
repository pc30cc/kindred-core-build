/**
 * The simple billing's API client (server/routes/billingAccount.ts).
 *
 * The browser only carries money: balances, VAT, totals and what a payment
 * settled are decided by the server.
 */
import { API_BASE } from './apiBase';
import type { BillingProfile } from '../../shared/simpleBilling';
import type { Edition } from '../../shared/edition';

export class AccountApiError extends Error {
  constructor(public code: string, public status: number, public details: unknown, message?: string) {
    super(message || code);
    this.name = 'AccountApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failure = (body ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new AccountApiError(failure.error || `HTTP_${res.status}`, res.status, failure.details ?? null, failure.message);
  }
  return body as T;
}

const base = (workspaceId: string) => `/api/billing/account/${encodeURIComponent(workspaceId)}`;

export interface AccountGateway {
  provider_name: string;
  display_name: Record<string, string>;
  is_test: boolean;
}

export interface AccountPlan {
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

export type BillingInterval = 'monthly' | 'yearly';

export interface PaidPeriod {
  plan_id: string;
  billing_interval: BillingInterval;
  current_period_start: string;
  current_period_end: string;
}

/** A plan with an interval and its price per period (null = not sold that way). */
export interface PlanRef {
  plan_id: string;
  name: string;
  localized: Record<string, unknown>;
  billing_interval: BillingInterval;
  price_minor: number | null;
}

export interface AccountView {
  edition: Edition;
  currency: string;
  balance_minor: number;
  auto_renew: boolean;
  billing_profile: BillingProfile;
  vat_percent: number | null;
  plan: AccountPlan;
  has_account: boolean;
  can_manage: boolean;
  gateways: AccountGateway[];
  /** The paid period running now; null on Free, a trial, or after a plan ran out. */
  paid_period: PaidPeriod | null;
  /** The change scheduled for the end of the period. */
  scheduled_plan: { id: string; name: string; localized: Record<string, unknown>; is_free: boolean } | null;
  scheduled_interval: BillingInterval | null;
  /** Already paid for the next period (early renewal). */
  next_period_prepaid_minor: number | null;
  /** The next period: plan, interval and price. */
  renewal: PlanRef | null;
  /** The paid plan that ran out, still sold: "renew" buys it again. */
  lapsed: PlanRef | null;
  days_left: number | null;
}

export interface PlanOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  localized: Record<string, unknown>;
  is_free: boolean;
  sort_order: number;
  limits: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  price_monthly_minor: number | null;
  price_yearly_minor: number | null;
}

export type QuoteKind = 'purchase' | 'upgrade' | 'schedule' | 'cancel_change' | 'current' | 'unavailable';

export interface PlanQuote {
  kind: QuoteKind;
  plan_id: string;
  billing_interval: BillingInterval;
  currency: string;
  /** Taken from the balance now. */
  amount_minor: number;
  /** Returned to the balance now, first (a prepaid next period that costs less). */
  returned_minor: number;
  period_price_minor: number | null;
  /** An upgrade's own price for the rest of the period (amount_minor adds a prepaid next period's re-price). */
  upgrade_cost_minor: number | null;
  effective_at: string | null;
  /** The end of the running paid period, where a next period starts. */
  period_end: string | null;
  months_left: number | null;
  balance_minor: number;
  shortfall_minor: number;
  /** The next period already paid for, and its price after this choice. */
  prepaid_minor: number | null;
  next_period_price_minor: number | null;
  auto_renew: boolean;
  next_period_option: boolean;
  /** "From the next period" on an upgrade: what that change takes and returns now. */
  next_period_amount_minor: number;
  next_period_returned_minor: number;
  reason?: string;
}

/** What the quoted action takes from the balance now, net of what it returns first (sent back as expectedNetMinor). */
export function quoteNet(quote: PlanQuote, option: 'now' | 'next_period' = 'now'): number {
  return option === 'next_period' && quote.kind === 'upgrade'
    ? quote.next_period_amount_minor - quote.next_period_returned_minor
    : quote.amount_minor - quote.returned_minor;
}

export type PlanResult = Record<string, unknown> & { action?: string };

export interface LedgerEntry {
  id: string;
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
  buyer: Record<string, string> | null;
  seller: Record<string, string> | null;
  description: Record<string, unknown>;
  created_at: string;
  plan_name?: string | null;
  plan_localized?: Record<string, unknown> | null;
}

export interface LedgerPage {
  items: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClientCheckout {
  provider: string;
  [key: string]: unknown;
}

export interface TopupStarted {
  success: true;
  paymentId: string;
  provider: string;
  purpose?: string;
  currency: string;
  net_minor: number;
  tax_minor: number;
  amount_minor: number;
  paymentUrl?: string;
  clientCheckout?: ClientCheckout;
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

export interface PaymentStatus {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'expired';
  purpose: string;
  currency: string;
  amount_minor: number;
  net_minor: number;
  tax_minor: number;
  ledger_id: string | null;
  failure_reason: string | null;
  purpose_result?: Record<string, unknown> | null;
}

export const accountBillingApi = {
  view: (workspaceId: string) => request<AccountView>(base(workspaceId)),
  ledger: (workspaceId: string, page = 1, pageSize = 20) =>
    request<LedgerPage>(`${base(workspaceId)}/ledger?page=${page}&pageSize=${pageSize}`),
  receipt: (workspaceId: string, ledgerId: string) =>
    request<{ receipt: LedgerEntry }>(`${base(workspaceId)}/receipts/${encodeURIComponent(ledgerId)}`),
  saveProfile: (workspaceId: string, profile: BillingProfile) =>
    request<{ billing_profile: BillingProfile }>(`${base(workspaceId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ profile }),
    }),
  topup: (workspaceId: string, input: { amountMinor: number; currency: string; providerName?: string; callbackUrl: string }) =>
    request<TopupStarted>(`${base(workspaceId)}/topup`, { method: 'POST', body: JSON.stringify(input) }),
  verify: (workspaceId: string, paymentId: string, provider: string, params: Record<string, string>) =>
    request<VerifyOutcome>(`${base(workspaceId)}/payments/${encodeURIComponent(paymentId)}/verify`, {
      method: 'POST',
      body: JSON.stringify({ provider, params }),
    }),
  payment: (workspaceId: string, paymentId: string) =>
    request<PaymentStatus>(`${base(workspaceId)}/payments/${encodeURIComponent(paymentId)}`),
  plans: (workspaceId: string) => request<{ currency: string; plans: PlanOption[] }>(`${base(workspaceId)}/plans`),
  quote: (workspaceId: string, planId: string, interval: BillingInterval) =>
    request<PlanQuote>(`${base(workspaceId)}/quote?planId=${encodeURIComponent(planId)}&interval=${interval}`),
  buyPlan: (workspaceId: string, input: { planId: string; interval: BillingInterval; key: string; expectedNetMinor?: number }) =>
    request<PlanResult>(`${base(workspaceId)}/plan`, { method: 'POST', body: JSON.stringify(input) }),
  /** `expectedPeriodEnd`: the period end the page showed; once that period is renewed, a second click renews nothing. */
  renew: (workspaceId: string, expectedPeriodEnd?: string | null) =>
    request<PlanResult>(`${base(workspaceId)}/renew`, {
      method: 'POST',
      body: JSON.stringify(expectedPeriodEnd ? { expectedPeriodEnd } : {}),
    }),
  upgrade: (workspaceId: string, planId: string, expectedNetMinor?: number) =>
    request<PlanResult>(`${base(workspaceId)}/upgrade`, { method: 'POST', body: JSON.stringify({ planId, expectedNetMinor }) }),
  change: (workspaceId: string, planId: string, interval: BillingInterval | null, expectedNetMinor?: number) =>
    request<PlanResult>(`${base(workspaceId)}/change`, {
      method: 'POST',
      body: JSON.stringify({ planId, interval, expectedNetMinor }),
    }),
  setAutoRenew: (workspaceId: string, enabled: boolean) =>
    request<{ auto_renew: boolean }>(`${base(workspaceId)}/auto-renew`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  checkout: (
    workspaceId: string,
    input: {
      purpose: 'plan' | 'renewal' | 'upgrade';
      planId?: string;
      interval?: BillingInterval;
      currency: string;
      providerName?: string;
      callbackUrl: string;
      expectedNetMinor?: number;
    },
  ) => request<TopupStarted>(`${base(workspaceId)}/checkout`, { method: 'POST', body: JSON.stringify(input) }),
};
