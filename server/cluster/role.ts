/**
 * Which part this process plays in the backend container
 * (docs/operations/BACKEND_PROCESSES.md).
 *
 *   single    the one backend process, as before BACKEND_PROCESSES existed:
 *             unset, 1, a refused or an invalid value, a `docker exec … npx
 *             tsx scripts/…`, a test run. Everything runs here.
 *   lead      cluster worker 0: serves HTTP and runs every background loop
 *             the listen callback starts (server/index.ts).
 *   follower  cluster workers 1..N-1: serve HTTP, and run only what each
 *             process needs for itself.
 *
 * The role comes from BACKEND_CLUSTER_ROLE, which only the cluster primary
 * sets (server/cluster/primary.ts), and counts only in a process that
 * node:cluster forked: a value set by hand anywhere else is ignored, so a
 * script or a test can never become a follower and skip the loops, or wait on
 * a hub that is not there.
 */
import cluster from 'node:cluster';

export type ClusterRole = 'single' | 'lead' | 'follower';

export interface RoleInputs {
  isWorker: boolean;
  env: NodeJS.ProcessEnv;
  /** Whether the process has an IPC channel to its parent (process.send). */
  hasChannel: boolean;
}

function liveInputs(): RoleInputs {
  return { isWorker: cluster.isWorker, env: process.env, hasChannel: typeof process.send === 'function' };
}

export function clusterRole(inputs: RoleInputs = liveInputs()): ClusterRole {
  if (!inputs.isWorker) return 'single';
  const role = inputs.env.BACKEND_CLUSTER_ROLE;
  return role === 'lead' || role === 'follower' ? role : 'single';
}

/** True unless this process is a follower: the single process and the lead run the loops. */
export function runsBackgroundLoops(inputs: RoleInputs = liveInputs()): boolean {
  return clusterRole(inputs) !== 'follower';
}

/**
 * True only in a cluster worker that can reach its primary: the request-path
 * state that assumes one process then lives in the primary (cluster/hub.ts).
 */
export function usesClusterHub(inputs: RoleInputs = liveInputs()): boolean {
  return clusterRole(inputs) !== 'single' && inputs.hasChannel;
}

/** This worker's index (0 is the lead), or null outside a cluster. */
export function clusterWorkerIndex(inputs: RoleInputs = liveInputs()): number | null {
  if (clusterRole(inputs) === 'single') return null;
  const n = Number(inputs.env.BACKEND_CLUSTER_INDEX);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** How many workers the container runs (1 outside a cluster). */
export function clusterSize(inputs: RoleInputs = liveInputs()): number {
  if (clusterRole(inputs) === 'single') return 1;
  const n = Number(inputs.env.BACKEND_CLUSTER_SIZE);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

// ── Readiness ──────────────────────────────────────────────────────────────
// In cluster mode /api/health answers 503 until the primary says every worker
// listens (routes/health.ts), so Coolify sees the new container healthy only
// once the whole cluster is up. A worker respawned after that starts ready
// (BACKEND_CLUSTER_READY=1), so the endpoint never flaps. The single process
// is always ready, as before.

let readyMarked = false;

export function clusterWorkerReady(inputs: RoleInputs = liveInputs()): boolean {
  if (clusterRole(inputs) === 'single') return true;
  return readyMarked || inputs.env.BACKEND_CLUSTER_READY === '1';
}

/** Called once the primary reports every worker listening (cluster/worker.ts). */
export function markClusterReady(): void {
  readyMarked = true;
}

/** Tests only. */
export function __resetClusterReadyForTests(): void {
  readyMarked = false;
}
