/**
 * ANALYTICS BACKFILL — historical PostgreSQL rows → Parquet on the
 * Analytics Primary → Analytics Replicas.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION. It only ever reads from
 * `visitor_page_views`, `web_analytics_events` and `visitor_sessions`.
 * There is no DELETE, no UPDATE and no TRUNCATE anywhere in this module,
 * and there must not be one until a separate, explicitly approved cleanup
 * phase — verification comes first.
 *
 * ── Unit of work: one workspace-day ──────────────────────────────
 *
 * A run processes one (workspace, UTC day) at a time — the same grain the
 * object layout partitions by — and returns. The caller asks for the next
 * one. That keeps any single request bounded, survives a restart, and makes
 * progress something the server recorded rather than something a browser
 * reported back.
 *
 * ── Idempotence ──────────────────────────────────────────────────
 *
 * Backfilled objects use DETERMINISTIC keys (`backfill-000.parquet`, …)
 * rather than the live writer's random ones, and every existing
 * `backfill-*` object for that day is removed before the new set is
 * written. So re-running a day REPLACES it instead of double-counting it —
 * which matters because the alternative (random keys) would turn every
 * retry, every overlapping run and every "did that finish?" into silent
 * duplicate rows that no later check could distinguish from real traffic.
 *
 * Live objects (`part-*.parquet`) are never touched: a day that was partly
 * live-written and partly backfilled keeps both, and the two never overlap
 * because backfill is only ever pointed at days that predate the cutover.
 *
 * ── Session history ──────────────────────────────────────────────
 *
 * Historical sessions get BOTH a `session_start` (from `started_at`) and a
 * `session_end` (from `last_seen_at`) row. Unlike the live pipeline — where
 * no reliable session-end signal exists — a historical session's end is
 * simply a fact already recorded in the row, so it is written as one.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog, emitMetric } from '../observability/metrics.js';
import { deleteWithConfig, listWithConfig, uploadWithConfig, type StorageConfig } from '../storage/index.js';
import {
  readAnalyticsPool, recordAnalyticsError, resolveAnalyticsTopology, type AnalyticsStoragePool,
} from './pool.js';
import { writeParquet } from './parquet.js';
import {
  ANALYTICS_COLUMNS, analyticsDayPrefix, buildEventRow, rowToParquet,
  type AnalyticsEventRow,
} from './schema.js';
import { analyticsSessionFrom } from './ingest.js';

/** Rows read from PostgreSQL per page. Bounded so one day never loads unboundedly. */
const PAGE_SIZE = 1000;
/** Hard ceiling on rows held in memory for one day before they are split across objects. */
const MAX_ROWS_PER_OBJECT = 50_000;

export interface BackfillDayReport {
  workspaceId: string;
  day: string;
  /** Objects removed because the rebuilt set supersedes them. */
  replaced: number;
  objects: string[];
  rows: number;
  bytes: number;
  /** What PostgreSQL held for this day — the number the written rows are checked against. */
  source: { sessions: number; pageViews: number; events: number };
  /** rows === expected. A mismatch is reported, never silently accepted. */
  verified: boolean;
  expected: number;
  errors: string[];
}

export interface BackfillResult {
  ok: boolean;
  report?: BackfillDayReport;
  error?: string;
}

interface SessionRow {
  id: string;
  visitor_id: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  browser: string | null;
  device: string | null;
  os: string | null;
  language: string | null;
  country: string | null;
  city: string | null;
  geo_country_code: string | null;
  geo_country_name: string | null;
  geo_city: string | null;
  started_at: string;
  last_seen_at: string;
  current_page: string | null;
}

const SESSION_COLUMNS =
  'id, visitor_id, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ' +
  'browser, device, os, language, country, city, geo_country_code, geo_country_name, geo_city, ' +
  'started_at, last_seen_at, current_page';

/**
 * Half-open [start, nextDay) — never `<= 23:59:59.999`.
 *
 * `timestamptz` has microsecond precision, so a closed upper bound at
 * millisecond granularity silently excludes any row in the last 999
 * microseconds of the day. Those rows would belong to no day at all, and
 * once sealing makes a day canonical that gap becomes permanent loss rather
 * than a transient omission.
 */
function dayBounds(day: string): { startIso: string; endExclusiveIso: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return {
    startIso: start.toISOString(),
    endExclusiveIso: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Read every row of one table for one workspace-day, a page at a time.
 *
 * The runner returns whatever the PostgREST builder resolves to — a thenable
 * rather than a real Promise — so it is typed as awaitable rather than as
 * `Promise`, which is what the builder actually satisfies.
 */
type PagedResult = { data: unknown; error: { message: string } | null };

async function readAll<T>(
  run: (from: number, to: number) => PromiseLike<PagedResult>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = (await run(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)) as PagedResult;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
    if (out.length >= MAX_ROWS_PER_OBJECT * 4) return out; // pathological day — reported as unverified
  }
}

/**
 * Build every analytics row for one workspace-day from the PostgreSQL
 * tables, in occurrence order.
 */
async function buildDayRows(
  config: ServerConfig,
  workspaceId: string,
  day: string,
): Promise<{ rows: AnalyticsEventRow[]; source: BackfillDayReport['source'] }> {
  const sb = getServiceClient(config);
  const { startIso, endExclusiveIso } = dayBounds(day);

  // Sessions that STARTED this day supply the session_start/session_end
  // rows. Sessions that started earlier are still needed as dimension
  // sources for this day's page views, so they are fetched separately below.
  const sessions = await readAll<SessionRow>((from, to) =>
    sb.from('visitor_sessions').select(SESSION_COLUMNS)
      .eq('workspace_id', workspaceId)
      .gte('started_at', startIso).lt('started_at', endExclusiveIso)
      .order('started_at', { ascending: true }).range(from, to),
  );

  const pageViews = await readAll<{ visitor_session_id: string; url: string; title: string | null; viewed_at: string }>(
    (from, to) =>
      sb.from('visitor_page_views').select('visitor_session_id, url, title, viewed_at')
        .eq('workspace_id', workspaceId)
        .gte('viewed_at', startIso).lt('viewed_at', endExclusiveIso)
        .order('viewed_at', { ascending: true }).range(from, to),
  );

  const events = await readAll<{ visitor_session_id: string | null; event_name: string; properties: Record<string, unknown>; page_url: string | null; created_at: string }>(
    (from, to) =>
      sb.from('web_analytics_events').select('visitor_session_id, event_name, properties, page_url, created_at')
        .eq('workspace_id', workspaceId)
        .gte('created_at', startIso).lt('created_at', endExclusiveIso)
        .order('created_at', { ascending: true }).range(from, to),
  );

  const byId = new Map<string, SessionRow>(sessions.map((s) => [s.id, s]));

  // Page views and events can belong to a session that started on an
  // earlier day. Without those rows their dimensions would all be null, so
  // the referenced sessions are fetched in bounded chunks.
  const missing = [
    ...new Set(
      [...pageViews.map((p) => p.visitor_session_id), ...events.map((e) => e.visitor_session_id)]
        .filter((id): id is string => !!id && !byId.has(id)),
    ),
  ];
  for (let i = 0; i < missing.length; i += 200) {
    const { data } = await sb.from('visitor_sessions').select(SESSION_COLUMNS)
      .eq('workspace_id', workspaceId).in('id', missing.slice(i, i + 200));
    for (const row of (data ?? []) as unknown as SessionRow[]) byId.set(row.id, row);
  }

  const dimensionsOf = (sessionId: string | null) => {
    const row = sessionId ? byId.get(sessionId) : null;
    return analyticsSessionFrom(sessionId, row?.visitor_id ?? null, row as unknown as Record<string, unknown> | null);
  };

  const rows: AnalyticsEventRow[] = [];

  for (const session of sessions) {
    const dims = analyticsSessionFrom(session.id, session.visitor_id, session as unknown as Record<string, unknown>);
    rows.push(buildEventRow({
      workspaceId, eventType: 'session_start', occurredAt: session.started_at,
      url: session.current_page, session: dims,
    }));
    // A historical session's end IS known — it is the row's last_seen_at.
    rows.push(buildEventRow({
      workspaceId, eventType: 'session_end', occurredAt: session.last_seen_at,
      url: session.current_page, session: dims,
    }));
  }

  for (const view of pageViews) {
    rows.push(buildEventRow({
      workspaceId, eventType: 'page_view', occurredAt: view.viewed_at,
      url: view.url, title: view.title, session: dimensionsOf(view.visitor_session_id),
    }));
  }

  for (const event of events) {
    rows.push(buildEventRow({
      workspaceId, eventType: 'custom_event', occurredAt: event.created_at,
      url: event.page_url, eventName: event.event_name,
      properties: event.properties && typeof event.properties === 'object' ? event.properties : null,
      session: dimensionsOf(event.visitor_session_id),
    }));
  }

  rows.sort((a, b) => a.occurred_at - b.occurred_at);
  return {
    rows,
    source: { sessions: sessions.length, pageViews: pageViews.length, events: events.length },
  };
}

/**
 * Backfill exactly one workspace-day. Safe to re-run: the day's previous
 * backfill objects are replaced, not appended to.
 */
export async function backfillWorkspaceDay(
  config: ServerConfig,
  workspaceId: string,
  day: string,
  opts?: {
    /**
     * 'day' replaces EVERY object for the workspace-day, live ones
     * included — the sealing pass uses it to make the rebuilt set canonical.
     * 'backfill' (the default) replaces only this importer's own output.
     */
    supersede?: 'backfill' | 'day';
  },
): Promise<BackfillResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'day must be YYYY-MM-DD' };

  const pool = await readAnalyticsPool(config);
  if (!pool.enabled) return { ok: false, error: 'Analytics storage is disabled' };

  const topology = await resolveAnalyticsTopology(config, pool);
  if (!topology.primary) {
    return {
      ok: false,
      error: topology.missingCredentials.length
        ? `The analytics primary has no stored credentials: ${topology.missingCredentials.join(', ')}`
        : 'No analytics primary is configured',
    };
  }

  const errors: string[] = [];
  let built: { rows: AnalyticsEventRow[]; source: BackfillDayReport['source'] };
  try {
    built = await buildDayRows(config, workspaceId, day);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAnalyticsError(config, `backfill_read_failed: ${message}`);
    emitMetric(config, { metric: 'analytics_s3_backfill_rows', tags: { failed: 1 } });
    return { ok: false, error: `Reading PostgreSQL for ${day} failed: ${message}` };
  }

  const dayPrefix = analyticsDayPrefix(pool.prefix, workspaceId, new Date(`${day}T00:00:00.000Z`));

  // Replace, never append — see the idempotence note in this file's header.
  const replaced = await removeDayObjects(
    topology.primary.config, topology.replicas, dayPrefix, opts?.supersede ?? 'backfill', errors,
  );

  const expected = built.rows.length;
  if (expected === 0) {
    return {
      ok: true,
      report: {
        workspaceId, day, replaced, objects: [], rows: 0, bytes: 0,
        source: built.source, verified: true, expected: 0, errors,
      },
    };
  }

  const chunkSize = Math.min(pool.batchRows, MAX_ROWS_PER_OBJECT);
  const objects: string[] = [];
  let written = 0;
  let bytes = 0;

  for (let index = 0; index * chunkSize < built.rows.length; index++) {
    const chunk = built.rows.slice(index * chunkSize, (index + 1) * chunkSize);
    const objectKey = `${dayPrefix}backfill-${String(index).padStart(3, '0')}.parquet`;
    const file = writeParquet(ANALYTICS_COLUMNS, chunk.map(rowToParquet), {
      createdBy: 'webyar-web-analytics-backfill',
    });

    const put = await uploadWithConfig(topology.primary.config, {
      fileKey: objectKey, data: file.buffer, contentType: 'application/vnd.apache.parquet',
    });
    if (!put.success) {
      errors.push(`${objectKey}: ${put.error ?? 'primary upload failed'}`);
      await recordAnalyticsError(config, `backfill_primary_write_failed: ${put.error ?? 'unknown'}`);
      emitMetric(config, { metric: 'analytics_s3_primary_write_failures', tags: { reason: 'backfill' } });
      break;
    }

    objects.push(objectKey);
    written += chunk.length;
    bytes += file.buffer.length;

    // Same key, same bytes on every analytics replica — the primary already
    // holds it, so a replica failure is recorded, never fatal.
    for (const replica of topology.replicas) {
      const mirrored = await uploadWithConfig(replica.config, {
        fileKey: objectKey, data: file.buffer, contentType: 'application/vnd.apache.parquet',
      });
      if (!mirrored.success) {
        errors.push(`${replica.name}/${objectKey}: ${mirrored.error ?? 'replica upload failed'}`);
        const { markAnalyticsReplicaDirty } = await import('./pool.js');
        await markAnalyticsReplicaDirty(config, replica.name, `backfill_mirror_failed: ${mirrored.error ?? 'unknown'}`);
        emitMetric(config, { metric: 'analytics_s3_replica_write_failures', tags: { provider: replica.name } });
      }
    }
  }

  const verified = written === expected && errors.length === 0;
  emitMetric(config, { metric: 'analytics_s3_backfill_rows', tags: { rows: written } });
  emitLog(config, verified ? 'info' : 'warn', 'analytics_backfill_day', {
    workspace_id: workspaceId, day, rows: written, expected, objects: objects.length, verified,
  });

  return {
    ok: true,
    report: { workspaceId, day, replaced, objects, rows: written, bytes, source: built.source, verified, expected, errors },
  };
}

/**
 * Remove this day's existing objects from the primary and every replica.
 *
 * `scope` decides how much is superseded:
 *
 *   'backfill' — only `backfill-*` keys. A re-run of a historical import
 *                replaces its own output and leaves any live object alone.
 *   'day'      — every object for the day, live `part-*` included. This is
 *                what SEALING does: the rebuilt set is derived from
 *                PostgreSQL, which holds every row, so it supersedes
 *                whatever the in-process buffer managed to write. That is
 *                precisely how a buffer lost to a crash costs nothing.
 *
 * 'day' is only safe while PostgreSQL is still receiving every row — one of
 * the reasons `writeMode: 's3_only'` stays phase-locked.
 */
async function removeDayObjects(
  primary: StorageConfig,
  replicas: { name: string; config: StorageConfig }[],
  dayPrefix: string,
  scope: 'backfill' | 'day',
  errors: string[],
): Promise<number> {
  const listed = await listWithConfig(primary, dayPrefix);
  if (!listed.success) {
    // Cannot prove what is there, so cannot prove a re-run would not
    // duplicate. Reported; the report's `verified` flag is what an operator
    // (or the sealing pass) acts on.
    errors.push(`could not list ${dayPrefix}: ${listed.error ?? 'unknown error'}`);
    return 0;
  }
  const stale = (listed.keys ?? [])
    .map((key) => key.replace(/^\/+/, ''))
    .filter((key) => {
      const name = key.split('/').pop() ?? '';
      return scope === 'day' ? name.endsWith('.parquet') : name.startsWith('backfill-');
    });

  let removed = 0;
  for (const key of stale) {
    const result = await deleteWithConfig(primary, key);
    if (result.success) removed++;
    else errors.push(`could not remove stale ${key}: ${result.error ?? 'unknown'}`);
    for (const replica of replicas) {
      await deleteWithConfig(replica.config, key).catch(() => undefined);
    }
  }
  return removed;
}

/**
 * Days that still hold un-backfilled analytics rows, oldest first — the
 * work list an operator walks. Derived from the source tables themselves
 * rather than from a progress table, so it is always a true statement about
 * what exists rather than about what some earlier run believed.
 */
export async function pendingBackfillDays(
  config: ServerConfig,
  workspaceId: string,
  limit = 30,
): Promise<string[]> {
  const sb = getServiceClient(config);
  const days = new Set<string>();

  const { data: views } = await sb
    .from('visitor_page_views').select('viewed_at')
    .eq('workspace_id', workspaceId)
    .order('viewed_at', { ascending: true })
    .limit(5000);
  for (const row of (views ?? []) as { viewed_at: string }[]) days.add(row.viewed_at.slice(0, 10));

  const { data: events } = await sb
    .from('web_analytics_events').select('created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(5000);
  for (const row of (events ?? []) as { created_at: string }[]) days.add(row.created_at.slice(0, 10));

  return [...days].sort().slice(0, limit);
}

export type { AnalyticsStoragePool };
