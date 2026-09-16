/**
 * SHADOW READ / PARITY — does the lake answer what PostgreSQL answers?
 *
 * Phase 2 keeps PostgreSQL as the OFFICIAL source. For a selected set of
 * reports the same question is also put to the S3 store, and the two
 * answers are compared. The shadow run never influences the response the
 * caller receives, never delays it, and cannot fail it.
 *
 * ── Known divergences are declared, not discovered ───────────────
 *
 * Two metrics are EXPECTED to differ, for reasons that are correct rather
 * than accidental (see ../store/s3.ts's header):
 *
 *   uniqueVisitors — PostgreSQL counts session rows; the lake counts
 *                    distinct visitors. The lake's number is the right one,
 *                    and the PostgreSQL number cannot be fixed in place
 *                    because `visitor_page_views` has no visitor column.
 *   avgVisitDurationSeconds — PostgreSQL measures to a heartbeat-updated
 *                    column; the lake measures to the last recorded event.
 *
 * They are reported as `expected` differences. Anything else differing is a
 * REGRESSION and is reported as such — the point of this machinery is that
 * the difference between "we changed this on purpose" and "we broke this"
 * is written down in advance.
 *
 * ── Tolerance ────────────────────────────────────────────────────
 *
 * Counts are integers and must match EXACTLY; a tolerance there would hide
 * exactly the off-by-N bugs this is meant to catch. Only derived
 * percentages get a tolerance, because both sides round independently.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { emitLog, emitMetric } from '../../observability/metrics.js';
import type { DateRange } from '../reportService.js';
import type { WebAnalyticsStore } from './types.js';

export const PARITY_STATE_KEY = 'analytics_parity_state';

/** Percentage points two independently-rounded rates may differ by. */
const RATE_TOLERANCE = 0.2;

/** Rows compared per breakdown. The long tail is dominated by ties and adds noise, not signal. */
const BREAKDOWN_COMPARE_DEPTH = 20;

export interface ParityDifference {
  report: string;
  field: string;
  postgres: string;
  s3: string;
  /** A declared, intentional difference rather than a regression. */
  expected: boolean;
}

export interface ParityReport {
  report: string;
  ok: boolean;
  differences: ParityDifference[];
  postgresMs: number;
  s3Ms: number;
  error?: string;
}

export interface ParityRun {
  at: string;
  workspaceId: string;
  range: DateRange;
  reports: ParityReport[];
  /** Differences that are NOT declared — the number that matters. */
  regressions: number;
  expectedDifferences: number;
  /** Set when the S3 side could not run at all (engine missing, no primary, …). */
  unavailable?: string;
}

/** Fields whose divergence is intentional — see this file's header. */
const EXPECTED_DIVERGENCE = new Set([
  'overview.uniqueVisitors',
  'overview.avgVisitDurationSeconds',
]);

function isExpected(report: string, field: string): boolean {
  return EXPECTED_DIVERGENCE.has(`${report}.${field}`);
}

function compareNumber(
  report: string, field: string, postgres: number, s3: number, tolerance = 0,
): ParityDifference | null {
  if (Math.abs(postgres - s3) <= tolerance) return null;
  return {
    report, field,
    postgres: String(postgres),
    s3: String(s3),
    expected: isExpected(report, field),
  };
}

function compareBreakdown(
  report: string,
  postgres: { key: string; sessions: number; pageviews: number }[],
  s3: { key: string; sessions: number; pageviews: number }[],
): ParityDifference[] {
  const differences: ParityDifference[] = [];
  const pgByKey = new Map(postgres.map((row) => [row.key, row]));
  const s3ByKey = new Map(s3.map((row) => [row.key, row]));

  const keys = [...new Set([
    ...postgres.slice(0, BREAKDOWN_COMPARE_DEPTH).map((r) => r.key),
    ...s3.slice(0, BREAKDOWN_COMPARE_DEPTH).map((r) => r.key),
  ])];

  for (const key of keys) {
    const left = pgByKey.get(key);
    const right = s3ByKey.get(key);
    if (!left || !right) {
      differences.push({
        report, field: `row:${key}`,
        postgres: left ? `${left.sessions} sessions` : 'missing',
        s3: right ? `${right.sessions} sessions` : 'missing',
        expected: false,
      });
      continue;
    }
    const sessions = compareNumber(report, `${key}.sessions`, left.sessions, right.sessions);
    if (sessions) differences.push(sessions);
    const pageviews = compareNumber(report, `${key}.pageviews`, left.pageviews, right.pageviews);
    if (pageviews) differences.push(pageviews);
  }
  return differences;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
}

type ComparableReport = {
  name: string;
  run: (store: WebAnalyticsStore) => Promise<unknown>;
  compare: (postgres: never, s3: never) => ParityDifference[];
};

/**
 * Every report compared. Deliberately covers the full surface the
 * requirement lists rather than a sample — a parity check that skipped a
 * report would leave exactly that report's cutover unproven.
 */
function comparableReports(workspaceId: string, range: DateRange): ComparableReport[] {
  const breakdown = (name: string, run: (s: WebAnalyticsStore) => Promise<{ rows: never[] }>): ComparableReport => ({
    name,
    run: async (store) => (await run(store)).rows,
    compare: (pg, s3) => compareBreakdown(name, pg as never, s3 as never),
  });

  return [
    {
      name: 'overview',
      run: (store) => store.getOverview(workspaceId, range),
      compare: (pg: never, s3: never) => {
        const a = pg as unknown as Record<string, number>;
        const b = s3 as unknown as Record<string, number>;
        return [
          compareNumber('overview', 'sessions', a.sessions, b.sessions),
          compareNumber('overview', 'pageviews', a.pageviews, b.pageviews),
          compareNumber('overview', 'uniqueVisitors', a.uniqueVisitors, b.uniqueVisitors),
          compareNumber('overview', 'bounceRate', a.bounceRate, b.bounceRate, RATE_TOLERANCE),
          compareNumber('overview', 'avgPagesPerSession', a.avgPagesPerSession, b.avgPagesPerSession, RATE_TOLERANCE),
          compareNumber('overview', 'avgVisitDurationSeconds', a.avgVisitDurationSeconds, b.avgVisitDurationSeconds, 1),
        ].filter((d): d is ParityDifference => d !== null);
      },
    },
    breakdown('trafficSources.channel', (s) => s.getTrafficSources(workspaceId, range, 'channel') as never),
    breakdown('trafficSources.source', (s) => s.getTrafficSources(workspaceId, range, 'source') as never),
    breakdown('trafficSources.campaign', (s) => s.getTrafficSources(workspaceId, range, 'campaign') as never),
    breakdown('geography.country', (s) => s.getGeography(workspaceId, range, 'country') as never),
    breakdown('geography.city', (s) => s.getGeography(workspaceId, range, 'city') as never),
    breakdown('geography.language', (s) => s.getGeography(workspaceId, range, 'language') as never),
    breakdown('geography.continent', (s) => s.getGeography(workspaceId, range, 'continent') as never),
    breakdown('browsersSystems.browser', (s) => s.getBrowsersSystems(workspaceId, range, 'browser') as never),
    breakdown('browsersSystems.os', (s) => s.getBrowsersSystems(workspaceId, range, 'os') as never),
    breakdown('browsersSystems.device', (s) => s.getBrowsersSystems(workspaceId, range, 'device') as never),
    ...(['top', 'entry', 'exit'] as const).map((kind) => ({
      name: `pages.${kind}`,
      run: async (store: WebAnalyticsStore) => (await store.getPages(workspaceId, range, kind)).rows,
      compare: (pg: never, s3: never) => {
        const a = (pg as unknown as { path: string; views: number }[]).slice(0, BREAKDOWN_COMPARE_DEPTH);
        const b = new Map((s3 as unknown as { path: string; views: number }[]).map((r) => [r.path, r.views]));
        const differences: ParityDifference[] = [];
        for (const row of a) {
          const other = b.get(row.path);
          if (other === undefined) {
            differences.push({ report: `pages.${kind}`, field: `row:${row.path}`, postgres: String(row.views), s3: 'missing', expected: false });
            continue;
          }
          const diff = compareNumber(`pages.${kind}`, row.path, row.views, other);
          if (diff) differences.push(diff);
        }
        return differences;
      },
    })),
    {
      name: 'events.tracked',
      run: async (store) => (await store.getTrackedEvents(workspaceId, range)).rows,
      compare: (pg: never, s3: never) => {
        const a = pg as unknown as { eventName: string; count: number; uniqueSessions: number }[];
        const b = new Map((s3 as unknown as { eventName: string; count: number; uniqueSessions: number }[])
          .map((r) => [r.eventName, r]));
        const differences: ParityDifference[] = [];
        for (const row of a.slice(0, BREAKDOWN_COMPARE_DEPTH)) {
          const other = b.get(row.eventName);
          if (!other) {
            differences.push({ report: 'events.tracked', field: `row:${row.eventName}`, postgres: String(row.count), s3: 'missing', expected: false });
            continue;
          }
          const count = compareNumber('events.tracked', `${row.eventName}.count`, row.count, other.count);
          if (count) differences.push(count);
          const sessions = compareNumber('events.tracked', `${row.eventName}.uniqueSessions`, row.uniqueSessions, other.uniqueSessions);
          if (sessions) differences.push(sessions);
        }
        return differences;
      },
    },
  ];
}

/**
 * Run every comparable report against both stores.
 *
 * The S3 side is allowed to be entirely unavailable — no engine, no
 * primary, nothing written yet — and that is reported rather than treated
 * as a failure of the reports themselves.
 */
export async function runParity(
  config: ServerConfig,
  postgres: WebAnalyticsStore,
  s3: WebAnalyticsStore,
  workspaceId: string,
  range: DateRange,
  opts?: { funnelSteps?: Parameters<WebAnalyticsStore['computeFunnel']>[1] },
): Promise<ParityRun> {
  const run: ParityRun = {
    at: new Date().toISOString(),
    workspaceId,
    range,
    reports: [],
    regressions: 0,
    expectedDifferences: 0,
  };

  const comparisons = comparableReports(workspaceId, range);

  if (opts?.funnelSteps && opts.funnelSteps.length > 0) {
    const steps = opts.funnelSteps;
    comparisons.push({
      name: 'events.funnel',
      run: (store) => store.computeFunnel(workspaceId, steps, range),
      compare: (pg: never, s3v: never) => {
        const a = pg as unknown as { label: string; sessions: number }[];
        const b = s3v as unknown as { label: string; sessions: number }[];
        const differences: ParityDifference[] = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          const diff = compareNumber('events.funnel', `step${i}.sessions`, a[i]?.sessions ?? -1, b[i]?.sessions ?? -1);
          if (diff) differences.push(diff);
        }
        return differences;
      },
    });
  }

  for (const comparison of comparisons) {
    try {
      const [pg, shadow] = await Promise.all([
        timed(() => comparison.run(postgres)),
        timed(() => comparison.run(s3)),
      ]);
      const differences = comparison.compare(pg.value as never, shadow.value as never);
      run.reports.push({
        report: comparison.name,
        ok: differences.every((d) => d.expected),
        differences,
        postgresMs: pg.ms,
        s3Ms: shadow.ms,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // An S3-side outage stops the whole run: every later report would
      // report the same failure, and a hundred identical errors is noise.
      if (message.includes('analytics_s3_unavailable') || message.includes('analytics_query_engine_unavailable')) {
        run.unavailable = message;
        break;
      }
      run.reports.push({
        report: comparison.name, ok: false, differences: [], postgresMs: 0, s3Ms: 0, error: message,
      });
    }
  }

  for (const report of run.reports) {
    for (const difference of report.differences) {
      if (difference.expected) run.expectedDifferences++;
      else run.regressions++;
    }
    if (report.error) run.regressions++;
  }

  emitMetric(config, {
    metric: 'analytics_s3_parity_differences',
    tags: { regressions: run.regressions, expected: run.expectedDifferences },
  });
  emitLog(config, run.regressions > 0 ? 'warn' : 'info', 'analytics_parity_run', {
    workspace_id: workspaceId,
    range: `${range.startDate}..${range.endDate}`,
    reports: run.reports.length,
    regressions: run.regressions,
    expected_differences: run.expectedDifferences,
    unavailable: run.unavailable ?? null,
  });

  await persistParity(config, run);
  return run;
}

/**
 * Keep the last run for the admin panel.
 *
 * In `app_runtime_config` — the same generic key/value table the storage
 * pools use — rather than a new table: this is one diagnostic blob that is
 * overwritten, not a history anyone queries.
 */
async function persistParity(config: ServerConfig, run: ParityRun): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.from('app_runtime_config').upsert({
      key: PARITY_STATE_KEY,
      value: {
        at: run.at,
        workspaceId: run.workspaceId,
        range: run.range,
        regressions: run.regressions,
        expectedDifferences: run.expectedDifferences,
        unavailable: run.unavailable ?? null,
        reports: run.reports.map((report) => ({
          report: report.report,
          ok: report.ok,
          postgresMs: report.postgresMs,
          s3Ms: report.s3Ms,
          error: report.error ?? null,
          // Bounded: the panel shows a summary, not a full diff dump.
          differences: report.differences.slice(0, 5),
        })),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (err: unknown) {
    console.error('[analytics] could not persist parity run:', err instanceof Error ? err.message : err);
  }
}

export async function readParityState(config: ServerConfig): Promise<ParityRun | null> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb.from('app_runtime_config').select('value').eq('key', PARITY_STATE_KEY).maybeSingle();
    const value = (data as { value?: unknown } | null)?.value;
    return value && typeof value === 'object' ? (value as ParityRun) : null;
  } catch {
    return null;
  }
}
