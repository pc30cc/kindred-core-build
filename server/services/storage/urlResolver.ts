/**
 * THE ONE PLACE A STORAGE URL IS BUILT.
 *
 * The database stores a canonical storage key and nothing else:
 *
 *     workspace/<workspaceId>/...   users/<userId>/...   platform/...
 *
 * A key is identical on every vendor — it is what the platform writes,
 * everywhere. A public URL is not: it names one vendor's hostname. Persisting
 * a URL therefore pins the row to whichever provider happened to be primary
 * when it was written, and promoting a new primary would mean rewriting every
 * such row. So no row keeps one. URLs are DERIVED here, at read time, from
 * whichever provider is resolved right now, which makes a promotion a
 * zero-row-rewrite operation: the first request after it already renders the
 * new vendor's hostname.
 *
 * Three properties this module is responsible for:
 *
 * 1. NO N+1 PROVIDER RESOLUTION. A resolver is created once per request (or
 *    per worker job) and memoizes the provider lookup per workspace — and
 *    once, globally, for user- and platform-owned objects. Serializing 500
 *    rows for one workspace performs exactly one provider resolution.
 *
 * 2. DERIVATION IS PURE. Once a provider config is in hand, turning a key
 *    into a URL is string construction: no provider HTTP, no usage metering,
 *    no quota accounting, no replication events, no per-row logging. Read
 *    paths run on every page load; they must never generate write traffic.
 *
 * 3. OWNERSHIP IS VALIDATED BEFORE DERIVATION. `.workspace(id, key)` derives
 *    a URL only for a key that genuinely belongs to that workspace. A key
 *    naming another owner returns null rather than a working link — a
 *    serializer that mixes up two rows must produce a missing avatar, never a
 *    cross-tenant one.
 *
 * Private objects (chat/email attachments, call recordings, privacy exports)
 * are NOT served from here. They keep their authenticated proxy routes, which
 * stream bytes after an access check. This module is for the public,
 * CDN-served assets — avatars and logos — where proxying every byte through
 * the API would be strictly worse than handing out the CDN URL.
 */

import type { ServerConfig } from '../../config.js';
import {
  getFileUrlWithConfig,
  resolveStorageConfig,
  resolveGlobalStorageConfig,
  type StorageConfig,
} from './index.js';
import {
  classifyStorageKey,
  LEGACY_USER_AVATAR_PATTERN,
  LEGACY_BRANDING_PATTERN,
} from './keys.js';

/**
 * Ownership check, run before any URL is built.
 *
 * Canonical keys are matched structurally. Two legacy shapes predate the
 * `workspace/`|`users/` roots and still exist in rows written before
 * migrations 177/184 — they carry their owner id in the same position, so
 * they can be validated just as strictly rather than being waved through.
 */
export function keyBelongsToWorkspace(workspaceId: string, key: string): boolean {
  if (!workspaceId || typeof key !== 'string' || !key) return false;
  const classified = classifyStorageKey(key);
  if (classified) {
    return classified.owner.kind === 'workspace'
      && classified.owner.workspaceId.toLowerCase() === workspaceId.toLowerCase();
  }
  // Legacy: branding/<workspaceId>/...
  return LEGACY_BRANDING_PATTERN.test(key)
    && key.slice('branding/'.length, 'branding/'.length + 36).toLowerCase() === workspaceId.toLowerCase();
}

export function keyBelongsToUser(userId: string, key: string): boolean {
  if (!userId || typeof key !== 'string' || !key) return false;
  const classified = classifyStorageKey(key);
  if (classified) {
    return classified.owner.kind === 'user'
      && classified.owner.userId.toLowerCase() === userId.toLowerCase();
  }
  // Legacy: avatars/<userId>/...
  return LEGACY_USER_AVATAR_PATTERN.test(key)
    && key.slice('avatars/'.length, 'avatars/'.length + 36).toLowerCase() === userId.toLowerCase();
}

export function keyBelongsToPlatform(key: string): boolean {
  return typeof key === 'string' && key.startsWith('platform/');
}

/**
 * Derivation itself — pure, synchronous, total. Exported so a caller that
 * already holds a StorageConfig (the admin capability probe, tests) can
 * exercise exactly the same code path the read paths use.
 */
export function deriveUrl(config: StorageConfig | null, key: string | null | undefined): string | null {
  if (!config || typeof key !== 'string' || !key) return null;
  return getFileUrlWithConfig(config, key) || null;
}

export interface StorageUrlResolver {
  /**
   * URL for an object owned by `workspaceId`. Returns null when the key is
   * empty, is not owned by that workspace, or the workspace's provider
   * cannot be resolved or cannot express a public URL.
   */
  workspace(workspaceId: string | null | undefined, key: string | null | undefined): Promise<string | null>;
  /** URL for a user-owned object (`users/<userId>/...`), served by the platform-wide provider. */
  user(userId: string | null | undefined, key: string | null | undefined): Promise<string | null>;
  /** URL for a platform-owned object (`platform/...`). */
  platform(key: string | null | undefined): Promise<string | null>;
  /**
   * Resolve these workspaces' providers concurrently, before a serialization
   * loop. Purely an optimization: `.workspace()` resolves on demand anyway
   * and shares the very same memoized promise.
   */
  prewarmWorkspaces(workspaceIds: Array<string | null | undefined>): Promise<void>;
  /** Resolve the platform-wide provider once, before a loop over user-owned rows. */
  prewarmGlobal(): Promise<void>;
}

/**
 * Create a resolver whose provider lookups are memoized for its lifetime.
 *
 * Scope one to a request (or to a single worker job / broadcast). Never hold
 * one across requests: a promotion must take effect on the very next request,
 * and a process-lifetime cache would keep serving the old vendor.
 */
export function createStorageUrlResolver(serverConfig: ServerConfig): StorageUrlResolver {
  // Promises, not resolved values: two rows for the same workspace that are
  // serialized concurrently share one in-flight lookup instead of racing two.
  const byWorkspace = new Map<string, Promise<StorageConfig | null>>();
  let global: Promise<StorageConfig | null> | null = null;

  /**
   * A provider-resolution failure degrades to "no URL", never to a thrown
   * read: a broken storage config must not take down the conversation list
   * that merely wanted an avatar. The try/catch covers a synchronous throw
   * too, not only a rejected promise.
   */
  async function safely(load: () => Promise<StorageConfig | null>): Promise<StorageConfig | null> {
    try {
      return (await load()) ?? null;
    } catch {
      return null;
    }
  }

  function workspaceConfig(workspaceId: string): Promise<StorageConfig | null> {
    const cacheKey = workspaceId.toLowerCase();
    let pending = byWorkspace.get(cacheKey);
    if (!pending) {
      pending = safely(() => resolveStorageConfig(serverConfig, workspaceId));
      byWorkspace.set(cacheKey, pending);
    }
    return pending;
  }

  function globalConfig(): Promise<StorageConfig | null> {
    if (!global) global = safely(() => resolveGlobalStorageConfig(serverConfig));
    return global;
  }

  return {
    async workspace(workspaceId, key) {
      if (!workspaceId || !key) return null;
      if (!keyBelongsToWorkspace(workspaceId, key)) return null;
      return deriveUrl(await workspaceConfig(workspaceId), key);
    },

    async user(userId, key) {
      if (!userId || !key) return null;
      if (!keyBelongsToUser(userId, key)) return null;
      return deriveUrl(await globalConfig(), key);
    },

    async platform(key) {
      if (!key || !keyBelongsToPlatform(key)) return null;
      return deriveUrl(await globalConfig(), key);
    },

    async prewarmWorkspaces(workspaceIds) {
      const unique = new Set(
        workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      );
      await Promise.all([...unique].map((id) => workspaceConfig(id)));
    },

    async prewarmGlobal() {
      await globalConfig();
    },
  };
}

// ─── Row helpers ────────────────────────────────────────────────────
//
// The same two shapes appear in ~30 serializers. Keeping them here means a
// read path adds one await, not its own copy of the ownership rules.

/** A profile row as every serializer selects it: key column, no URL column. */
export interface UserAvatarRow {
  id?: string | null;
  avatar_storage_key?: string | null;
}

/**
 * Public URL for a profile avatar. User avatars live in the global
 * namespace (`users/<id>/avatar/...`), so they resolve through the
 * platform-wide provider regardless of which workspace is rendering them.
 */
export function resolveUserAvatarUrl(
  resolver: StorageUrlResolver,
  row: UserAvatarRow | null | undefined,
  userId?: string | null,
): Promise<string | null> {
  if (!row) return Promise.resolve(null);
  return resolver.user(userId ?? row.id ?? null, row.avatar_storage_key ?? null);
}

/**
 * Avatar URLs for a batch of profile rows, as `id -> url | null`.
 *
 * The whole batch costs ONE provider resolution (user objects all live in the
 * platform-wide namespace), which is why the bulk read paths use this instead
 * of awaiting per row inside a map.
 */
export async function userAvatarUrlMap(
  resolver: StorageUrlResolver,
  rows: Array<UserAvatarRow | null | undefined>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!rows.some((r) => r?.avatar_storage_key)) return out;
  await resolver.prewarmGlobal();
  for (const row of rows) {
    if (!row?.id) continue;
    out.set(row.id, await resolver.user(row.id, row.avatar_storage_key ?? null));
  }
  return out;
}

/**
 * Public URL for a contact avatar.
 *
 * `avatar_storage_key` is the ONLY supported write model: bytes arrive
 * through an ingest path, land in WebYar storage, and the row records the
 * key. Nothing may persist a contact avatar URL any more — the API schema
 * no longer has the field (server/routes/contacts.ts) and the ingest writer
 * clears the column.
 *
 * @deprecated LEGACY READ FALLBACK — the `avatar_url` branch below exists
 * only so rows written before this change keep rendering during rollout. It
 * is read-only: no code path creates a new value for it. Remove it, and the
 * column, once the cleanup migration has run.
 */
export async function resolveContactAvatarUrl(
  resolver: StorageUrlResolver,
  workspaceId: string | null | undefined,
  row: { avatar_storage_key?: string | null; avatar_url?: string | null } | null | undefined,
): Promise<string | null> {
  if (!row) return null;
  if (row.avatar_storage_key) {
    return resolver.workspace(workspaceId, row.avatar_storage_key);
  }
  return row.avatar_url ?? null;
}

/**
 * Avatar URLs for a batch of contact rows of ONE workspace, as `id -> url`.
 * One provider resolution for the batch; a row with no key of ours keeps its
 * externally supplied URL.
 */
export async function contactAvatarUrlMap(
  resolver: StorageUrlResolver,
  workspaceId: string | null | undefined,
  rows: Array<{ id?: string | null; avatar_storage_key?: string | null; avatar_url?: string | null } | null | undefined>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (workspaceId) await resolver.prewarmWorkspaces([workspaceId]);
  for (const row of rows) {
    if (!row?.id) continue;
    out.set(row.id, await resolveContactAvatarUrl(resolver, workspaceId, row));
  }
  return out;
}

// ─── In-place hydration ─────────────────────────────────────────────
//
// Most serializers select profile/contact rows and hand them straight to the
// client. Rather than teaching thirty call sites to carry a second column
// around, they select the KEY and then hydrate: `avatar_url` is replaced by
// the derived link and the key is dropped, so what leaves the API looks
// exactly as it always did while nothing provider-specific was ever stored.

function asResolver(source: ServerConfig | StorageUrlResolver): StorageUrlResolver {
  return typeof (source as StorageUrlResolver).user === 'function'
    ? (source as StorageUrlResolver)
    : createStorageUrlResolver(source as ServerConfig);
}

/** Row shape after `select('..., avatar_storage_key')`. */
type HydratableUserRow = { id?: string | null; avatar_storage_key?: string | null; avatar_url?: string | null };

/** What a row looks like once hydrated: a derived link, and no key. */
export type HydratedAvatarRow<T> = T & { avatar_url: string | null };

/**
 * Replace each row's `avatar_url` with the URL derived from its key, and
 * remove the key so it never reaches a client. One provider resolution for
 * the whole batch. Rows are mutated in place and returned for chaining —
 * use the RETURN value when you then read `avatar_url`, so the added field
 * is visible to the type checker.
 */
export async function hydrateUserAvatars<T extends HydratableUserRow>(
  source: ServerConfig | StorageUrlResolver,
  rows: T[] | null | undefined,
): Promise<Array<HydratedAvatarRow<T>>> {
  const list = (rows ?? []) as Array<HydratedAvatarRow<T>>;
  if (list.length === 0) return list;
  const resolver = asResolver(source);
  const urls = await userAvatarUrlMap(resolver, list);
  for (const row of list) {
    row.avatar_url = (row?.id ? urls.get(row.id) : null) ?? null;
    delete row.avatar_storage_key;
  }
  return list;
}

/**
 * The contact counterpart. A contact avatar is workspace-owned when we
 * stored it and externally supplied otherwise, so a row without a key of
 * ours keeps whatever URL the CRM import gave it.
 */
export async function hydrateContactAvatars<T extends HydratableUserRow>(
  source: ServerConfig | StorageUrlResolver,
  workspaceId: string | null | undefined,
  rows: T[] | null | undefined,
): Promise<Array<HydratedAvatarRow<T>>> {
  const list = (rows ?? []) as Array<HydratedAvatarRow<T>>;
  if (list.length === 0) return list;
  const resolver = asResolver(source);
  if (workspaceId) await resolver.prewarmWorkspaces([workspaceId]);
  for (const row of list) {
    row.avatar_url = await resolveContactAvatarUrl(resolver, workspaceId, row);
    delete row.avatar_storage_key;
  }
  return list;
}

// ─── Provider URL capability ────────────────────────────────────────

/**
 * Whether a configured vendor can express a public URL for a key at all.
 *
 * Promotion makes a vendor the one every read resolves through, so a vendor
 * that cannot produce a usable link would silently blank every avatar and
 * logo on the platform the moment it became primary — with no row to "fix",
 * because no row holds a URL any more. This is the capability test that
 * keeps such a vendor out of the primary slot.
 *
 * It is a REAL probe of the same derivation the read paths use, not a
 * hard-coded vendor list: `gcs`/`azure_blob` are routed to the S3 upload
 * handler but have no URL builder, and `local` returns a relative path
 * until it is given a `public_url` — both are caught here by their result,
 * not by their name.
 */
export interface StorageUrlCapability {
  capable: boolean;
  /** Present when not capable — safe to show an operator. */
  reason?: string;
  /** The URL the probe produced, for diagnostics. */
  sample?: string;
}

/** A syntactically valid key in each namespace, used only for the probe. */
const CAPABILITY_PROBE_KEY = 'platform/.storage-url-capability-probe';

export function describeUrlCapability(config: StorageConfig | null): StorageUrlCapability {
  if (!config) return { capable: false, reason: 'no_config' };
  const sample = getFileUrlWithConfig(config, CAPABILITY_PROBE_KEY);
  if (!sample) {
    return { capable: false, reason: 'no_public_url_builder' };
  }
  if (!/^https?:\/\/[^/]+\//i.test(sample)) {
    // A relative path (the local provider with no public_url) renders as a
    // broken link in a visitor's browser, which is worse than refusing.
    return { capable: false, reason: 'not_an_absolute_url', sample };
  }
  return { capable: true, sample };
}
