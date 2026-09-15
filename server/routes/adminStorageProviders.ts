/**
 * ADMIN — STORAGE PROVIDER POOL
 *
 * Mounted under the admin router, so `requireAdmin` (platform-admin, verified
 * server-side) already gates every route here.
 *
 * Unlike the generic runtime-config screen, this endpoint NEVER returns a
 * stored credential. Each vendor's non-secret settings come back as they are;
 * secrets come back only as a list of which keys are set, and a save that
 * leaves a secret field blank keeps the stored value instead of erasing it.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  readStoragePool, writeStoragePool, emptyPool, isReplicaSynchronized, clearSyncReadiness,
  StoragePoolConflictError,
  type StoragePool,
} from '../services/storage/pool.js';
import {
  SUPPORTED_STORAGE_PROVIDERS,
  storageConfigFromRecord,
  testStorageConnection,
  syncStorageReplica,
  listWithConfig,
} from '../services/storage/index.js';
import { storageConfigFingerprint } from '../services/storage/workspaceScopes.js';
import { describeUrlCapability } from '../services/storage/urlResolver.js';

export const adminStorageProvidersRouter = Router();

interface AdminRequestContext {
  serverConfig: ServerConfig;
  adminUser?: { id: string };
}

function ctx(req: Request): AdminRequestContext {
  return req as Request & AdminRequestContext;
}

function adminId(req: Request): string | null {
  return ctx(req).adminUser?.id ?? null;
}

function fail(res: Response, err: unknown): void {
  // A lost compare-and-set is not a server fault: somebody else changed the
  // pool while this request was in flight. The caller re-reads and retries
  // rather than having its stale snapshot written.
  if (err instanceof StoragePoolConflictError) {
    res.status(409).json({
      error: 'The storage pool changed while this request was in flight — reload and try again.',
      reason: 'revision_conflict',
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  res.status(500).json({ error: message });
}

// ─── Test / sync rate limit: 5 per minute per admin ──────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateHits = new Map<string, number[]>();

function allowExpensiveCall(key: string, now = Date.now()): boolean {
  const hits = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateHits.set(key, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(key, hits);
  return true;
}

/** Exposed for tests. */
export function __resetStorageAdminRateLimit(): void {
  rateHits.clear();
}

// ─── Secret handling ─────────────────────────────────────────────

/**
 * A config key whose value is a credential. Kept deliberately broad: the
 * cost of redacting one field too many is a blank input; the cost of missing
 * one is a leaked key.
 */
function isSecretKey(key: string): boolean {
  return /key|secret|password|token|credential|service_account/i.test(key);
}

function redactConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  secretKeys: string[];
} {
  const visible: Record<string, unknown> = {};
  const secretKeys: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (isSecretKey(key)) {
      if (value !== undefined && value !== null && String(value) !== '') secretKeys.push(key);
      continue;
    }
    visible[key] = value;
  }
  return { config: visible, secretKeys };
}

/**
 * Merge an incoming config over the stored one.
 *  - a value that was sent wins
 *  - a BLANK secret means "leave the stored credential alone" (the UI never
 *    receives it, so it cannot send it back)
 *  - a blank non-secret means the operator cleared the field
 */
function mergeConfig(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(incoming)) {
    const blank = value === undefined || value === null || String(value).trim() === '';
    if (blank) {
      if (!isSecretKey(key)) delete merged[key];
      continue;
    }
    merged[key] = typeof value === 'string' ? value.trim() : value;
  }
  return merged;
}

function serializePool(pool: StoragePool) {
  return {
    primary: pool.primary,
    replication: pool.replication,
    supported: SUPPORTED_STORAGE_PROVIDERS,
    revision: pool.revision,
    providers: Object.entries(pool.providers).map(([name, entry]) => {
      const { config, secretKeys } = redactConfig(entry.config);
      return {
        name,
        enabled: entry.enabled,
        isPrimary: name === pool.primary,
        config,
        secretKeys,
        updatedAt: entry.updatedAt ?? null,
        /** Proven to hold everything the CURRENT primary holds. */
        synchronized: name === pool.primary || isReplicaSynchronized(pool, name),
        /**
         * Can this vendor express a public URL? A vendor that cannot may
         * still mirror writes, but can never become primary — every avatar
         * and logo link is derived from the primary at read time.
         */
        canServePublicUrls: describeUrlCapability(storageConfigFromRecord(name, entry.config)).capable,
        syncedAt: entry.syncedAt ?? null,
        /** A known replication gap — clears readiness until a fresh full walk. */
        dirtyAt: entry.dirtyAt ?? null,
        dirtyReason: entry.dirtyReason ?? null,
        /**
         * Switched off: receives no new mirrored writes, but is STILL walked
         * by workspace/user deletion, because it keeps whatever it already
         * holds.
         */
        retired: !entry.enabled && name !== pool.primary,
        sync: entry.sync
          ? {
              prefix: entry.sync.prefix,
              from: entry.sync.from,
              done: entry.sync.done,
              hasMore: !!entry.sync.cursor,
              total: entry.sync.total,
              updatedAt: entry.sync.updatedAt,
            }
          : null,
      };
    }),
  };
}

function providerNameOf(req: Request, res: Response): string | null {
  const name = String(req.params.providerName ?? '');
  if (!SUPPORTED_STORAGE_PROVIDERS.includes(name)) {
    res.status(400).json({ error: 'Unsupported storage provider' });
    return null;
  }
  return name;
}

// ─── GET — the whole pool, redacted ──────────────────────────────

adminStorageProvidersRouter.get('/', async (req, res) => {
  try {
    res.json(serializePool(await readStoragePool(ctx(req).serverConfig)));
  } catch (e) { fail(res, e); }
});

// ─── Replication settings ────────────────────────────────────────
// Declared before `/:providerName` so "replication" is never read as a
// provider name.

const replicationSchema = z.object({
  enabled: z.boolean(),
  mirrorDeletes: z.boolean().optional(),
});

adminStorageProvidersRouter.put('/replication', async (req, res) => {
  try {
    const body = replicationSchema.parse(req.body);
    const serverConfig = ctx(req).serverConfig;
    const pool = await readStoragePool(serverConfig);
    const wasOn = pool.replication.enabled;
    pool.replication = {
      enabled: body.enabled,
      mirrorDeletes: body.mirrorDeletes ?? pool.replication.mirrorDeletes,
    };

    // The moment mirroring stops, every replica starts falling behind the
    // primary — silently, with no failed write to record. So switching it off
    // invalidates readiness outright: turning it back on later must not
    // resurrect a proof that stopped being true while it was off.
    if (wasOn && !body.enabled) {
      for (const [name, entry] of Object.entries(pool.providers)) {
        if (name !== pool.primary) clearSyncReadiness(entry);
      }
    }

    await writeStoragePool(serverConfig, pool);
    res.json(serializePool(await readStoragePool(serverConfig)));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Backfill an existing replica from the primary ───────────────

// No cursor from the client: the walk's position lives on the pool entry,
// so "give me the next batch" cannot be turned into "pretend I already
// walked everything" by a crafted request.
const syncSchema = z.object({
  target: z.string().min(2),
  prefix: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  restart: z.boolean().optional(),
});

adminStorageProvidersRouter.post('/sync', async (req, res) => {
  try {
    const body = syncSchema.parse(req.body);
    if (!SUPPORTED_STORAGE_PROVIDERS.includes(body.target)) {
      return res.status(400).json({ error: 'Unsupported storage provider' });
    }
    if (!allowExpensiveCall(`sync:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many sync runs — try again in a minute' });
    }
    const result = await syncStorageReplica(ctx(req).serverConfig, {
      target: body.target,
      prefix: body.prefix,
      limit: body.limit,
      restart: body.restart,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ report: result.report });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Save one vendor's settings ──────────────────────────────────

/**
 * Save is CONFIG ONLY. Each control has exactly one entrance:
 *
 *   PUT    /:providerName          — credentials and settings
 *   PATCH  /:providerName          — enable / disable (invalidates readiness)
 *   POST   /:providerName/primary  — promotion (proof, live test, force, logging)
 *
 * `strict()` is deliberate: a request still carrying `makePrimary` or
 * `enabled` is refused outright rather than silently ignored, because both
 * were once a way around the promotion gate and the disable-invalidation,
 * and a caller that still sends them is asking for something this endpoint
 * must not do.
 */
const saveSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Repoint at a different physical location even though the old one is not verifiably empty. */
  force: z.boolean().optional(),
}).strict();

adminStorageProvidersRouter.put('/:providerName', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const body = saveSchema.parse(req.body);
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    const existing = pool.providers[name];
    const merged = mergeConfig(existing?.config ?? {}, body.config);

    // Two different edits wear the same shape here. Rotating a key leaves the
    // bytes exactly where they were. Changing the bucket, endpoint, zone or
    // local path does not: it points this entry at a DIFFERENT physical
    // location, and the old one keeps everything it holds while silently
    // ceasing to be a lifecycle-deletion scope — the pool only knows one
    // location per vendor.
    //
    // So a location change is only allowed once the old location is
    // verifiably free of managed data. Otherwise the entry stays pointed at
    // it (409), which is what keeps it in every future owner purge.
    const previousFingerprint = existing
      ? storageConfigFingerprint(storageConfigFromRecord(name, existing.config))
      : null;
    const nextFingerprint = storageConfigFingerprint(storageConfigFromRecord(name, merged));
    const locationChanged = !!previousFingerprint && previousFingerprint !== nextFingerprint;

    if (locationChanged && !body.force) {
      const check = await managedDataCheck(name, existing!.config);
      if (!check.clean) {
        return res.status(409).json({
          error:
            `This would repoint ${name} at a different storage location, but the current one `
            + `${check.reason}. Workspace and account deletion can only reach one location per `
            + 'vendor, so the old one would keep that data forever. Purge or empty it first — '
            + 'or add the new location as a separate vendor.',
          reason: 'old_location_not_empty',
          sample: check.sample ?? null,
        });
      }
    } else if (locationChanged) {
      console.warn(
        `[storage] FORCED location change for ${name} by admin ${adminId(req) ?? 'unknown'} `
        + '— objects left at the previous location are no longer reachable by owner deletion.',
      );
    }

    pool.providers[name] = {
      // Enable state is PATCH's business — carried over untouched here.
      enabled: existing?.enabled ?? true,
      config: merged,
      updatedAt: new Date().toISOString(),
      syncedAt: existing?.syncedAt ?? null,
      syncedFrom: existing?.syncedFrom ?? null,
      // A recorded replication gap survives an ordinary save. Dropping it here
      // would quietly restore promotion readiness that a failed mirror write
      // had already invalidated.
      dirtyAt: existing?.dirtyAt ?? null,
      dirtyReason: existing?.dirtyReason ?? null,
      sync: existing?.sync ?? null,
    };

    // A new physical location is a new storage identity: nothing an earlier
    // walk proved, and nothing an earlier failure recorded, applies to it.
    // A pure credential rotation keeps both.
    if (locationChanged) {
      clearSyncReadiness(pool.providers[name]);
    }

    // The first vendor ever configured becomes the primary — there is no
    // previous primary to be synchronized with, so nothing is being bypassed.
    // Every later change of primary goes through POST /:providerName/primary
    // and its gate; save can never promote an existing vendor.
    if (!pool.primary) pool.primary = name;

    await writeStoragePool(serverConfig, pool);
    res.json(serializePool(await readStoragePool(serverConfig)));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Enable / disable a replica ──────────────────────────────────

adminStorageProvidersRouter.patch('/:providerName', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    const entry = pool.providers[name];
    if (!entry) return res.status(404).json({ error: 'Provider is not configured' });
    if (!body.enabled && pool.primary === name) {
      return res.status(400).json({
        error: 'The primary provider cannot be switched off — promote another vendor first',
      });
    }

    // Same reasoning per vendor: a retired mirror receives nothing while it
    // is off, so whatever an earlier walk proved expires the moment it is
    // switched off — re-enabling does not bring the proof back.
    if (entry.enabled && !body.enabled) clearSyncReadiness(entry);

    entry.enabled = body.enabled;
    await writeStoragePool(serverConfig, pool);
    res.json(serializePool(await readStoragePool(serverConfig)));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Promote a vendor to primary ─────────────────────────────────

/**
 * Promotion is not a label change: the new primary becomes the only
 * provider reads resolve through, so an object the mirror never received
 * stops being downloadable the moment it is promoted.
 *
 * A normal promotion therefore requires all three of:
 *   1. the vendor is configured AND enabled,
 *   2. its credentials answer right now (a real upload+delete round trip),
 *   3. the server itself recorded a completed whole-namespace back-fill
 *      from the CURRENT primary with zero failures.
 *
 * (3) is read from the pool entry the sync walk writes — never from a flag
 * the browser sends. `force` exists for recovery (the current primary is
 * gone and an incomplete mirror is better than nothing) and is the only way
 * past it; it is logged and surfaced in the response.
 *
 * ONE requirement stands above `force`: the vendor must be able to express a
 * public URL. Since no row persists a URL any more — every avatar and logo
 * link is derived from its storage key for whichever provider is primary
 * (services/storage/urlResolver.ts) — promoting a vendor with no URL builder
 * would blank all of them platform-wide, with nothing to repair afterwards
 * because there is no stored URL to fix. `force` trades completeness of the
 * data for availability; this would trade away the links themselves, so it
 * is refused either way.
 */
adminStorageProvidersRouter.post('/:providerName/primary', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    const entry = pool.providers[name];
    if (!entry) return res.status(404).json({ error: 'Provider is not configured' });

    if (name === pool.primary) return res.json(serializePool(pool));

    // Not bypassable by `force` — see this route's doc comment.
    const capability = describeUrlCapability(storageConfigFromRecord(name, entry.config));
    if (!capability.capable) {
      return res.status(409).json({
        error:
          capability.reason === 'not_an_absolute_url'
            ? 'This vendor has no public base URL configured, so it cannot produce links for avatars and logos. '
              + 'Set its public/CDN URL, then promote it.'
            : 'This backend cannot build public URLs for this vendor, so promoting it would break every avatar and logo link.',
        reason: 'no_public_url',
      });
    }

    if (!entry.enabled && !body.force) {
      return res.status(409).json({
        error: 'This vendor is switched off — enable it (and sync it) before making it primary',
        reason: 'disabled',
      });
    }

    // Nothing to be out of sync with when there is no primary yet.
    const needsSyncProof = !!pool.primary;

    if (!body.force) {
      const reachable = await testStorageConnection(storageConfigFromRecord(name, entry.config));
      if (!reachable.success) {
        return res.status(409).json({
          error: `This vendor did not answer a test write: ${reachable.error ?? 'unknown error'}`,
          reason: 'unreachable',
        });
      }
      if (needsSyncProof && !isReplicaSynchronized(pool, name)) {
        return res.status(409).json({
          error:
            'This vendor has not been proven to hold everything the current primary holds. '
            + 'Run a full sync (no prefix) until it reports complete, then promote it.',
          reason: 'not_synchronized',
        });
      }
    } else {
      console.warn(
        `[storage] FORCED promotion of ${name} to primary by admin ${adminId(req) ?? 'unknown'} `
        + '— objects the previous primary held may be unavailable until a sync completes.',
      );
    }

    pool.primary = name;
    entry.enabled = true;
    await writeStoragePool(serverConfig, pool);
    res.json({ ...serializePool(await readStoragePool(serverConfig)), forced: body.force === true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Remove a vendor from the pool ───────────────────────────────
//
// Removing an entry does not delete anything on the vendor — it deletes the
// platform's KNOWLEDGE of it: the credentials and the pool entry that make it
// a lifecycle-deletion scope. A vendor that ever received mirrored writes and
// is then forgotten keeps `workspace/...` and `users/...` objects that no
// future workspace or account deletion can ever reach.
//
// So the ordinary path is not "remove", it is RETIRE: switch the vendor off
// (PATCH enabled:false). It then receives no new writes while remaining a
// deletion scope, which is what keeps owner deletion honest.
//
// Hard removal is allowed only when the vendor is verifiably free of managed
// data, and "cannot verify" counts as "not free". `force: true` is the named
// destructive escape hatch for recovery, and says plainly what it costs.

/**
 * Every canonical root the platform writes (server/services/storage/keys.ts).
 * `platform/` belongs here as much as the owner-scoped roots: a full replica
 * sync copies platform-owned objects too, and forgetting a vendor that holds
 * them loses them just as completely.
 */
const MANAGED_PREFIXES = ['workspace/', 'users/', 'platform/'];

/**
 * Does this vendor still hold managed objects? A listing that fails is
 * reported as unverifiable — never as empty.
 *
 * One page per prefix is enough for an empty/non-empty answer: the listing is
 * issued without a delimiter, so a prefix that contains anything at all
 * returns at least one key in its first page. This is not a walk and must not
 * be turned into one.
 */
async function managedDataCheck(
  provider: string,
  config: Record<string, unknown>,
): Promise<{ clean: boolean; reason?: string; sample?: string }> {
  const storageConfig = storageConfigFromRecord(provider, config);
  for (const prefix of MANAGED_PREFIXES) {
    const listed = await listWithConfig(storageConfig, prefix);
    if (!listed.success) {
      return { clean: false, reason: `could not list ${prefix}: ${listed.error ?? 'unknown error'}` };
    }
    const keys = listed.keys ?? [];
    if (keys.length > 0) {
      return { clean: false, reason: `still holds objects under ${prefix}`, sample: keys[0] };
    }
  }
  return { clean: true };
}

adminStorageProvidersRouter.delete('/:providerName', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    const entry = pool.providers[name];
    if (!entry) return res.status(404).json({ error: 'Provider is not configured' });
    if (pool.primary === name && Object.keys(pool.providers).length > 1) {
      return res.status(400).json({
        error: 'Promote another vendor to primary before removing this one',
      });
    }

    if (!body.force) {
      const check = await managedDataCheck(name, entry.config);
      if (!check.clean) {
        return res.status(409).json({
          error:
            `This vendor cannot be removed: ${check.reason}. Removing it would leave that data `
            + 'unreachable by workspace and account deletion forever. Switch it off instead — a '
            + 'retired vendor receives no new writes but is still purged when an owner is deleted.',
          reason: 'managed_data_present',
          sample: check.sample ?? null,
        });
      }
    } else {
      console.warn(
        `[storage] FORCED removal of storage vendor ${name} by admin ${adminId(req) ?? 'unknown'} `
        + '— any workspace/user objects it still holds are now unreachable by owner deletion.',
      );
    }

    delete pool.providers[name];
    if (pool.primary === name) pool.primary = null;
    await writeStoragePool(serverConfig, pool);
    res.json({ ...serializePool(await readStoragePool(serverConfig)), forced: body.force === true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Test one vendor's credentials (real upload + delete) ────────

adminStorageProvidersRouter.post('/:providerName/test', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    if (!allowExpensiveCall(`test:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many connection tests — try again in a minute' });
    }

    const pool = await readStoragePool(ctx(req).serverConfig);
    const entry = pool.providers[name] ?? emptyPool().providers[name];
    if (!entry) return res.status(404).json({ error: 'Provider is not configured' });

    const result = await testStorageConnection(storageConfigFromRecord(name, entry.config));
    res.json(result);
  } catch (e) { fail(res, e); }
});
