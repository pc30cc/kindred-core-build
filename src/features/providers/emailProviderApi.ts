/**
 * The Super Admin's email provider API (server/routes/adminEmailProviders.ts).
 *
 * The page names a slot (`default`, `notification`), never a row of the
 * platform's settings, and gets back every field that is not a secret plus
 * the names of the secrets that are set. A failed save comes back with the
 * config store's code and the field it is about, so the form can say which
 * one, and why.
 */

import { API_BASE } from '@/lib/apiBase';

export type EmailProviderSlot = 'default' | 'notification';

export interface EmailProviderChange {
  at: string;
  slot: EmailProviderSlot;
  provider_name: string | null;
  previous_provider: string | null;
  changed_fields: string[];
  actor: { id: string; name: string | null; email: string | null } | null;
}

export interface EmailProviderSlotState {
  provider_name: string | null;
  config: Record<string, unknown>;
  secretKeysSet: string[];
  readiness: 'unconfigured' | 'configured' | 'invalid';
  problems: Array<{ field: string; problem: 'missing' | 'invalid' }>;
  lastChange: EmailProviderChange | null;
}

export interface EmailProvidersState {
  slots: Record<EmailProviderSlot, EmailProviderSlotState>;
  adapters: string[];
  history: EmailProviderChange[];
  /** The signed-in admin's own address: where "Send test email" goes. */
  testRecipient: string | null;
  /** False when the server has no PLUGIN_SECRETS_MASTER_KEY, so a new secret cannot be saved. */
  encryptionAvailable: boolean;
  /** The Reply-To once typed under Branding, while the provider has none. */
  legacyReplyTo: string | null;
}

export interface EmailVerifyResult {
  ok: boolean;
  detail: string;
}

export interface EmailTestSendResult {
  success: boolean;
  provider: string;
  to?: string;
  id?: string;
  serverMessageId?: string;
  errorCode?: string;
  error?: string;
}

export interface EmailSuppression {
  address: string;
  reason: string;
  detail: string | null;
  source: string;
  bounce_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
}

/** A refusal from the server: its code (the store's, e.g. `missing_field`) and the field it names. */
export class EmailProviderApiError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status: number;

  constructor(code: string, status: number, field?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const BASE = '/api/admin/providers/email';

/** The page's React Query key: a save or a removal puts the server's new state here. */
export const EMAIL_PROVIDERS_QUERY_KEY = ['admin-email-providers'] as const;

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({})) as { error?: unknown; field?: unknown };
  if (!res.ok) {
    throw new EmailProviderApiError(
      typeof body.error === 'string' ? body.error : `http_${res.status}`,
      res.status,
      typeof body.field === 'string' ? body.field : undefined,
    );
  }
  return body as T;
}

export function fetchEmailProviders(): Promise<EmailProvidersState> {
  return call<EmailProvidersState>('');
}

export function saveEmailProvider(
  slot: EmailProviderSlot,
  providerName: string,
  config: Record<string, string>,
): Promise<EmailProvidersState> {
  return call<EmailProvidersState>(`/${slot}`, {
    method: 'PUT',
    body: JSON.stringify({ provider_name: providerName, config }),
  });
}

export function removeEmailProvider(slot: EmailProviderSlot): Promise<EmailProvidersState> {
  return call<EmailProvidersState>(`/${slot}`, { method: 'DELETE' });
}

export function verifyEmailProviderSlot(slot: EmailProviderSlot): Promise<EmailVerifyResult> {
  return call<EmailVerifyResult>(`/${slot}/verify`, { method: 'POST', body: '{}' });
}

export function sendEmailProviderTest(slot: EmailProviderSlot): Promise<EmailTestSendResult> {
  return call<EmailTestSendResult>(`/${slot}/test-send`, { method: 'POST', body: '{}' });
}

export function fetchEmailSuppressions(params: { search?: string; limit: number; offset: number }): Promise<{ rows: EmailSuppression[]; total: number }> {
  const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  if (params.search?.trim()) query.set('search', params.search.trim());
  return call<{ rows: EmailSuppression[]; total: number }>(`/suppressions?${query.toString()}`);
}

export function removeEmailSuppression(address: string): Promise<{ removed: boolean }> {
  return call<{ removed: boolean }>(`/suppressions/${encodeURIComponent(address)}`, { method: 'DELETE' });
}
