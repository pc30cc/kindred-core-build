/**
 * Super Admin → simple billing API client (server/routes/adminSimpleBilling.ts,
 * mounted at /api/admin/simple-billing; docs/billing/SIMPLE_BILLING.md).
 *
 * The browser only renders what the server decides: every amount is in minor
 * units of its own currency, and the server picks the currency of a credit
 * or debit. React Query hooks live here too; their keys start with
 * `['admin-simple-billing', ...]`.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { API_BASE } from './apiBase';
import type { Edition } from '../../shared/edition';
import type { AiPack } from '../../shared/aiPacks';
import type {
  AccountSort,
  AdjustRequest,
  AdjustResult,
  AdminAccountDetail,
  AdminAccountsPage,
  AdminLedgerEntry,
  AdminLedgerPage,
  AdminPaymentsPage,
  GatewayReadinessReport,
  RevenueReport,
} from '../../shared/simpleBillingAdmin';

export type {
  AccountFilter,
  AccountSort,
  AdjustCategory,
  AdjustErrorCode,
  AdjustRequest,
  AdjustResult,
  AdminAccountDetail,
  AdminAccountRow,
  AdminAccountsPage,
  AdminCardSummary,
  AdminLedgerEntry,
  AdminLedgerPage,
  AdminPaymentRefund,
  AdminPaymentRow,
  AdminPaymentsPage,
  AdminPlanView,
  GatewayListing,
  GatewayListingReason,
  GatewayReadiness,
  GatewayReadinessReport,
  LiabilityRow,
  RevenueLedgerRow,
  RevenueReport,
  RevenueRow,
  RevenueSums,
} from '../../shared/simpleBillingAdmin';
export {
  ACCOUNT_FILTERS,
  ACCOUNT_SORTS,
  ADJUST_CATEGORIES,
  ADJUST_REASON_MAX,
  ADJUST_REASON_MIN,
  adjustAmountProblem,
  monthKeyOf,
} from '../../shared/simpleBillingAdmin';

/** An error answer: `code` is the server's `error` (e.g. BALANCE_CHANGED), `body` the whole answer. */
export class AdminBillingApiError extends Error {
  constructor(public code: string, public status: number, public body: Record<string, unknown>) {
    super(code);
    this.name = 'AdminBillingApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/simple-billing${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    throw new AdminBillingApiError(typeof record.error === 'string' ? record.error : `HTTP_${res.status}`, res.status, record);
  }
  return body as T;
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const ws = (workspaceId: string) => `/accounts/${encodeURIComponent(workspaceId)}`;

// ─── Types of the settings endpoints ───────────────────────────────────────

export interface SimpleBillingSettings {
  edition: Edition;
  seller: Record<string, string>;
  vat_percent: Record<string, number | null>;
  receipt_prefix: string;
  vat_currencies: string[];
  /** The AI credit currencies of this edition (also the plan form's monthly AI credit keys). */
  ai_currencies: string[];
  ai_packs: Record<string, AiPack[]>;
}

export interface SimpleBillingSettingsInput {
  seller: Record<string, string>;
  vat_percent: Record<string, number | null>;
  receipt_prefix: string;
  /** Omit to keep the stored packs. */
  ai_packs?: Record<string, AiPack[]>;
}

export interface AccountsParams {
  q?: string;
  filter?: string;
  currency?: string | null;
  sort?: AccountSort;
  page?: number;
  pageSize?: number;
}

export interface PageParams {
  page?: number;
  pageSize?: number;
}

export interface RevenueParams {
  months?: number;
  includeTest?: boolean;
}

// ─── Calls ─────────────────────────────────────────────────────────────────

export const adminSimpleBillingApi = {
  getSettings: () => request<SimpleBillingSettings>('/settings'),
  putSettings: (input: SimpleBillingSettingsInput) =>
    request<SimpleBillingSettings>('/settings', { method: 'PUT', body: JSON.stringify(input) }),
  listAccounts: (params: AccountsParams = {}) =>
    request<AdminAccountsPage>(`/accounts${query({ ...params })}`),
  getAccount: (workspaceId: string) => request<AdminAccountDetail>(ws(workspaceId)),
  getLedger: (workspaceId: string, params: PageParams = {}) =>
    request<AdminLedgerPage>(`${ws(workspaceId)}/ledger${query({ ...params })}`),
  getPayments: (workspaceId: string, params: PageParams = {}) =>
    request<AdminPaymentsPage>(`${ws(workspaceId)}/payments${query({ ...params })}`),
  getReceipt: (workspaceId: string, ledgerId: string) =>
    request<{ receipt: AdminLedgerEntry }>(`${ws(workspaceId)}/receipts/${encodeURIComponent(ledgerId)}`),
  adjust: (workspaceId: string, input: AdjustRequest) =>
    request<AdjustResult>(`${ws(workspaceId)}/adjust`, { method: 'POST', body: JSON.stringify(input) }),
  getRevenue: (params: RevenueParams = {}) =>
    request<RevenueReport>(`/revenue${query({ months: params.months, includeTest: params.includeTest })}`),
  getGateways: () => request<GatewayReadinessReport>('/gateways'),
};

// ─── React Query hooks ─────────────────────────────────────────────────────

export const adminSimpleBillingKeys = {
  all: ['admin-simple-billing'] as const,
  settings: () => ['admin-simple-billing', 'settings'] as const,
  accounts: (params?: AccountsParams) =>
    (params ? ['admin-simple-billing', 'accounts', params] : ['admin-simple-billing', 'accounts']) as readonly unknown[],
  account: (workspaceId: string) => ['admin-simple-billing', 'account', workspaceId] as const,
  ledger: (workspaceId: string, params?: PageParams) =>
    (params ? ['admin-simple-billing', 'ledger', workspaceId, params] : ['admin-simple-billing', 'ledger', workspaceId]) as readonly unknown[],
  payments: (workspaceId: string, params?: PageParams) =>
    (params ? ['admin-simple-billing', 'payments', workspaceId, params] : ['admin-simple-billing', 'payments', workspaceId]) as readonly unknown[],
  revenue: (params?: RevenueParams) =>
    (params ? ['admin-simple-billing', 'revenue', params] : ['admin-simple-billing', 'revenue']) as readonly unknown[],
  gateways: () => ['admin-simple-billing', 'gateways'] as const,
};

export function useSimpleBillingSettings() {
  return useQuery({ queryKey: adminSimpleBillingKeys.settings(), queryFn: adminSimpleBillingApi.getSettings });
}

export function useSaveSimpleBillingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: adminSimpleBillingApi.putSettings,
    onSuccess: (data) => qc.setQueryData(adminSimpleBillingKeys.settings(), data),
  });
}

export function useAdminAccounts(params: AccountsParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminSimpleBillingKeys.accounts(params),
    queryFn: () => adminSimpleBillingApi.listAccounts(params),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

/**
 * Retry a failed read only when retrying can help: a 4xx answer (a workspace
 * or receipt that does not exist, a bad id) is final and shows at once.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof AdminBillingApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 3;
}

export function useAdminAccount(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: adminSimpleBillingKeys.account(workspaceId ?? ''),
    queryFn: () => adminSimpleBillingApi.getAccount(workspaceId as string),
    retry: retryUnlessClientError,
    enabled: Boolean(workspaceId),
  });
}

export function useAdminLedger(workspaceId: string, params: PageParams = {}) {
  return useQuery({
    queryKey: adminSimpleBillingKeys.ledger(workspaceId, params),
    queryFn: () => adminSimpleBillingApi.getLedger(workspaceId, params),
    retry: retryUnlessClientError,
    placeholderData: keepPreviousData,
    enabled: Boolean(workspaceId),
  });
}

export function useAdminPayments(workspaceId: string, params: PageParams = {}) {
  return useQuery({
    queryKey: adminSimpleBillingKeys.payments(workspaceId, params),
    queryFn: () => adminSimpleBillingApi.getPayments(workspaceId, params),
    retry: retryUnlessClientError,
    placeholderData: keepPreviousData,
    enabled: Boolean(workspaceId),
  });
}

export function useAdminReceipt(workspaceId: string, ledgerId: string | null) {
  return useQuery({
    queryKey: ['admin-simple-billing', 'receipt', workspaceId, ledgerId ?? ''] as const,
    queryFn: () => adminSimpleBillingApi.getReceipt(workspaceId, ledgerId as string),
    retry: retryUnlessClientError,
    enabled: Boolean(workspaceId && ledgerId),
  });
}

export function useAdminRevenue(params: RevenueParams = {}) {
  return useQuery({
    queryKey: adminSimpleBillingKeys.revenue(params),
    queryFn: () => adminSimpleBillingApi.getRevenue(params),
    placeholderData: keepPreviousData,
  });
}

export function useGatewayReadiness() {
  return useQuery({ queryKey: adminSimpleBillingKeys.gateways(), queryFn: adminSimpleBillingApi.getGateways });
}

/**
 * Books a credit or debit. On success the account, its ledger, the accounts
 * list and the revenue's balance movements are refetched. Errors are
 * AdminBillingApiError: BALANCE_CHANGED and CURRENCY_CHANGED carry the fresh
 * `account` in `body.account` (also written to the account's cache here).
 */
export function useAdminAdjust(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<AdjustResult, AdminBillingApiError, AdjustRequest>({
    mutationFn: (input) => adminSimpleBillingApi.adjust(workspaceId, input),
    onSuccess: (data) => {
      if (data.account) qc.setQueryData(adminSimpleBillingKeys.account(workspaceId), data.account);
      qc.invalidateQueries({ queryKey: adminSimpleBillingKeys.account(workspaceId) });
      qc.invalidateQueries({ queryKey: adminSimpleBillingKeys.ledger(workspaceId) });
      qc.invalidateQueries({ queryKey: adminSimpleBillingKeys.accounts() });
      qc.invalidateQueries({ queryKey: adminSimpleBillingKeys.revenue() });
    },
    onError: (error) => {
      const fresh = error?.body?.account;
      if (fresh && typeof fresh === 'object') qc.setQueryData(adminSimpleBillingKeys.account(workspaceId), fresh as AdminAccountDetail);
    },
  });
}
