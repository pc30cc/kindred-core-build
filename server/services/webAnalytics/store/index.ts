/**
 * Which store answers a report, and which one merely shadows it.
 *
 * In this build the answer is always PostgreSQL. `readMode: 's3'` is
 * refused by the admin API (a Phase 3 cutover), so there is deliberately no
 * code path here that can serve a report from the lake — the selection
 * exists so that flipping it later is a one-line change with the plumbing
 * already proven, not so that it can be flipped today.
 */

import type { ServerConfig } from '../../../config.js';
import { readAnalyticsPool } from '../../analytics/pool.js';
import { duckDbAvailability } from '../../analytics/duckdb.js';
import { emitLog } from '../../observability/metrics.js';
import type { DateRange } from '../reportService.js';
import { PostgresWebAnalyticsStore } from './postgres.js';
import { S3ParquetWebAnalyticsStore } from './s3.js';
import { runParity } from './parity.js';
import type { WebAnalyticsStore } from './types.js';

export { PostgresWebAnalyticsStore } from './postgres.js';
export { S3ParquetWebAnalyticsStore, AnalyticsSourceUnavailable } from './s3.js';
export { runParity, readParityState, PARITY_STATE_KEY } from './parity.js';
export type { ParityRun, ParityReport, ParityDifference } from './parity.js';
export type * from './types.js';

/** The store whose answer is returned to the caller. */
export function officialStore(config: ServerConfig): WebAnalyticsStore {
  return new PostgresWebAnalyticsStore(config);
}

/** The store that is compared against it, when one is available. */
export function shadowStore(config: ServerConfig): WebAnalyticsStore {
  return new S3ParquetWebAnalyticsStore(config);
}

export interface ShadowReadiness {
  ready: boolean;
  reason?: string;
}

/**
 * Can a shadow comparison run at all right now?
 *
 * Checked before every shadow read so a deployment with no engine, no
 * analytics primary, or analytics switched off does no work and logs no
 * noise — the absence of a shadow is a normal state, not a fault.
 */
export async function shadowReadiness(config: ServerConfig): Promise<ShadowReadiness> {
  const pool = await readAnalyticsPool(config);
  if (!pool.enabled) return { ready: false, reason: 'analytics storage is disabled' };
  if (!pool.primary) return { ready: false, reason: 'no analytics primary is configured' };

  const engine = await duckDbAvailability();
  if (engine.available === false) return { ready: false, reason: engine.reason };


  return { ready: true };
}

/**
 * Run a parity comparison beside a report that has already been answered.
 *
 * Fire-and-forget by contract: it is never awaited by a request handler,
 * never throws into one, and never touches the response. A shadow read that
 * could affect the official answer would not be a shadow read.
 */
export function shadowCompare(
  config: ServerConfig,
  workspaceId: string,
  range: DateRange,
  opts?: { funnelSteps?: Parameters<WebAnalyticsStore['computeFunnel']>[1] },
): void {
  void (async () => {
    try {
      const readiness = await shadowReadiness(config);
      if (!readiness.ready) return;
      await runParity(config, officialStore(config), shadowStore(config), workspaceId, range, opts);
    } catch (err: unknown) {
      emitLog(config, 'warn', 'analytics_shadow_compare_failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  })();
}
