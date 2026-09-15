/**
 * STORAGE PROVIDER POOL
 *
 * The platform can hold credentials for SEVERAL storage vendors at once.
 * Exactly one of them is the PRIMARY — every read and every write goes
 * there. The other enabled vendors are REPLICAS: writes are mirrored to
 * them so the same objects exist in more than one place, and an operator
 * can promote one of them to primary without re-entering credentials.
 *
 * Where it lives: `app_runtime_config.storage_provider_pool` (jsonb) —
 * the same generic key/value table `default_storage_provider` already uses,
 * so no schema migration is needed.
 *
 * Compatibility: `default_storage_provider` remains the single source of
 * truth for every existing reader (resolveStorageConfig and friends). This
 * module keeps it pointing at the pool's primary on every write, and when
 * the pool has never been written it PROJECTS the legacy value into a
 * one-entry pool. Nothing downstream has to know the pool exists.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export const STORAGE_POOL_KEY = 'storage_provider_pool';
export const STORAGE_DEFAULT_KEY = 'default_storage_provider';

export interface StoragePoolEntry {
  /** Mirrored on write while enabled. The primary is always enabled. */
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt?: string;
}

export interface StorageReplication {
  /** Mirror every successful primary upload to the enabled replicas. */
  enabled: boolean;
  /** Also propagate deletes. Off by default — a replica then doubles as a backup. */
  mirrorDeletes: boolean;
}

export interface StoragePool {
  primary: string | null;
  replication: StorageReplication;
  providers: Record<string, StoragePoolEntry>;
}

const DEFAULT_REPLICATION: StorageReplication = { enabled: true, mirrorDeletes: false };

export function emptyPool(): StoragePool {
  return { primary: null, replication: { ...DEFAULT_REPLICATION }, providers: {} };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Accepts anything the jsonb column may hold and returns a well-formed pool. */
export function normalizePool(value: unknown): StoragePool {
  const raw = asRecord(value);
  const providersRaw = asRecord(raw.providers);
  const providers: Record<string, StoragePoolEntry> = {};

  for (const [name, entryRaw] of Object.entries(providersRaw)) {
    const entry = asRecord(entryRaw);
    providers[name] = {
      enabled: entry.enabled !== false,
      config: asRecord(entry.config),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
    };
  }

  const replicationRaw = asRecord(raw.replication);
  const primary = typeof raw.primary === 'string' && providers[raw.primary] ? raw.primary : null;

  return {
    primary,
    replication: {
      enabled: replicationRaw.enabled !== false,
      mirrorDeletes: replicationRaw.mirrorDeletes === true,
    },
    providers,
  };
}

/**
 * `app_runtime_config.value` for the legacy key is untyped — it stores
 * either `{provider_name, config}` or the provider fields flattened.
 */
function splitLegacyValue(value: unknown): { providerName: string | null; config: Record<string, unknown> } {
  const raw = asRecord(value);
  const providerName =
    typeof raw.provider_name === 'string' ? raw.provider_name
      : typeof raw.provider === 'string' ? raw.provider
        : null;
  const config = raw.config && typeof raw.config === 'object' ? asRecord(raw.config) : raw;
  return { providerName, config };
}

/**
 * Read the pool. When it has never been written, the platform's existing
 * single default is projected into a one-entry pool so the first read
 * already reflects reality instead of looking unconfigured.
 */
export async function readStoragePool(serverConfig: ServerConfig): Promise<StoragePool> {
  const sb = getServiceClient(serverConfig);

  const [{ data: poolRow }, { data: legacyRow }] = await Promise.all([
    sb.from('app_runtime_config').select('value').eq('key', STORAGE_POOL_KEY).maybeSingle(),
    sb.from('app_runtime_config').select('value').eq('key', STORAGE_DEFAULT_KEY).maybeSingle(),
  ]);

  const pool = normalizePool((poolRow as { value?: unknown } | null)?.value);
  const legacy = splitLegacyValue((legacyRow as { value?: unknown } | null)?.value);

  // Seed from the legacy default so an operator who has never opened this
  // screen still sees their current provider as the primary.
  if (Object.keys(pool.providers).length === 0 && legacy.providerName) {
    pool.providers[legacy.providerName] = {
      enabled: true,
      config: legacy.config,
    };
    pool.primary = legacy.providerName;
    return pool;
  }

  // The legacy pointer wins over a stale `primary` — it is what the running
  // app actually resolves through, so the screen must never disagree with it.
  if (legacy.providerName && pool.providers[legacy.providerName]) {
    pool.primary = legacy.providerName;
  } else if (!pool.primary) {
    const firstEnabled = Object.entries(pool.providers).find(([, e]) => e.enabled)?.[0];
    pool.primary = firstEnabled ?? Object.keys(pool.providers)[0] ?? null;
  }

  return pool;
}

async function putRuntimeConfig(serverConfig: ServerConfig, key: string, value: unknown): Promise<void> {
  const sb = getServiceClient(serverConfig);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

/**
 * Persist the pool AND keep `default_storage_provider` pointing at its
 * primary, in that order. Both writes always happen together — a pool whose
 * primary disagrees with the legacy pointer would send reads and writes to
 * different vendors.
 */
export async function writeStoragePool(serverConfig: ServerConfig, pool: StoragePool): Promise<void> {
  const normalized = normalizePool(pool);

  // The primary is implicitly enabled; a disabled primary would mean the
  // platform writes to a vendor it also considers switched off.
  if (normalized.primary && normalized.providers[normalized.primary]) {
    normalized.providers[normalized.primary].enabled = true;
  }

  await putRuntimeConfig(serverConfig, STORAGE_POOL_KEY, normalized);

  if (normalized.primary) {
    const entry = normalized.providers[normalized.primary];
    await putRuntimeConfig(serverConfig, STORAGE_DEFAULT_KEY, {
      provider_name: normalized.primary,
      config: entry?.config ?? {},
    });
  }
}

/** Every enabled vendor that is not the primary — the mirror targets. */
export function replicaEntries(pool: StoragePool): { name: string; config: Record<string, unknown> }[] {
  return Object.entries(pool.providers)
    .filter(([name, entry]) => entry.enabled && name !== pool.primary)
    .map(([name, entry]) => ({ name, config: entry.config }));
}
