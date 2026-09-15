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
  type StoragePool,
} from '../services/storage/pool.js';
import {
  SUPPORTED_STORAGE_PROVIDERS,
  storageConfigFromRecord,
  testStorageConnection,
  syncStorageReplica,
} from '../services/storage/index.js';

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
        syncedAt: entry.syncedAt ?? null,
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
    pool.replication = {
      enabled: body.enabled,
      mirrorDeletes: body.mirrorDeletes ?? pool.replication.mirrorDeletes,
    };
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

const saveSchema = z.object({
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  enabled: z.boolean().optional(),
  makePrimary: z.boolean().optional(),
});

adminStorageProvidersRouter.put('/:providerName', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const body = saveSchema.parse(req.body);
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    const existing = pool.providers[name];
    const merged = mergeConfig(existing?.config ?? {}, body.config);

    pool.providers[name] = {
      enabled: body.enabled ?? existing?.enabled ?? true,
      config: merged,
      updatedAt: new Date().toISOString(),
      syncedAt: existing?.syncedAt ?? null,
      syncedFrom: existing?.syncedFrom ?? null,
      sync: existing?.sync ?? null,
    };

    // New credentials can point at a different bucket entirely, so whatever
    // an earlier back-fill proved about this vendor no longer holds.
    if (JSON.stringify(merged) !== JSON.stringify(existing?.config ?? {})) {
      clearSyncReadiness(pool.providers[name]);
    }

    // First vendor ever saved becomes the primary — otherwise the platform
    // would hold credentials nothing actually writes through.
    if (body.makePrimary || !pool.primary) pool.primary = name;

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

adminStorageProvidersRouter.delete('/:providerName', async (req, res) => {
  try {
    const name = providerNameOf(req, res);
    if (!name) return;
    const serverConfig = ctx(req).serverConfig;

    const pool = await readStoragePool(serverConfig);
    if (!pool.providers[name]) return res.status(404).json({ error: 'Provider is not configured' });
    if (pool.primary === name && Object.keys(pool.providers).length > 1) {
      return res.status(400).json({
        error: 'Promote another vendor to primary before removing this one',
      });
    }

    delete pool.providers[name];
    if (pool.primary === name) pool.primary = null;
    await writeStoragePool(serverConfig, pool);
    res.json(serializePool(await readStoragePool(serverConfig)));
  } catch (e) { fail(res, e); }
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
