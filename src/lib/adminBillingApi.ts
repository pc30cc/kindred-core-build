/**
 * Super-admin payment gateway API client (/api/admin/billing/gateways).
 *
 * The simple billing's own Super Admin screens use adminSimpleBillingApi.ts.
 */

import { API_BASE } from './apiBase';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/billing${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: string } | null)?.error;
    const err = new Error(code || `API error: ${res.status}`) as Error & { code?: string };
    err.code = code;
    throw err;
  }
  return body as T;
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

export const adminBillingApi = {
  gateways: () => request<{ gateways: AdminGateway[] }>('/gateways'),
  saveGateway: (input: Partial<AdminGateway> & { provider_name: string }) =>
    request<{ gateway: AdminGateway }>('/gateways', { method: 'PUT', body: JSON.stringify(input) }),
};
