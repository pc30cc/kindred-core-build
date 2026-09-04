/**
 * Super-admin finance API client (unified billing).
 *
 * The browser only renders what the server decides: every amount here is in
 * MINOR UNITS of its own currency and no total is computed client-side.
 */

import { API_BASE } from './apiBase';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/billing${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as any)?.error || `API error: ${res.status}`) as Error & { code?: string };
    err.code = (body as any)?.error;
    throw err;
  }
  return body as T;
}

export interface AdminCurrency {
  code: string;
  display_name: Record<string, string>;
  symbol: string;
  minor_units: number;
  is_base: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface AdminExchangeRate {
  id: string;
  base_code: string;
  quote_code: string;
  rate: number;
  effective_at: string;
}

export interface AdminGateway {
  id: string;
  provider_name: string;
  display_name: Record<string, string>;
  is_active: boolean;
  is_test: boolean;
  currencies: string[];
  countries: string[];
  sort_order: number;
  implemented: boolean;
}

export interface AdminTaxRate {
  id: string;
  name: string;
  rate_percent: number;
  country_code: string | null;
  currency: string | null;
  is_inclusive: boolean;
  is_active: boolean;
}

export interface AdminCoupon {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percent' | 'fixed';
  percent_off: number | null;
  amount_off_minor: number | null;
  currency: string | null;
  applies_to_plans: string[];
  max_redemptions: number | null;
  redeemed_count: number;
  once_per_workspace: boolean;
  starts_at: string | null;
  expires_at: string | null;
  is_active: boolean;
}

export interface AdminUsageItem {
  key: string;
  display_name: Record<string, string>;
  unit: string;
  prices: Record<string, number>;
  is_active: boolean;
  sort_order: number;
}

export interface AdminFinanceOverview {
  revenue30d: Record<string, number>;
  outstanding: Record<string, number>;
  walletBalances: Record<string, number>;
  successfulPayments: number;
  activeSubscriptions: number;
}

export const adminBillingApi = {
  overview: () => request<AdminFinanceOverview>('/overview'),

  currencies: () => request<{ currencies: AdminCurrency[] }>('/currencies'),
  saveCurrency: (input: Partial<AdminCurrency> & { code: string }) =>
    request<{ currency: AdminCurrency }>('/currencies', { method: 'PUT', body: JSON.stringify(input) }),
  deleteCurrency: (code: string) => request<{ ok: true }>(`/currencies/${code}`, { method: 'DELETE' }),

  exchangeRates: () => request<{ rates: AdminExchangeRate[] }>('/exchange-rates'),
  publishRate: (input: { base_code: string; quote_code: string; rate: number }) =>
    request<{ rate: AdminExchangeRate }>('/exchange-rates', { method: 'POST', body: JSON.stringify(input) }),

  gateways: () => request<{ gateways: AdminGateway[] }>('/gateways'),
  saveGateway: (input: Partial<AdminGateway> & { provider_name: string }) =>
    request<{ gateway: AdminGateway }>('/gateways', { method: 'PUT', body: JSON.stringify(input) }),

  taxRates: () => request<{ taxRates: AdminTaxRate[] }>('/tax-rates'),
  saveTaxRate: (input: Partial<AdminTaxRate> & { name: string; rate_percent: number }) =>
    request<{ taxRate: AdminTaxRate }>('/tax-rates', { method: 'PUT', body: JSON.stringify(input) }),
  deleteTaxRate: (id: string) => request<{ ok: true }>(`/tax-rates/${id}`, { method: 'DELETE' }),

  coupons: () => request<{ coupons: AdminCoupon[] }>('/coupons'),
  saveCoupon: (input: Partial<AdminCoupon>) =>
    request<{ coupon: AdminCoupon }>('/coupons', { method: 'PUT', body: JSON.stringify(input) }),
  deleteCoupon: (id: string) => request<{ ok: true }>(`/coupons/${id}`, { method: 'DELETE' }),

  usageItems: () => request<{ usageItems: AdminUsageItem[] }>('/usage-items'),
  saveUsageItem: (input: Partial<AdminUsageItem> & { key: string }) =>
    request<{ usageItem: AdminUsageItem }>('/usage-items', { method: 'PUT', body: JSON.stringify(input) }),

  invoices: (params: { page?: number; pageSize?: number; status?: string; search?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== '' && q.set(k, String(v)));
    return request<{ invoices: any[]; total: number; page: number; pageSize: number }>(`/invoices?${q}`);
  },
  payments: (params: { page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
    return request<{ payments: any[]; total: number; page: number; pageSize: number }>(`/payments?${q}`);
  },
  customers: (search = '') =>
    request<{ customers: any[] }>(`/customers?search=${encodeURIComponent(search)}`),
};

/** Formats a minor-unit amount for display. Presentation only. */
export function formatMinor(amount: number, currency: string, minorUnits = 0, locale = 'fa-IR'): string {
  const value = minorUnits > 0 ? amount / 10 ** minorUnits : amount;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: minorUnits }).format(value) + ' ' + currency;
  } catch {
    return `${value} ${currency}`;
  }
}
