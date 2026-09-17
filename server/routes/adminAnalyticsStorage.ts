/**
 * ADMIN — ANALYTICS STORAGE
 *
 * Mounted under the admin router, so `requireAdmin` (platform admin,
 * verified server-side) already gates every route here.
 *
 * This screen selects ROLES, never credentials. It returns provider names,
 * non-secret status and health — and nothing else. There is deliberately no
 * endpoint here that accepts an access key, a secret or an endpoint URL:
 * analytics references the vendors configured in Providers → Storage, and
 * the only way to change a credential remains that screen. A second copy of
 * the same secret is a second thing to rotate and a second thing to leak.
 *
 * Every write here touches the analytics runtime-config key ONLY. Nothing in
 * this file can move the general storage primary or its mirrors.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  ANALYTICS_DEFAULTS, ANALYTICS_LIMITS, ANALYTICS_PRIMARY_ELIGIBLE, ANALYTICS_REPLICA_ELIGIBLE,
  AnalyticsPoolConflictError,
  analyticsReplicaHealth, clearAnalyticsReadiness, isAnalyticsPrimaryEligible,
  isAnalyticsReplicaEligible, isAnalyticsReplicaSynchronized, MAX_KNOWN_PREFIXES, normalizeAnalyticsPrefix,
  readAnalyticsPool, resolveAnalyticsTopology, writeAnalyticsPool,
  type AnalyticsStoragePool,
} from '../services/analytics/pool.js';
import { syncAnalyticsReplica, testAnalyticsProvider, verifyAnalyticsObject } from '../services/analytics/replication.js';
import {
  backfillWorkspaceDay,
  backfillWorkspaceRange,
  pendingBackfillDays,
  MAX_BACKFILL_DAYS_PER_CALL,
} from '../services/analytics/backfill.js';
import { bufferedRowCount, flushAnalytics } from '../services/analytics/writer.js';
import { duckDbAvailability, queryHealth } from '../services/analytics/duckdb.js';
import type { FunnelStepDefinition } from '../services/webAnalytics/store/types.js';
import { paritySummary, redactParityRun } from '../services/webAnalytics/store/parity.js';
import { runSealCycle, unsealDays } from '../services/analytics/sealing.js';
import {
  officialStore, runParity, shadowStore,
} from '../services/webAnalytics/store/index.js';
import { readStoragePool } from '../services/storage/pool.js';
import { storageConfigFromRecord } from '../services/storage/index.js';

export const adminAnalyticsStorageRouter = Router();

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
  if (err instanceof AnalyticsPoolConflictError) {
    res.status(409).json({
      error: 'Analytics storage settings changed while this request was in flight — reload and try again.',
      reason: 'revision_conflict',
    });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'Unexpected error' });
}

// ─── Test / sync / backfill rate limit: 5 per minute per admin ───

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
export function __resetAnalyticsAdminRateLimit(): void {
  rateHits.clear();
}

// ─── Serialization ───────────────────────────────────────────────

/**
 * Everything the panel needs, with nothing secret in it.
 *
 * `generalPrimary` is included precisely so the UI can show the two
 * primaries side by side and make it obvious that they are independent
 * choices. It is read-only here — this router has no path that writes it.
 */
async function serialize(serverConfig: ServerConfig, pool: AnalyticsStoragePool) {
  const generalPool = await readStoragePool(serverConfig);

  const providers = Object.entries(generalPool.providers).map(([name, entry]) => {
    const configured = Object.keys(entry.config).length > 0;
    const isPrimary = pool.primary === name;
    const isReplica = pool.replicas.includes(name);
    return {
      name,
      configured,
      /** The vendor's state in GENERAL storage — shown for context, never acted on here. */
      generalEnabled: entry.enabled,
      generalRole: generalPool.primary === name ? 'primary' : entry.enabled ? 'mirror' : 'off',
      analyticsPrimaryEligible: isAnalyticsPrimaryEligible(name),
      analyticsReplicaEligible: isAnalyticsReplicaEligible(name),
      analyticsRole: isPrimary ? 'primary' : isReplica ? 'replica' : 'none',
      /** Promotion correctness only — not a status feed. */
      health: isReplica ? analyticsReplicaHealth(pool, name) : null,
      synchronized: isPrimary || (isReplica && isAnalyticsReplicaSynchronized(pool, name)),
      /** Whether a sync walk is mid-flight, so the button can resume it. */
      syncInFlight: !!pool.replicaState[name]?.sync && !pool.replicaState[name]!.sync!.done,
    };
  });

  const [topology, engine] = await Promise.all([
    resolveAnalyticsTopology(serverConfig, pool),
    duckDbAvailability(),
  ]);

  return {
    enabled: pool.enabled,
    primary: pool.primary,
    replicas: pool.replicas,
    replicationEnabled: pool.replicationEnabled,
    prefix: pool.prefix,
    batchRows: pool.batchRows,
    batchBytes: pool.batchBytes,
    flushIntervalMs: pool.flushIntervalMs,
    format: pool.format,
    compression: pool.compression,
    writeMode: pool.writeMode,
    readMode: pool.readMode,
    /** Compare-and-set token; bumped by every committed write. */
    revision: pool.revision,
    /**
     * Whether the embedded query engine is present in THIS build. Not a
     * metric — a capability, and the reason an S3 read may be impossible.
     */
    duckdbAvailable: engine.available,
    /** Named as an analytics role but holding no credentials — the panel links to Provider Settings. */
    missingCredentials: topology.missingCredentials,
    /** The GENERAL storage primary — shown so the independence is visible. Read-only. */
    generalPrimary: generalPool.primary,
    providers,
    limits: ANALYTICS_LIMITS,
    defaults: ANALYTICS_DEFAULTS,
    primaryEligible: ANALYTICS_PRIMARY_ELIGIBLE,
    replicaEligible: ANALYTICS_REPLICA_ELIGIBLE,
  };
}

async function respond(req: Request, res: Response): Promise<void> {
  const serverConfig = ctx(req).serverConfig;
  res.json(await serialize(serverConfig, await readAnalyticsPool(serverConfig)));
}

// ─── GET — current state ─────────────────────────────────────────

adminAnalyticsStorageRouter.get('/', async (req, res) => {
  try { await respond(req, res); } catch (e) { fail(res, e); }
});

// ─── Settings ────────────────────────────────────────────────────

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  replicationEnabled: z.boolean().optional(),
  prefix: z.string().max(200).optional(),
  batchRows: z.number().int().optional(),
  batchBytes: z.number().int().optional(),
  flushIntervalMs: z.number().int().optional(),
  /**
   * Accepted but gated: Phase 1 is dual-write only. `s3_only` would stop
   * PostgreSQL receiving rows, and `readMode: 's3'` would serve reports from
   * a store nothing has validated yet — both are Phase 2/3 cutovers that
   * need their own approval, so they are refused here rather than silently
   * available behind a toggle.
   */
  writeMode: z.enum(['dual_write', 's3_only']).optional(),
  readMode: z.enum(['postgres', 's3']).optional(),
}).strict();

adminAnalyticsStorageRouter.put('/settings', async (req, res) => {
  try {
    const body = settingsSchema.parse(req.body);
    const serverConfig = ctx(req).serverConfig;

    if (body.writeMode === 's3_only') {
      return res.status(409).json({
        error: 'S3-only writes are a Phase 3 cutover and are not enabled in this build. '
          + 'Analytics stays dual-write until the S3 read path has been validated.',
        reason: 'phase_locked',
      });
    }

    if (body.readMode === 's3') {
      // Phase-locked today. The engine check runs anyway and is reported
      // alongside, because it is the condition that outlives the lock: a
      // build with no query engine can never serve reports from S3, and
      // finding that out at cutover would be the worst possible moment.
      const engine = await duckDbAvailability();
      return res.status(409).json({
        error: 'Reading reports from S3 is a Phase 3 cutover and is not enabled in this build.',
        reason: 'phase_locked',
        engine: {
          available: engine.available,
          reason: engine.available === false ? engine.reason : null,
        },
      });
    }

    const pool = await readAnalyticsPool(serverConfig);

    if (body.enabled === true && !pool.primary) {
      return res.status(409).json({
        error: 'Choose an analytics primary before enabling analytics storage.',
        reason: 'no_primary',
      });
    }

    if (body.enabled !== undefined) pool.enabled = body.enabled;
    if (body.prefix !== undefined) {
      const next = normalizeAnalyticsPrefix(body.prefix);
      // Every prefix ever used stays in the history because workspace
      // deletion walks all of them. That list cannot grow without bound, so
      // the change is refused rather than an old prefix being evicted —
      // evicting one would make the objects under it permanently
      // unpurgeable.
      if (next !== pool.prefix && pool.knownPrefixes.length >= MAX_KNOWN_PREFIXES) {
        return res.status(409).json({
          error: `Analytics storage has already used ${MAX_KNOWN_PREFIXES} prefixes. Every one of them is `
            + 'still walked when a workspace is deleted, so the list cannot grow further. Purge and '
            + 'consolidate the old prefixes before changing it again.',
          reason: 'prefix_history_full',
        });
      }
      // The prefix IS the namespace. Moving it strands every object already
      // written under the old one, and leaves replicas holding a prefix no
      // sync will ever walk again — so readiness is invalidated, exactly as
      // a location change does on the general pool.
      if (next !== pool.prefix) {
        for (const state of Object.values(pool.replicaState)) clearAnalyticsReadiness(state);
      }
      pool.prefix = next;
    }
    if (body.replicationEnabled !== undefined) {
      // The moment mirroring stops, every replica starts falling behind
      // silently, with no failed write to record. Switching it off therefore
      // invalidates readiness outright — turning it back on must not
      // resurrect a proof that stopped being true while it was off.
      if (pool.replicationEnabled && !body.replicationEnabled) {
        for (const state of Object.values(pool.replicaState)) clearAnalyticsReadiness(state);
      }
      pool.replicationEnabled = body.replicationEnabled;
    }
    if (body.batchRows !== undefined) pool.batchRows = body.batchRows;
    if (body.batchBytes !== undefined) pool.batchBytes = body.batchBytes;
    if (body.flushIntervalMs !== undefined) pool.flushIntervalMs = body.flushIntervalMs;

    await writeAnalyticsPool(serverConfig, pool);
    await respond(req, res);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Analytics primary ───────────────────────────────────────────

/**
 * Promotion, not a label change: the analytics primary is the canonical
 * store and the source every replica sync copies FROM. An object the new
 * primary never received stops being reachable the moment it is promoted.
 *
 * So a normal promotion requires all of:
 *   1. the vendor is eligible to be an analytics primary (capability, not brand),
 *   2. it holds credentials in Providers → Storage,
 *   3. it answers a real analytics round trip right now (PUT/GET/LIST/DELETE),
 *   4. when there IS a current primary and the target is one of its replicas,
 *      the server itself recorded a completed whole-namespace sync from that
 *      primary with zero failures.
 *
 * (4) is read from state the sync walk writes, never from a flag the browser
 * sends. `force` exists for recovery — the current primary is gone and an
 * incomplete replica beats nothing — and is logged and echoed back.
 *
 * This route writes the ANALYTICS key only. It cannot change the general
 * storage primary, and the general promotion route cannot change this one.
 */
adminAnalyticsStorageRouter.post('/primary/:providerName', async (req, res) => {
  try {
    const name = String(req.params.providerName ?? '');
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const serverConfig = ctx(req).serverConfig;

    if (!isAnalyticsPrimaryEligible(name)) {
      return res.status(400).json({
        error: 'This vendor cannot be an analytics primary: analytics needs an S3-compatible endpoint '
          + 'with listing and ranged reads so Parquet objects can be walked and queried directly.',
        reason: 'not_eligible',
      });
    }

    const pool = await readAnalyticsPool(serverConfig);
    if (pool.primary === name) return await respond(req, res);

    const generalPool = await readStoragePool(serverConfig);
    const entry = generalPool.providers[name];
    if (!entry || Object.keys(entry.config).length === 0) {
      return res.status(409).json({
        error: 'This vendor has no stored credentials. Configure it in Providers → Storage first.',
        reason: 'not_configured',
      });
    }

    const previousPrimary = pool.primary;
    const wasReplica = previousPrimary !== null && pool.replicas.includes(name);

    if (!body.force) {
      const reachable = await testAnalyticsProvider(
        serverConfig, name, storageConfigFromRecord(name, entry.config), pool.prefix,
      );
      if (!reachable.success) {
        return res.status(409).json({
          error: `This vendor did not pass the analytics round trip: ${reachable.error ?? 'unknown error'}`,
          reason: 'unreachable',
          steps: reachable.steps,
        });
      }
      if (wasReplica && !isAnalyticsReplicaSynchronized(pool, name)) {
        return res.status(409).json({
          error: 'This replica has not been proven to hold everything the current analytics primary holds. '
            + 'Run a full sync until it reports complete, then promote it.',
          reason: 'not_synchronized',
        });
      }
      if (previousPrimary && !wasReplica) {
        return res.status(409).json({
          error: 'This vendor is not an analytics replica, so nothing has ever copied the existing analytics '
            + 'objects to it. Add it as a replica and sync it first.',
          reason: 'not_a_replica',
        });
      }
    } else {
      console.warn(
        `[analytics] FORCED analytics primary change to ${name} by admin ${adminId(req) ?? 'unknown'} `
        + '— objects the previous analytics primary held may be unavailable until a sync completes.',
      );
    }

    pool.primary = name;
    // The new primary is no longer one of its own replicas.
    pool.replicas = pool.replicas.filter((r) => r !== name);
    delete pool.replicaState[name];
    // Every remaining replica was proven against the OLD primary. That proof
    // says nothing about the new one.
    for (const state of Object.values(pool.replicaState)) clearAnalyticsReadiness(state);
    // The demoted primary becomes a replica so its existing objects stay
    // covered by replication and by sync, instead of silently leaving the
    // topology while still holding data.
    if (previousPrimary && isAnalyticsReplicaEligible(previousPrimary) && !pool.replicas.includes(previousPrimary)) {
      pool.replicas.push(previousPrimary);
      pool.replicaState[previousPrimary] = {};
    }

    await writeAnalyticsPool(serverConfig, pool);
    const payload = await serialize(serverConfig, await readAnalyticsPool(serverConfig));
    res.json({ ...payload, forced: body.force === true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Analytics replicas ──────────────────────────────────────────

adminAnalyticsStorageRouter.put('/replicas', async (req, res) => {
  try {
    const body = z.object({ replicas: z.array(z.string().min(2)).max(10) }).strict().parse(req.body);
    const serverConfig = ctx(req).serverConfig;
    const pool = await readAnalyticsPool(serverConfig);

    const requested = [...new Set(body.replicas)];
    if (pool.primary && requested.includes(pool.primary)) {
      return res.status(400).json({
        error: 'The analytics primary cannot also be a replica.',
        reason: 'primary_as_replica',
      });
    }
    const ineligible = requested.filter((name) => !isAnalyticsReplicaEligible(name));
    if (ineligible.length > 0) {
      return res.status(400).json({
        error: `These vendors cannot hold analytics replicas: ${ineligible.join(', ')}`,
        reason: 'not_eligible',
      });
    }

    const generalPool = await readStoragePool(serverConfig);
    const unconfigured = requested.filter(
      (name) => Object.keys(generalPool.providers[name]?.config ?? {}).length === 0,
    );
    if (unconfigured.length > 0) {
      return res.status(409).json({
        error: `These vendors have no stored credentials: ${unconfigured.join(', ')}. `
          + 'Configure them in Providers → Storage first.',
        reason: 'not_configured',
      });
    }

    // A replica that is removed loses its state; one that is added starts
    // with none, which reads as "never synchronized" until a walk proves
    // otherwise. Neither is allowed to inherit a stale proof.
    const nextState: AnalyticsStoragePool['replicaState'] = {};
    for (const name of requested) nextState[name] = pool.replicaState[name] ?? {};
    pool.replicas = requested;
    pool.replicaState = nextState;

    await writeAnalyticsPool(serverConfig, pool);
    await respond(req, res);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Sync one replica ────────────────────────────────────────────

// No cursor from the client: the walk's position lives on the server, so
// "give me the next batch" cannot be turned into "pretend I already walked
// everything" by a crafted request.
const syncSchema = z.object({
  target: z.string().min(2),
  /** A sub-prefix WITHIN the analytics namespace — it is appended, never substituted. */
  prefix: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  restart: z.boolean().optional(),
}).strict();

adminAnalyticsStorageRouter.post('/sync', async (req, res) => {
  try {
    const body = syncSchema.parse(req.body);
    if (!allowExpensiveCall(`analytics-sync:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many sync runs — try again in a minute' });
    }
    const result = await syncAnalyticsReplica(ctx(req).serverConfig, {
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

// ─── Provider health ─────────────────────────────────────────────

/**
 * Is this provider reachable RIGHT NOW?
 *
 * A live round trip, every time — never a stored status. The whole reason
 * the panel shows nothing but "Connected" is that the word has to mean
 * something at the moment it is read, and a cached badge cannot.
 *
 * Writes a tiny Parquet object under `<prefix>_healthcheck/`, reads it back,
 * queries it with the embedded engine when one is available, and deletes it.
 * Nothing is recorded anywhere: the answer is the HTTP response.
 */
adminAnalyticsStorageRouter.post('/test/:providerName', async (req, res) => {
  try {
    const name = String(req.params.providerName ?? '');
    if (!isAnalyticsReplicaEligible(name)) {
      return res.status(400).json({ connected: false, error: 'not_eligible' });
    }
    if (!allowExpensiveCall(`analytics-test:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ connected: false, error: 'rate_limited' });
    }
    const serverConfig = ctx(req).serverConfig;
    const generalPool = await readStoragePool(serverConfig);
    const entry = generalPool.providers[name];
    if (!entry || Object.keys(entry.config).length === 0) {
      return res.status(404).json({ connected: false, error: 'not_configured' });
    }
    const pool = await readAnalyticsPool(serverConfig);
    const result = await testAnalyticsProvider(
      serverConfig, name, storageConfigFromRecord(name, entry.config), pool.prefix,
    );
    // Deliberately narrow: connected, and a short machine-readable reason.
    // No latency, no per-step breakdown, nothing persisted.
    res.json(
      result.success
        ? { connected: true }
        : { connected: false, error: 'connection_failed' },
    );
  } catch {
    res.json({ connected: false, error: 'connection_failed' });
  }
});

/**
 * The same live test for the primary and every replica at once, so opening
 * the panel shows current truth rather than a remembered one.
 */
adminAnalyticsStorageRouter.get('/connections', async (req, res) => {
  try {
    const serverConfig = ctx(req).serverConfig;
    const pool = await readAnalyticsPool(serverConfig);
    const generalPool = await readStoragePool(serverConfig);

    const check = async (name: string) => {
      const entry = generalPool.providers[name];
      if (!entry || Object.keys(entry.config).length === 0) {
        return { provider: name, connected: false, error: 'not_configured' };
      }
      try {
        const result = await testAnalyticsProvider(
          serverConfig, name, storageConfigFromRecord(name, entry.config), pool.prefix,
        );
        return result.success
          ? { provider: name, connected: true }
          : { provider: name, connected: false, error: 'connection_failed' };
      } catch {
        return { provider: name, connected: false, error: 'connection_failed' };
      }
    };

    const [primary, replicas] = await Promise.all([
      pool.primary ? check(pool.primary) : Promise.resolve(null),
      Promise.all(pool.replicas.map(check)),
    ]);

    res.json({ primary, replicas });
  } catch (e) { fail(res, e); }
});

// ─── Flush now (diagnostics) ─────────────────────────────────────

adminAnalyticsStorageRouter.post('/flush', async (req, res) => {
  try {
    if (!allowExpensiveCall(`analytics-flush:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many flush runs — try again in a minute' });
    }
    // Only drains THIS process's buffer — each backend replica owns its own.
    const result = await flushAnalytics(ctx(req).serverConfig, { reason: 'admin', force: true });
    res.json(result);
  } catch (e) { fail(res, e); }
});

// ─── Integrity check for one object ──────────────────────────────

adminAnalyticsStorageRouter.post('/verify', async (req, res) => {
  try {
    const body = z.object({ objectKey: z.string().min(1).max(1024) }).strict().parse(req.body);
    const serverConfig = ctx(req).serverConfig;
    const pool = await readAnalyticsPool(serverConfig);
    // Confined to the analytics namespace: this endpoint must never become a
    // way to read back a `workspace/` or `users/` object.
    if (!body.objectKey.startsWith(pool.prefix) || body.objectKey.includes('..')) {
      return res.status(400).json({ error: 'Object key is outside the analytics namespace.' });
    }
    res.json(await verifyAnalyticsObject(serverConfig, body.objectKey));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Backfill ────────────────────────────────────────────────────

adminAnalyticsStorageRouter.get('/backfill/:workspaceId/pending', async (req, res) => {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const days = await pendingBackfillDays(ctx(req).serverConfig, workspaceId);
    res.json({ workspaceId, days });
  } catch (e) { fail(res, e); }
});

const backfillSchema = z.object({
  workspaceId: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

const backfillRangeSchema = z.object({
  workspaceId: z.string().uuid(),
  fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxDays: z.number().int().min(1).max(MAX_BACKFILL_DAYS_PER_CALL).optional(),
}).strict();

/**
 * Rebuild a DATE RANGE for one workspace — the production backfill control.
 *
 * Bounded per call and resumable: the response carries `nextDay`, and the
 * caller runs again from there. Idempotent, because each day supersedes its
 * own previous output. Nothing is ever deleted from PostgreSQL.
 */
adminAnalyticsStorageRouter.post('/backfill/range', async (req, res) => {
  try {
    const body = backfillRangeSchema.parse(req.body);
    if (!allowExpensiveCall(`analytics-backfill:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many backfill runs — try again in a minute' });
    }
    const result = await backfillWorkspaceRange(
      ctx(req).serverConfig, body.workspaceId, body.fromDay, body.toDay,
      { maxDays: body.maxDays },
    );
    if (!result.ok) return res.status(400).json({ error: result.error });

    const report = result.report!;
    res.json({
      report: {
        workspaceId: report.workspaceId,
        fromDay: report.fromDay,
        toDay: report.toDay,
        attempted: report.attempted,
        verifiedDays: report.verifiedDays,
        failedDays: report.failedDays,
        sourceRows: report.sourceRows,
        writtenRows: report.writtenRows,
        objects: report.objects,
        bytes: report.bytes,
        replaced: report.replaced,
        nextDay: report.nextDay,
      },
      maxDaysPerCall: MAX_BACKFILL_DAYS_PER_CALL,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

adminAnalyticsStorageRouter.post('/backfill', async (req, res) => {
  try {
    const body = backfillSchema.parse(req.body);
    if (!allowExpensiveCall(`analytics-backfill:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many backfill runs — try again in a minute' });
    }
    const result = await backfillWorkspaceDay(ctx(req).serverConfig, body.workspaceId, body.day);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ report: result.report });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Phase 2 — shadow read / parity ──────────────────────────────

/**
 * Longest range a single parity run may cover.
 *
 * A parity run answers EVERY report twice, once against PostgreSQL (capped
 * at ROW_CAP) and once against the lake (uncapped, so it fetches every
 * object in range). An unbounded range is therefore an accidental
 * full-history scan of object storage triggered by a date picker, which is
 * exactly the shape of mistake this limit exists to make impossible.
 */
const MAX_PARITY_DAYS = 92;

const paritySchema = z.object({
  workspaceId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Also compare the workspace's configured funnels. Off by default: each is extra queries. */
  includeFunnels: z.boolean().optional(),
}).strict();

function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.NaN;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * Load one configured funnel's steps so the production run covers funnels
 * too. The funnel DEFINITION stays in PostgreSQL (`web_analytics_funnels`);
 * only the computation is compared.
 */
async function firstFunnelSteps(
  serverConfig: ServerConfig,
  workspaceId: string,
): Promise<FunnelStepDefinition[] | null> {
  try {
    const sb = getServiceClient(serverConfig);
    const { data } = await sb
      .from('web_analytics_funnels')
      .select('steps')
      .eq('workspace_id', workspaceId)
      .limit(1)
      .maybeSingle();
    const steps = (data as { steps?: unknown } | null)?.steps;
    return Array.isArray(steps) && steps.length > 0 ? (steps as FunnelStepDefinition[]) : null;
  } catch {
    return null;
  }
}

/**
 * Run a parity comparison on demand — the production validation tool.
 *
 * The same reports are answered by both stores and the results compared;
 * PostgreSQL remains the official source throughout, and nothing about this
 * endpoint can change what a workspace's own Web Analytics page returns.
 *
 * The response is REDACTED: dimension values (page paths, cities, campaign
 * and event names) are replaced with stable digests, because this panel
 * belongs to a platform operator rather than to the workspace whose data it
 * is comparing. Counts, timings and field names survive, which is what
 * makes a mismatch diagnosable.
 */
adminAnalyticsStorageRouter.post('/parity', async (req, res) => {
  try {
    const body = paritySchema.parse(req.body);

    const days = daysBetween(body.startDate, body.endDate);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: 'endDate must be on or after startDate', reason: 'invalid_range' });
    }
    if (days > MAX_PARITY_DAYS) {
      return res.status(400).json({
        error: `A parity run covers at most ${MAX_PARITY_DAYS} days; this range is ${days}.`,
        reason: 'range_too_large',
        maxDays: MAX_PARITY_DAYS,
      });
    }

    if (!allowExpensiveCall(`analytics-parity:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many parity runs — try again in a minute' });
    }

    const serverConfig = ctx(req).serverConfig;
    const funnelSteps = body.includeFunnels
      ? await firstFunnelSteps(serverConfig, body.workspaceId)
      : null;

    const run = await runParity(
      serverConfig,
      officialStore(serverConfig),
      shadowStore(serverConfig),
      body.workspaceId,
      { startDate: body.startDate, endDate: body.endDate },
      funnelSteps ? { funnelSteps } : undefined,
    );

    res.json({
      run: redactParityRun(run),
      summary: paritySummary(run),
      days,
      funnelsCompared: !!funnelSteps,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});

// ─── Phase 2 — day sealing (buffer durability) ───────────────────

/**
 * Run a sealing cycle now.
 *
 * Sealing normally runs on its own ticker; this exists so an operator can
 * force the lake to catch up after an incident without waiting for the next
 * cycle, and so the result is visible rather than only in logs.
 */
adminAnalyticsStorageRouter.post('/seal', async (req, res) => {
  try {
    if (!allowExpensiveCall(`analytics-seal:${adminId(req) ?? 'unknown'}`)) {
      return res.status(429).json({ error: 'Too many seal runs — try again in a minute' });
    }
    res.json(await runSealCycle(ctx(req).serverConfig));
  } catch (e) { fail(res, e); }
});

const unsealSchema = z.object({
  workspaceId: z.string().uuid(),
  fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

/**
 * Mark days for rebuild.
 *
 * Non-destructive: it clears a bookkeeping flag, and the next cycle rewrites
 * those days from PostgreSQL. This is the operator-facing half of the same
 * mechanism the privacy anonymizer uses automatically.
 */
adminAnalyticsStorageRouter.post('/unseal', async (req, res) => {
  try {
    const body = unsealSchema.parse(req.body);
    const unsealed = await unsealDays(ctx(req).serverConfig, body.workspaceId, body.fromDay, body.toDay);
    res.json({ unsealed });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input' });
    fail(res, e);
  }
});
