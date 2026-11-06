/**
 * The messages between the cluster primary and its workers
 * (docs/operations/BACKEND_PROCESSES.md). Every message carries `kcb: 1`, so
 * anything else on the IPC channel (Node's own cluster messages) is ignored.
 *
 *   worker → primary
 *     { kcb, id, op, args }         a hub operation; the primary answers
 *                                   { kcb, re: id, ok, result | error }
 *     { kcb, op, args }             the same without an answer (no id)
 *     { kcb, op: 'metrics', … }     a batch of monitoring samples to relay
 *     { kcb, op: 'heartbeat', … }   the worker's vitals, every 5 s
 *   primary → worker
 *     { kcb, op: 'ready' }          every worker listens
 *     { kcb, op: 'metrics', … }     a sibling's batch to ingest
 *
 * Only the operations below reach the hub; an unknown one is answered with an
 * error and changes nothing.
 */

export const HUB_OPS = [
  'reauth.store',
  'reauth.take',
  'privacy.slot',
  'login.check',
  'login.record',
  'rl.increment',
  'rl.decrement',
  'rl.resetKey',
  'rl.get',
  'desktop.heartbeat',
  'desktop.goodbye',
  'desktop.summary',
  'desktop.list',
  'desktop.add',
  'desktop.remove',
  'call.take',
  'call.giveBack',
  'call.mayRing',
  'callee.take',
  'callee.giveBack',
  'activity.stamp',
  'activity.get',
  'lock.acquire',
  'lock.release',
  'claim.take',
  'claim.release',
  'cluster.status',
] as const;

export type HubOp = (typeof HUB_OPS)[number];

const HUB_OP_SET: ReadonlySet<string> = new Set(HUB_OPS);

export function isHubOp(op: unknown): op is HubOp {
  return typeof op === 'string' && HUB_OP_SET.has(op);
}

export interface HubRequest {
  kcb: 1;
  /** Present when the worker waits for an answer. */
  id?: number;
  op: HubOp;
  args: unknown;
}

export interface HubReply {
  kcb: 1;
  re: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** One monitoring batch (cluster/metricsRelay.ts). */
export interface MetricsBatch {
  realtime: unknown[];
  perf: unknown[];
}

export interface WorkerHeartbeat {
  pid: number;
  role: string;
  rssMb: number;
  heapMb: number;
  /** Event-loop delay over the last interval, ms (p99 and max). */
  lagP99Ms: number;
  lagMaxMs: number;
  /** Requests answered in the last minute, and in flight now. */
  requestsPerMin: number;
  inFlight: number;
}

export type WorkerNotice =
  | { kcb: 1; op: 'metrics'; batch: MetricsBatch }
  | { kcb: 1; op: 'heartbeat'; beat: WorkerHeartbeat };

/** /api/health/cluster's answer: counts only, no pid. */
export interface ClusterStatus {
  processes: number;
  alive: number;
  listening: number;
  ready: boolean;
  restarts: number;
}

export type PrimaryNotice =
  | { kcb: 1; op: 'ready' }
  | { kcb: 1; op: 'metrics'; from: number; batch: MetricsBatch };

export function isKcbMessage(msg: unknown): msg is { kcb: 1; op?: string; id?: number; re?: number } {
  return !!msg && typeof msg === 'object' && (msg as { kcb?: unknown }).kcb === 1;
}

/** IPC wait for one hub answer. A lock's wait is its own bound plus this. */
export const HUB_TIMEOUT_MS = 2_000;
