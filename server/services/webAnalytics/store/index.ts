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
import type { DateRange } from '../reportService.js';
import { PostgresWebAnalyticsStore } from './postgres.js';
import { S3ParquetWebAnalyticsStore } from './s3.js';
import { runParity } from './parity.js';
import type { WebAnalyticsStore } from './types.js';

export { PostgresWebAnalyticsStore } from './postgres.js';
export { S3ParquetWebAnalyticsStore, AnalyticsSourceUnavailable } from './s3.js';
export { runParity, paritySummary, redactParityField, redactParityRun } from './parity.js';
export type { ParityRun, ParityReport, ParityDifference, ParityStatus, ParitySummary } from './parity.js';
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
 * There is deliberately no `shadowCompare`.
 *
 * It used to run beside a customer's report: open the Web Analytics page and
 * the backend answered from PostgreSQL, then quietly asked the same question
 * of the lake and compared them. That put a second full analytics query —
 * listing and downloading objects, starting the query engine — on the path of
 * a page view nobody asked to validate, and it wrote the comparison to the
 * database afterwards.
 *
 * Verification belongs in a verification tool, run deliberately by an
 * operator, against a workspace and range they chose. That is `runParity`,
 * exposed on the admin route. A customer request now queries exactly one
 * store: the official one.
 */
