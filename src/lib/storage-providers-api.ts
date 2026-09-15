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

/** Server-recorded progress of a back-fill walk. Never client state. */
export interface AdminStorageSyncState {
  prefix: string;
  from: string;
  done: boolean;
  hasMore: boolean;
  total: { scanned: number; copied: number; skipped: number; failed: number };
  updatedAt: string;
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
  /** Proven to hold everything the current primary holds — the promotion gate. */
  synchronized: boolean;
  syncedAt: string | null;
  /** A known replication gap recorded server-side; blocks promotion until a fresh full sync. */
  dirtyAt: string | null;
  dirtyReason: string | null;
  /** Switched off: no new mirrored writes, but still purged by owner deletion. */
  retired: boolean;
  sync: AdminStorageSyncState | null;
}

export interface AdminStoragePoolDto {
  primary: string | null;
  /** Compare-and-set token; bumped by every committed pool write. */
  revision: number;
  replication: { enabled: boolean; mirrorDeletes: boolean };
  supported: string[];
  providers: AdminStorageProviderDto[];
}

export interface AdminStorageSyncCounts {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
}

export interface AdminStorageSyncReport {
  target: string;
  prefix: string;
  /** What this one call did. */
  batch: AdminStorageSyncCounts;
  /** The whole walk so far, as recorded by the server. */
  total: AdminStorageSyncCounts;
  errors: string[];
  /** Opaque; null ONLY when the walk is genuinely exhausted. */
  nextCursor: string | null;
  done: boolean;
  /** The walk covered the whole namespace with no failures — the vendor may now be promoted. */
  markedSynchronized: boolean;
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

/**
 * `force` is the recovery path only: the server refuses a normal promotion
 * of a vendor it has not recorded as fully synchronized with the current
 * primary.
 */
export function adminPromoteStorageProvider(providerName: string, force?: boolean) {
  return request<AdminStoragePoolDto & { forced?: boolean }>(
    `${BASE}/${encodeURIComponent(providerName)}/primary`,
    { method: 'POST', body: JSON.stringify({ force: force === true }) },
  );
}

/**
 * Removing a vendor deletes the platform's knowledge of it, not its objects.
 * The server refuses while it still holds `workspace/...` or `users/...`
 * data (or cannot verify that it doesn't); `force` is the named destructive
 * override.
 */
export function adminRemoveStorageProvider(providerName: string, force?: boolean) {
  return request<AdminStoragePoolDto & { forced?: boolean }>(
    `${BASE}/${encodeURIComponent(providerName)}`,
    { method: 'DELETE', body: JSON.stringify({ force: force === true }) },
  );
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

/**
 * Copy one bounded batch of what the mirror is missing. The walk position
 * lives on the server: pass `restart` to begin again, otherwise the call
 * continues wherever the last batch stopped.
 */
export function adminSyncStorageReplica(payload: {
  target: string;
  prefix?: string;
  limit?: number;
  restart?: boolean;
}) {
  return request<{ report: AdminStorageSyncReport }>(`${BASE}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
