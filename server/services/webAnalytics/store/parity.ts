/**
 * SHADOW READ / PARITY — does the lake answer what PostgreSQL answers?
 *
 * Phase 2 keeps PostgreSQL as the OFFICIAL source. For a selected set of
 * reports the same question is also put to the S3 store, and the two
 * answers are compared. The shadow run never influences the response the
 * caller receives, never delays it, and cannot fail it.
 *
 * ── No divergence is declared any more ──────────────────────────
 *
 * Phase 2 declared two metrics as EXPECTED to differ. Phase 2.5 established
 * that both were defects, and fixed them rather than keeping the exemption:
 *
 *   uniqueVisitors — Phase 2 recorded this as "PostgreSQL counts session
 *                    rows, and cannot be fixed in place because there is no
 *                    visitor column". That was WRONG: `visitor_sessions` has
 *                    a `visitor_id`, it simply was not in the SELECT, so the
 *                    code fell back to the session's own primary key. Both
 *                    paths now count DISTINCT visitor_id.
 *   avgVisitDurationSeconds — the lake ended a session at MAX(occurred_at),
 *                    which misses activity that updated `last_seen_at`
 *                    without producing an analytics event. Schema v2 carries
 *                    `session_last_seen_at` on every row, so both paths now
 *                    measure to the same instant.
 *
 * EXPECTED_DIVERGENCE is therefore empty, and every difference this reports
 * is a REGRESSION. That is the point: the machinery is only worth having if
 * "we changed this on purpose" has to be written down BEFORE a comparison
 * goes red, never after.
 *
 * ── Tolerance ────────────────────────────────────────────────────
 *
 * Counts are integers and must match EXACTLY; a tolerance there would hide
 * exactly the off-by-N bugs this is meant to catch. Only derived
 * percentages get a tolerance, because both sides round independently.
 */

import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import type { DateRange } from '../reportService.js';
import type { WebAnalyticsStore } from './types.js';


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

/**
 * matched    — both stores agreed on everything compared.
 * mismatched — a real difference. EXPECTED_DIVERGENCE is empty, so this is
 *              always a regression.
 * skipped    — the S3 side could not answer at all (no engine, no primary,
 *              nothing written for the range). Not a failure of the report.
 * error      — the comparison itself threw.
 */
export type ParityStatus = 'matched' | 'mismatched' | 'skipped' | 'error';

export interface ParityReport {
  report: string;
  ok: boolean;
  status: ParityStatus;
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

/**
 * Fields whose divergence is intentional.
 *
 * EMPTY, deliberately. Both entries that used to live here were bugs, not
 * intentions, and both were fixed in Phase 2.5 rather than declared away:
 *
 *   overview.uniqueVisitors          — the PostgreSQL path counted session
 *     ids, so the metric always equalled the session count. Now both paths
 *     count DISTINCT visitor_id.
 *   overview.avgVisitDurationSeconds — the S3 path ended a session at
 *     MAX(occurred_at), which misses activity that produced no analytics
 *     event. Both paths now end it at the session's `last_seen_at`, carried
 *     on every row as `session_last_seen_at` (schema v2).
 *
 * Adding an entry here means asserting a difference is CORRECT. That needs
 * the same justification any other behaviour change needs — a declared
 * divergence is not a way to quiet a failing comparison.
 */
const EXPECTED_DIVERGENCE = new Set<string>([]);

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
        status: differences.length === 0 ? 'matched' : 'mismatched',
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
        report: comparison.name, ok: false,
        status: /unavailable|not available|no analytics primary/i.test(message) ? 'skipped' : 'error',
        differences: [], postgresMs: 0, s3Ms: 0, error: message,
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


  return run;
}

/**
 * A difference's `field` can be a DIMENSION VALUE — a page path, a city, a
 * campaign name, an event name. Those belong to the workspace, and the
 * Super Admin parity panel is not the workspace's own analytics page, so
 * they are replaced with a short stable digest before the run leaves the
 * server. The digest is stable across runs, which is what makes a recurring
 * mismatch recognisable without exposing what it is about.
 *
 * Metric fields (`sessions`, `bounceRate`, `step0.sessions`, …) are field
 * NAMES, not workspace data, and are kept as-is — redacting them would
 * destroy the only thing that makes a difference diagnosable.
 */
const METRIC_FIELD = /^(sessions|pageviews|uniqueVisitors|bounceRate|avgPagesPerSession|avgVisitDurationSeconds|step\d+\.sessions)$/;

export function redactParityField(field: string): string {
  if (METRIC_FIELD.test(field)) return field;
  const [prefix, ...rest] = field.split(':');
  const value = rest.length > 0 ? rest.join(':') : field;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return rest.length > 0 ? `${prefix}:#${digest}` : `#${digest}`;
}

function redactDifferences(differences: ParityDifference[]): ParityDifference[] {
  return differences.map((d) => ({ ...d, field: redactParityField(d.field) }));
}

export interface ParitySummary {
  matched: number;
  mismatched: number;
  skipped: number;
  error: number;
}

export function paritySummary(run: ParityRun): ParitySummary {
  const summary: ParitySummary = { matched: 0, mismatched: 0, skipped: 0, error: 0 };
  for (const report of run.reports) summary[report.status] += 1;
  return summary;
}

/**
 * The run as it may leave the server: dimension values digested, per-report
 * differences bounded.
 */
export function redactParityRun(run: ParityRun): ParityRun {
  return {
    ...run,
    reports: run.reports.map((report) => ({
      ...report,
      differences: redactDifferences(report.differences).slice(0, 5),
    })),
  };
}

/**
 * Parity is a VERIFICATION TOOL, not a monitored metric.
 *
 * It used to persist its last run into `app_runtime_config` so an admin panel
 * could show a parity badge. That made PostgreSQL the home of analytics
 * history — exactly what this subsystem exists to stop — and a stored badge
 * describes a comparison that may be days old and made against different
 * code.
 *
 * So there is no `persistParity` and no `readParityState`. A run returns its
 * result to whoever asked for it, and that is the end of it.
 */
