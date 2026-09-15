/**
 * ADMIN — STORAGE PROVIDER POOL CLIENT
 *
 * Several storage vendors can hold credentials at once: one is the primary
 * (every read and write goes there) and the enabled rest are mirrors that
 * receive a copy of each write.
 *
 * Secrets are never returned by these endpoints — `secretKeys` only says
 * which credential fields are set, and a save that leaves one blank keeps
 * the stored value.
 */

import { API_BASE } from './apiBase';
import { authFetch } from './authFetch';

const BASE = '/api/admin/providers/storage';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface AdminStorageProviderDto {
  name: string;
  enabled: boolean;
  isPrimary: boolean;
  /** Non-secret settings only. */
  config: Record<string, unknown>;
  /** Credential fields the server holds — never the values themselves. */
  secretKeys: string[];
  updatedAt: string | null;
}

export interface AdminStoragePoolDto {
  primary: string | null;
  replication: { enabled: boolean; mirrorDeletes: boolean };
  supported: string[];
  providers: AdminStorageProviderDto[];
}

export interface AdminStorageSyncReport {
  target: string;
  prefix: string;
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
  nextCursor: string | null;
}

export function adminGetStoragePool() {
  return request<AdminStoragePoolDto>(BASE);
}

/** Blank secret fields keep the stored credential. */
export function adminSaveStorageProvider(
  providerName: string,
  payload: { config: Record<string, string>; enabled?: boolean; makePrimary?: boolean },
) {
  return request<AdminStoragePoolDto>(`${BASE}/${encodeURIComponent(providerName)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function adminSetStorageProviderEnabled(providerName: string, enabled: boolean) {
  return request<AdminStoragePoolDto>(`${BASE}/${encodeURIComponent(providerName)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

export function adminPromoteStorageProvider(providerName: string) {
  return request<AdminStoragePoolDto>(`${BASE}/${encodeURIComponent(providerName)}/primary`, {
    method: 'POST',
  });
}

export function adminRemoveStorageProvider(providerName: string) {
  return request<AdminStoragePoolDto>(`${BASE}/${encodeURIComponent(providerName)}`, {
    method: 'DELETE',
  });
}

export function adminTestStorageProvider(providerName: string) {
  return request<{ success: boolean; latencyMs: number; error?: string }>(
    `${BASE}/${encodeURIComponent(providerName)}/test`,
    { method: 'POST' },
  );
}

export function adminSetStorageReplication(enabled: boolean, mirrorDeletes?: boolean) {
  return request<AdminStoragePoolDto>(`${BASE}/replication`, {
    method: 'PUT',
    body: JSON.stringify({ enabled, mirrorDeletes }),
  });
}

/** Copy objects the mirror is missing from the primary, one bounded page at a time. */
export function adminSyncStorageReplica(payload: {
  target: string;
  prefix?: string;
  limit?: number;
  cursor?: string;
}) {
  return request<{ report: AdminStorageSyncReport }>(`${BASE}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
