/**
 * ADMIN — ANALYTICS STORAGE CLIENT
 *
 * Analytics has its OWN primary and replicas, chosen independently of the
 * general storage pool (src/lib/storage-providers-api.ts). The two share
 * only the stored CREDENTIALS: this API selects roles by provider NAME and
 * has no endpoint that accepts a key, a secret or an endpoint URL. To edit a
 * credential the operator goes to Providers → Storage, and that is the only
 * place it lives.
 *
 * `generalPrimary` comes back read-only so the panel can put the two
 * primaries side by side. Nothing here can change it.
 */

import { API_BASE } from './apiBase';
import { authFetch } from './authFetch';

const BASE = '/api/admin/providers/analytics-storage';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type AnalyticsReplicaHealth =
  | 'synchronized' | 'behind' | 'dirty' | 'failed' | 'never_synchronized';

export type AnalyticsRole = 'primary' | 'replica' | 'none';
export type AnalyticsWriteMode = 'dual_write' | 's3_only';
export type AnalyticsReadMode = 'postgres' | 's3';

export interface AnalyticsSyncCounts {
  scanned: number;
  copied: number;
  skipped: number;
  failed: number;
}

export interface AnalyticsSyncStateDto {
  prefix: string;
  from: string;
  done: boolean;
  hasMore: boolean;
  total: AnalyticsSyncCounts;
  updatedAt: string;
}

export interface AnalyticsProviderDto {
  name: string;
  /** Credentials exist in Providers → Storage. Never the credentials themselves. */
  configured: boolean;
  generalEnabled: boolean;
  /** This vendor's role in GENERAL storage — context only, never changed from this screen. */
  generalRole: 'primary' | 'mirror' | 'off';
  analyticsPrimaryEligible: boolean;
  analyticsReplicaEligible: boolean;
  analyticsRole: AnalyticsRole;
  health: AnalyticsReplicaHealth | null;
  synchronized: boolean;
  syncedAt: string | null;
  dirtyAt: string | null;
  dirtyReason: string | null;
  lastError: string | null;
  sync: AnalyticsSyncStateDto | null;
}

/** Phase 2 — the S3 read path's health on the node that answered. */
export interface AnalyticsS3ReadDto {
  /** The embedded query engine is an OPTIONAL dependency; absent is a normal state. */
  engineAvailable: boolean;
  engineReason: string | null;
  lastQueryAt: string | null;
  lastQueryMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  queries: number;
  failures: number;
}

export interface AnalyticsParityDifferenceDto {
  report: string;
  field: string;
  postgres: string;
  s3: string;
  /** A declared, intentional difference rather than a regression. */
  expected: boolean;
}

export interface AnalyticsParityReportDto {
  report: string;
  ok: boolean;
  status?: ParityStatus;
  postgresMs: number;
  s3Ms: number;
  error: string | null;
  differences: AnalyticsParityDifferenceDto[];
}

export interface AnalyticsParityDto {
  at: string;
  workspaceId: string;
  range: { startDate: string; endDate: string };
  /** Undeclared differences — the number that matters. */
  regressions: number;
  expectedDifferences: number;
  unavailable: string | null;
  reports: AnalyticsParityReportDto[];
}

/** ready = done; warning = degraded but safe; blocked = would risk data at cutover. */
export type ReadinessState = 'ready' | 'warning' | 'blocked';

export interface AnalyticsReadinessCheckDto {
  /** Stable key, translated in the UI — never prose from the server. */
  key: string;
  state: ReadinessState;
  detail?: string | null;
}

export interface AnalyticsReadinessDto {
  checks: AnalyticsReadinessCheckDto[];
  /** No check is blocked. Warnings do not block. */
  s3OnlyEligible: boolean;
  /** Always false in this build — readiness reports, it does not grant. */
  s3OnlyUnlocked: boolean;
  blockedCount: number;
  warningCount: number;
}

/** What the configured spool ceiling buys, from the MEASURED frame size. */
export interface AnalyticsSpoolCapacityDto {
  maxBytes: number;
  segmentBytes: number;
  fsyncIntervalMs: number;
  averageFrameBytes: number | null;
  outageSeconds: { at100: number | null; at500: number | null; at1000: number | null };
}

/** Durable ingestion, probed live rather than read from a flag. */
export interface AnalyticsDurabilityDto {
  ready: boolean;
  enabled: boolean;
  reason: string | null;
  segments: number;
  bytes: number;
  replayedRows: number;
  droppedForSize: number;
  lastError: string | null;
  capacity?: AnalyticsSpoolCapacityDto;
}

/** Backend processes holding un-flushed analytics rows. */
export interface AnalyticsInstancesDto {
  count: number;
  multiInstance: boolean;
  /** Operator confirmed each instance has its own durable volume, for THIS fleet. */
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

export type ParityStatus = 'matched' | 'mismatched' | 'skipped' | 'error';

export interface AnalyticsParitySummaryDto {
  matched: number;
  mismatched: number;
  skipped: number;
  error: number;
}

export interface AnalyticsStorageDto {
  enabled: boolean;
  s3Read: AnalyticsS3ReadDto;
  parity: AnalyticsParityDto | null;
  readiness: AnalyticsReadinessDto;
  durability: AnalyticsDurabilityDto;
  instances: AnalyticsInstancesDto;
  primary: string | null;
  replicas: string[];
  replicationEnabled: boolean;
  prefix: string;
  batchRows: number;
  batchBytes: number;
  flushIntervalMs: number;
  format: 'parquet';
  compression: 'zstd';
  writeMode: AnalyticsWriteMode;
  readMode: AnalyticsReadMode;
  /** Compare-and-set token; bumped by every committed write. */
  revision: number;
  lastWriteAt: string | null;
  lastReplicationAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  objectsWritten: number;
  bytesWritten: number;
  rowsWritten: number;
  /** Rows buffered in the backend process that answered this request. */
  bufferedRows: number;
  missingCredentials: string[];
  /** The GENERAL storage primary — shown so the independence is visible. Read-only. */
  generalPrimary: string | null;
  providers: AnalyticsProviderDto[];
  limits: {
    batchRows: { min: number; max: number };
    batchBytes: { min: number; max: number };
    flushIntervalMs: { min: number; max: number };
  };
  defaults: { prefix: string; batchRows: number; batchBytes: number; flushIntervalMs: number };
  primaryEligible: string[];
  replicaEligible: string[];
}

export interface AnalyticsSyncReport {
  target: string;
  prefix: string;
  batch: AnalyticsSyncCounts;
  total: AnalyticsSyncCounts;
  errors: string[];
  nextCursor: string | null;
  done: boolean;
  /** The walk covered the whole namespace with no failures — promotion is now allowed. */
  markedSynchronized: boolean;
}

export interface AnalyticsProviderTestResult {
  success: boolean;
  latencyMs: number;
  /** Which half of the analytics contract passed: PUT, GET-back, LIST, DELETE. */
  steps: Record<string, boolean>;
  error?: string;
}

export interface AnalyticsBackfillReport {
  workspaceId: string;
  day: string;
  objects: string[];
  rows: number;
  bytes: number;
  source: { sessions: number; pageViews: number; events: number };
  verified: boolean;
  expected: number;
  errors: string[];
}

export function adminGetAnalyticsStorage() {
  return request<AnalyticsStorageDto>(BASE);
}

export function adminSaveAnalyticsSettings(payload: {
  enabled?: boolean;
  replicationEnabled?: boolean;
  prefix?: string;
  batchRows?: number;
  batchBytes?: number;
  flushIntervalMs?: number;
}) {
  return request<AnalyticsStorageDto>(`${BASE}/settings`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/**
 * Promote a vendor to analytics primary. Blocked unless the server itself
 * recorded a complete sync from the current primary; `force` is the logged
 * recovery path.
 */
export function adminSetAnalyticsPrimary(providerName: string, force?: boolean) {
  return request<AnalyticsStorageDto & { forced?: boolean }>(
    `${BASE}/primary/${encodeURIComponent(providerName)}`,
    { method: 'POST', body: JSON.stringify({ force: force === true }) },
  );
}

export function adminSetAnalyticsReplicas(replicas: string[]) {
  return request<AnalyticsStorageDto>(`${BASE}/replicas`, {
    method: 'PUT',
    body: JSON.stringify({ replicas }),
  });
}

export function adminSyncAnalyticsReplica(payload: {
  target: string;
  prefix?: string;
  limit?: number;
  restart?: boolean;
}) {
  return request<{ report: AnalyticsSyncReport }>(`${BASE}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function adminTestAnalyticsProvider(providerName: string) {
  return request<AnalyticsProviderTestResult>(
    `${BASE}/test/${encodeURIComponent(providerName)}`,
    { method: 'POST' },
  );
}

export function adminFlushAnalytics() {
  return request<{ objects: number; rows: number; bytes: number; failures: number }>(
    `${BASE}/flush`, { method: 'POST' },
  );
}

export function adminBackfillAnalyticsDay(workspaceId: string, day: string) {
  return request<{ report: AnalyticsBackfillReport }>(`${BASE}/backfill`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, day }),
  });
}

/**
 * Phase 2.5 — run a shadow comparison for one workspace and date range.
 *
 * Bounded server-side; a range longer than the limit is refused rather than
 * quietly truncated. Dimension values come back as stable digests, so the
 * panel can show WHICH rows differ and how often without showing a
 * workspace's page paths or city names to a platform operator.
 */
export function adminRunAnalyticsParity(payload: {
  workspaceId: string;
  startDate: string;
  endDate: string;
  includeFunnels?: boolean;
}) {
  return request<{
    run: AnalyticsParityDto;
    summary: AnalyticsParitySummaryDto;
    days: number;
    funnelsCompared: boolean;
  }>(`${BASE}/parity`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface AnalyticsBackfillRangeReport {
  workspaceId: string;
  fromDay: string;
  toDay: string;
  attempted: number;
  verifiedDays: number;
  failedDays: string[];
  sourceRows: number;
  writtenRows: number;
  objects: number;
  bytes: number;
  replaced: number;
  /** Where to resume, or null when the range is finished. */
  nextDay: string | null;
}

/**
 * Phase 2.5 — rebuild a date range. Bounded per call; when `nextDay` comes
 * back non-null the caller runs again from there, which is what makes this
 * resumable without a job table.
 */
export function adminBackfillAnalyticsRange(payload: {
  workspaceId: string;
  fromDay: string;
  toDay: string;
  maxDays?: number;
}) {
  return request<{ report: AnalyticsBackfillRangeReport; maxDaysPerCall: number }>(
    `${BASE}/backfill/range`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

/**
 * Phase 3A — confirm every backend instance has its own durable volume.
 *
 * Recorded against the CURRENT hostnames, so scaling out afterwards
 * invalidates it rather than carrying over to machines nobody vouched for.
 */
export function adminAcknowledgeAnalyticsInstances() {
  return request<{ instances: AnalyticsInstancesDto }>(`${BASE}/instances/acknowledge`, {
    method: 'POST',
  });
}

/** Phase 2 — force a day-sealing cycle (buffer durability catch-up). */
export function adminRunAnalyticsSeal() {
  return request<{ considered: number; sealed: number; failed: number; rows: number; objects: number }>(
    `${BASE}/seal`, { method: 'POST' },
  );
}
