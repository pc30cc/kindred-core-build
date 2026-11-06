/**
 * BACKEND_PROCESSES: how many processes the backend container runs, decided
 * once at start from the environment (server/start.ts;
 * docs/operations/BACKEND_PROCESSES.md). Pure: it reads only what it is
 * given, and imports nothing that touches the database.
 *
 *   unset, empty, 1     one process, exactly as before (no line logged)
 *   2 … 16              cluster mode, after the checks below
 *   anything else       one process, and a line saying why: a typo never
 *                       crash-loops production
 *
 * Refused (one process, and a line naming the reason):
 *   - the supabase-rest database mode: the cache bus does not reach other
 *     processes there (lib/cacheBus.ts);
 *   - a dev in-process worker switched on (AI_SOURCE_SYNC_WORKER_INPROC,
 *     AI_KB_WORKER_INPROC, AI_KB_INTELLIGENCE_WORKER_INPROC,
 *     AI_AGENT_REGRESSION_WORKER_INPROC): request routes kick those too
 *     (routes/ai-agent/knowledge.ts), so they would run in every worker;
 *   - DATABASE_POOL_MAX or DATABASE_MODE not valid: left to index.ts, which
 *     stops with the same error as before.
 *
 * DATABASE_POOL_MAX (P) stays the container's total. The N workers share
 * P + 1 − N pool slots (the remainder to the lead first) and each holds one
 * cache-bus LISTEN connection, so the container never opens more than P + 1
 * connections, as one process does. The lead serves HTTP and runs every
 * background loop on its pool, so it keeps at least LEAD_MIN_POOL (3, the
 * single process's smallest pool before 2026-11-05): one slow loop statement
 * (up to the 120 s statement timeout) must not make its requests and other
 * loops wait out the pool's 15 s acquire timeout. N is lowered to
 * floor((P + 2 − LEAD_MIN_POOL) / 2) so the lead keeps that and every
 * follower at least 1 (7 with P = 15). A value above the CPUs Node sees still
 * starts, with a warning (a container CPU quota is not visible there).
 */
import { databaseMode } from '../db/mode.js';

export const MAX_BACKEND_PROCESSES = 16;
/** pool.ts's default when DATABASE_POOL_MAX is unset. */
const DEFAULT_POOL_MAX = 10;
/** The lead's smallest pool: HTTP plus every background loop. */
export const LEAD_MIN_POOL = 3;

const DEV_INPROC_FLAGS = [
  'AI_SOURCE_SYNC_WORKER_INPROC',
  'AI_KB_WORKER_INPROC',
  'AI_KB_INTELLIGENCE_WORKER_INPROC',
  'AI_AGENT_REGRESSION_WORKER_INPROC',
] as const;

export type WorkerRole = 'lead' | 'follower';

export interface ClusterPlan {
  /** Processes to run; 1 = the single process, as before. */
  n: number;
  /** BACKEND_PROCESSES as given (trimmed), or null when unset or empty. */
  requested: string | null;
  /** Role of each worker, by index (worker 0 is the lead). Empty when n = 1. */
  roles: WorkerRole[];
  /** Each worker's DATABASE_POOL_MAX, by index. Empty when n = 1. */
  shares: number[];
  /** DATABASE_POOL_MAX as the container's total (null when it could not be read). */
  poolTotal: number | null;
  /** Database connections the container opens at most: pools + one LISTEN each. */
  ceiling: number | null;
  /** Lines to log, in order (refusals, warnings, then the plan). */
  lines: string[];
}

/** pool.ts's intEnv, without the throw: null when the value is not valid. */
function poolMaxOf(env: NodeJS.ProcessEnv): number | null {
  const raw = env.DATABASE_POOL_MAX?.trim();
  if (!raw) return DEFAULT_POOL_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return Math.max(1, n);
}

/** `slots` split evenly among `n`, the remainder to the first ones. */
function evenShares(slots: number, n: number): number[] {
  const base = Math.floor(slots / n);
  const extra = slots - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The pool shares of P + 1 − N slots among N workers, the remainder to the
 * lead first; when the even share would leave the lead below LEAD_MIN_POOL,
 * the lead takes that many first and the followers split the rest.
 */
export function poolShares(poolTotal: number, n: number): number[] {
  const slots = poolTotal + 1 - n;
  const even = evenShares(slots, n);
  if (n < 2 || even[0] >= LEAD_MIN_POOL) return even;
  const lead = Math.min(LEAD_MIN_POOL, slots - (n - 1));
  return [lead, ...evenShares(slots - lead, n - 1)];
}

/** The most processes P allows: the lead keeps LEAD_MIN_POOL, each follower 1. */
export function maxProcessesFor(poolTotal: number): number {
  return Math.floor((poolTotal + 2 - LEAD_MIN_POOL) / 2);
}

function single(requested: string | null, poolTotal: number | null, lines: string[] = []): ClusterPlan {
  return {
    n: 1,
    requested,
    roles: [],
    shares: [],
    poolTotal,
    ceiling: poolTotal === null ? null : poolTotal + 1,
    lines,
  };
}

export function planCluster(env: NodeJS.ProcessEnv = process.env, cpus: number | null = null): ClusterPlan {
  const requested = env.BACKEND_PROCESSES?.trim() || null;
  const poolTotal = poolMaxOf(env);
  if (requested === null) return single(null, poolTotal);

  const whole = /^\d+$/.test(requested) ? Number(requested) : NaN;
  if (!Number.isInteger(whole) || whole < 1 || whole > MAX_BACKEND_PROCESSES) {
    return single(requested, poolTotal, [
      `[cluster] BACKEND_PROCESSES=${requested.slice(0, 40)} is not a whole number from 1 to ${MAX_BACKEND_PROCESSES}; running one process`,
    ]);
  }
  if (whole === 1) return single(requested, poolTotal);

  const refuse = (why: string) =>
    single(requested, poolTotal, [`[cluster] BACKEND_PROCESSES=${requested} refused: ${why}; running one process`]);

  let mode: string;
  try {
    mode = databaseMode(env);
  } catch {
    return refuse('DATABASE_MODE is not valid (the server reports it at start)');
  }
  if (mode === 'supabase-rest') {
    return refuse('the database mode is supabase-rest, where the cache bus does not reach other processes');
  }
  const inproc = DEV_INPROC_FLAGS.filter((name) => env[name] === '1');
  if (inproc.length) {
    return refuse(`${inproc.join(', ')}=1 runs a dev worker inside the backend, which would run in every process`);
  }
  if (poolTotal === null) {
    return refuse('DATABASE_POOL_MAX is not a non-negative whole number (the server reports it at start)');
  }

  const lines: string[] = [];
  const maxN = maxProcessesFor(poolTotal);
  let n = whole;
  if (n > maxN) {
    if (maxN < 2) {
      // Two processes: the lead's pool, a follower's 1 and a LISTEN each, out of P + 1.
      const needed = LEAD_MIN_POOL + 2;
      return refuse(
        `DATABASE_POOL_MAX=${poolTotal} leaves no pool for a second process (it needs at least ${needed}: the lead keeps ${LEAD_MIN_POOL})`,
      );
    }
    lines.push(
      `[cluster] BACKEND_PROCESSES=${requested} lowered to ${maxN}: DATABASE_POOL_MAX=${poolTotal} keeps a pool of ` +
        `${LEAD_MIN_POOL} for the lead (HTTP and every background loop) and of at least 1 for each other process ` +
        `for at most ${maxN} processes`,
    );
    n = maxN;
  }
  if (cpus !== null && n > cpus) {
    lines.push(`[cluster] warning: ${n} processes on ${cpus} CPU(s) Node sees; they will share cores`);
  }

  const shares = poolShares(poolTotal, n);
  const roles: WorkerRole[] = shares.map((_, i) => (i === 0 ? 'lead' : 'follower'));
  const ceiling = poolTotal + 1;
  const who = roles.map((r, i) => (r === 'lead' ? `w${i} lead (HTTP + background loops)` : `w${i} HTTP`)).join(', ');
  lines.push(
    `[cluster] BACKEND_PROCESSES=${n}: ${who}. DATABASE_POOL_MAX=${poolTotal} is the container's total: ` +
      `pools ${shares.join('+')} + ${n} cache-bus LISTEN = ${ceiling} connections at most (one process: ${ceiling})`,
  );
  return { n, requested, roles, shares, poolTotal, ceiling, lines };
}
