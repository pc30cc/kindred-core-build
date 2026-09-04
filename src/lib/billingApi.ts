/**
 * Billing Engine V2 — customer (workspace) API client.
 *
 * Every value rendered by the V2 billing screens comes from here. The browser
 * is a RENDERER, not a calculator: prices, periods, proration, allowances,
 * invoice totals, due dates, wallet balances and payability are all decided by
 * the server. Nothing in this module derives money — it only carries it.
 */

import { API_BASE } from './apiBase';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as any)?.error || `API error: ${res.status}`) as Error & {
      status?: number;
      code?: string;
      details?: unknown;
    };
    err.status = res.status;
    err.code = (body as any)?.error;
    err.details = (body as any)?.details;
    throw err;
  }
  return body as T;
}

const base = (workspaceId: string) => `/api/billing/v2/workspaces/${workspaceId}`;

// ─── Shapes (mirror server/services/billing/customer/readModels.ts) ─────────

export interface EntitlementCycleView {
  id: string;
  index: number;
  start: string;
  end: string;
  allowanceIrr: number;
  usedIrr: number;
  remainingIrr: number;
  state: string;
}

export type InvoiceStatus =
  | 'draft'
  | 'open'
  | 'partially_paid'
  | 'paid'
  | 'past_due'
  | 'void'
  | 'expired'
  | 'refunded';

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  invoiceType: string;
  status: InvoiceStatus | string;
  planName: string | null;
  interval: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalIrr: number;
  amountPaidIrr: number;
  amountDueIrr: number;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  /** Paid, but the period it buys starts later — "activates on X", not "active". */
  activatesAt: string | null;
}

export interface BillingOverview {
  engine: 'v1' | 'v2';
  rolloutState: 'legacy' | 'shadow' | 'v2_cutover_pending' | 'v2_active';
  permissions: { manage: boolean };
  subscription: {
    status: string | null;
    planId: string | null;
    planName: string | null;
    interval: 'monthly' | 'yearly' | null;
    isFree: boolean;
    isTrial: boolean;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
  };
  servicePeriod: { id: string; start: string; end: string; interval: string; source: string } | null;
  nextInvoiceAt: string | null;
  pendingPlanChange: {
    type: string;
    planId: string | null;
    planName: string | null;
    effectiveAt: string | null;
    cancelable: boolean;
  } | null;
  aiCycle: EntitlementCycleView | null;
  aiPurchasedRemainingIrr: number;
  aiMonthlyOnAnnual: boolean;
  wallet: { balanceIrr: number; frozen: boolean; autoPayEnabled: boolean };
  upcomingInvoice: InvoiceSummary | null;
  upcomingInvoiceAlert: {
    remindersSent: number;
    remindersTotal: number;
    stage: 0 | 1 | 2 | 3;
    pastDue: boolean;
    suspendAt: string | null;
    daysToSuspend: number | null;
  } | null;

}

export interface InvoiceDetail {
  invoice: InvoiceSummary & { workspaceName: string | null; createdAt: string };
  lines: Array<{
    id: string;
    lineType: string;
    description: string;
    quantity: number;
    unitAmountIrr: number;
    amountIrr: number;
  }>;
  totals: {
    subtotalIrr: number;
    discountIrr: number;
    taxIrr: number;
    totalIrr: number;
    paidIrr: number;
    dueIrr: number;
  };
  actions: {
    payable: boolean;
    canPayWallet: boolean;
    canPayGateway: boolean;
    walletBalanceIrr: number;
    walletShortfallIrr: number;
    blockedReason: string | null;
  };
  collection: { active: boolean; channel: string | null; expiresAt: string | null };
}

export interface WalletView {
  balanceIrr: number;
  frozen: boolean;
  autoPayEnabled: boolean;
  deposit: { presetsIrr: number[]; allowCustom: boolean; minIrr: number; maxIrr: number };
  ledger: {
    entries: Array<{
      id: string;
      entryType: string;
      direction: 'credit' | 'debit';
      amountIrr: number;
      balanceAfterIrr: number;
      createdAt: string;
      reference: string | null;
      referenceKind: 'invoice' | 'deposit' | null;
    }>;
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface PlanCard {
  id: string;
  name: string;
  description: string | null;
  monthlyPriceIrr: number;
  yearlyPriceIrr: number;
  /** Monthly AI allowance — for a yearly contract this is still per month. */
  aiMonthlyAllowanceIrr: number;
  limits: Record<string, unknown>;
  entitlements: Record<string, unknown>;
  features: unknown;
  isFree: boolean;
}

export interface PlansView {
  currentPlanId: string | null;
  currentInterval: 'monthly' | 'yearly' | null;
  pendingPlanId: string | null;
  plans: PlanCard[];
}

export type PlanChangeMode = 'immediate' | 'next_cycle';

export interface PlanChangePreview {
  mode: PlanChangeMode;
  allowedModes: PlanChangeMode[];
  direction: 'upgrade' | 'downgrade' | 'same';
  currentPlan: { id: string | null; name: string | null; interval: 'monthly' | 'yearly' | null };
  targetPlan: { id: string; name: string; interval: 'monthly' | 'yearly'; fullPriceIrr: number };
  amountIrr: number;
  aiCycleDeltaIrr: number;
  aiMonthlyAfterIrr: number;
  remainingMs: number;
  remainingDays: number;
  effectiveAt: string;
  periodEnd: string | null;
  annualMonthlyAllowance: boolean;
}

export interface PlanChangeResult {
  mode: PlanChangeMode;
  invoiceId: string | null;
  invoiceNumber: string | null;
  amountIrr: number;
  effectiveAt: string;
  pending: boolean;
}

export type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'canceled'
  | 'failed'
  | 'expired'
  | 'refunded';

export interface CustomerTransaction {
  id: string;
  /** WebYar proforma/order number — NOT a bank reference. */
  documentNumber: string | null;
  type: string | null;
  purchaseType: 'subscription' | 'ai_credit_topup' | 'wallet_deposit';
  planName: string | null;
  billingInterval: 'monthly' | 'yearly' | null;
  amountIrr: number;
  status: TransactionStatus;
  createdAt: string;
  paidAt: string | null;
  canceledAt: string | null;
  provider: string | null;
  /** Bank tracking code — deliberately distinct from the document number. */
  providerReference: string | null;
  settled: boolean;
  /** Money arrived but is not applied yet: "under review", never a failure. */
  needsReview?: boolean;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export function billingV2Overview(workspaceId: string) {
  return request<BillingOverview>(`${base(workspaceId)}/overview`);
}

export function billingV2Invoices(
  workspaceId: string,
  opts: { filter?: string; page?: number; pageSize?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  params.set('page', String(opts.page ?? 1));
  params.set('pageSize', String(opts.pageSize ?? 10));
  return request<{ invoices: InvoiceSummary[]; page: number; pageSize: number; total: number }>(
    `${base(workspaceId)}/invoices?${params}`,
  );
}

export function billingV2InvoiceDetail(workspaceId: string, invoiceId: string) {
  return request<InvoiceDetail>(`${base(workspaceId)}/invoices/${invoiceId}`);
}

export function billingV2Plans(workspaceId: string) {
  return request<PlansView>(`${base(workspaceId)}/plans`);
}

export function billingV2Wallet(workspaceId: string, opts: { page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams({
    page: String(opts.page ?? 1),
    pageSize: String(opts.pageSize ?? 10),
  });
  return request<WalletView>(`${base(workspaceId)}/wallet?${params}`);
}

export function billingV2Transactions(workspaceId: string, opts: { page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams({
    page: String(opts.page ?? 1),
    pageSize: String(opts.pageSize ?? 10),
  });
  return request<{ transactions: CustomerTransaction[]; page: number; pageSize: number; total: number }>(
    `${base(workspaceId)}/transactions?${params}`,
  );
}

// ─── Writes ────────────────────────────────────────────────────────────────

export function billingV2PayInvoiceFromWallet(workspaceId: string, invoiceId: string) {
  return request<{ success: true; settlement: any; application: any }>(
    `${base(workspaceId)}/invoices/${invoiceId}/pay-wallet`,
    { method: 'POST', body: '{}' },
  );
}

export interface PayableGateway {
  provider_name: string;
  display_name: Record<string, string> | null;
  is_test: boolean;
  currencies: string[];
}

/** Active payment methods for a currency — decided by the platform, not the UI. */
export function billingV2Gateways(workspaceId: string, currency = 'IRR') {
  return request<{ currency: string; gateways: PayableGateway[] }>(
    `${base(workspaceId)}/gateways?currency=${encodeURIComponent(currency)}`,
  );
}

export interface DepositDocument {
  id: string;
  documentNumber: string;
  documentType: 'wallet_deposit';
  amountIrr: number;
  status?: string;
  createdAt: string;
}

export function billingV2DepositDetail(workspaceId: string, depositId: string) {
  return request<{ deposit: DepositDocument }>(`${base(workspaceId)}/wallet/deposits/${depositId}`);
}

export function billingV2InvoiceCheckout(
  workspaceId: string,
  invoiceId: string,
  callbackUrl: string,
  providerName?: string,
) {
  return request<{
    success: true;
    paymentUrl?: string;
    checkoutUrl?: string;
    url?: string;
    intentId: string;
    invoiceNumber: string;
  }>(
    `${base(workspaceId)}/invoices/${invoiceId}/checkout`,
    { method: 'POST', body: JSON.stringify({ callbackUrl, providerName }) },
  );
}

export function billingV2PreviewPlanChange(
  workspaceId: string,
  input: { planId: string; interval: 'monthly' | 'yearly'; mode: PlanChangeMode },
) {
  return request<PlanChangePreview>(`${base(workspaceId)}/plan-change/preview`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * `expectedAmountIrr` is the amount the customer actually saw in the preview.
 * The server refuses the change (409 STALE_PREVIEW) when it no longer matches,
 * so a stale tab can never commit an amount the customer never agreed to.
 */
export function billingV2ApplyPlanChange(
  workspaceId: string,
  input: {
    planId: string;
    interval: 'monthly' | 'yearly';
    mode: PlanChangeMode;
    expectedAmountIrr: number;
  },
) {
  return request<PlanChangeResult>(`${base(workspaceId)}/plan-change`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function billingV2CancelPlanChange(workspaceId: string) {
  return request<{ canceled: boolean }>(`${base(workspaceId)}/plan-change/cancel`, {
    method: 'POST',
    body: '{}',
  });
}

export function billingV2SetAutoPay(workspaceId: string, enabled: boolean) {
  return request<{ autoPayEnabled: boolean }>(`${base(workspaceId)}/wallet/auto-pay`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export function billingV2DepositPreview(workspaceId: string, amountIrr: number) {
  return request<{
    deposit: {
      id: string;
      documentNumber: string;
      documentType: 'wallet_deposit';
      amountIrr: number;
      createdAt: string;
    };
  }>(`${base(workspaceId)}/wallet/deposit/preview`, {
    method: 'POST',
    body: JSON.stringify({ amountIrr }),
  });
}

export function billingV2DepositCheckout(
  workspaceId: string,
  depositId: string,
  callbackUrl: string,
  providerName?: string,
) {
  return request<{ success: true; paymentUrl?: string; checkoutUrl?: string; url?: string; intentId: string; documentNumber: string }>(
    `${base(workspaceId)}/wallet/deposit/checkout`,
    { method: 'POST', body: JSON.stringify({ depositId, callbackUrl, providerName }) },
  );
}

/** AI credit is bought like everything else in V2: an invoice comes first. */
export function billingV2CreateAiCreditInvoice(workspaceId: string, amountIrr: number) {
  return request<{ invoiceId: string; invoiceNumber: string; amountIrr: number }>(
    `${base(workspaceId)}/ai-credit/invoice`,
    { method: 'POST', body: JSON.stringify({ amountIrr }) },
  );
}

/**
 * Stable engine contract (`/api/billing/workspaces/:id/engine`). Read-only:
 * it reports which engine owns the workspace so the UI can pick a screen.
 */
export interface BillingEngineReadModel {
  engine: 'v1' | 'v2';
  rolloutState: 'legacy' | 'shadow' | 'v2_cutover_pending' | 'v2_active';
  subscriptionStatus: string | null;
}

export function billingEngineReadModel(workspaceId: string) {
  return request<BillingEngineReadModel>(`/api/billing/workspaces/${workspaceId}/engine`);
}
