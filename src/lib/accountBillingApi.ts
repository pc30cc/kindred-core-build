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
}

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
  topup: (workspaceId: string, input: { amountMinor: number; providerName?: string; callbackUrl: string }) =>
    request<TopupStarted>(`${base(workspaceId)}/topup`, { method: 'POST', body: JSON.stringify(input) }),
  verify: (workspaceId: string, paymentId: string, provider: string, params: Record<string, string>) =>
    request<VerifyOutcome>(`${base(workspaceId)}/payments/${encodeURIComponent(paymentId)}/verify`, {
      method: 'POST',
      body: JSON.stringify({ provider, params }),
    }),
  payment: (workspaceId: string, paymentId: string) =>
    request<PaymentStatus>(`${base(workspaceId)}/payments/${encodeURIComponent(paymentId)}`),
};
