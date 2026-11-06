/**
 * The cluster primary (BACKEND_PROCESSES ≥ 2; docs/operations/
 * BACKEND_PROCESSES.md). It supervises the workers and holds the shared
 * request-path state (cluster/hub.ts); it opens no database connection and
 * loads no Express (src/test/cluster/primaryImports.test.ts), so it stays
 * idle and answers signals at once.
 *
 * Start: the lead (worker 0) is forked first and the followers once it
 * listens, so the module transform cache is warm and only the lead creates
 * the invitation secrets. Every worker's /api/health answers 503 until all
 * of them listen (routes/health.ts); then the primary tells them, once.
 *
 * Signals: on the first SIGTERM or SIGINT the primary stops respawning, sends
 * each live worker exactly one SIGTERM (worker.process.kill, not
 * worker.kill(), which would disconnect first), keeps answering the hub while
 * they drain (services/jobs/processShutdown.ts, unchanged), SIGKILLs any
 * still running after SHUTDOWN_TIMEOUT_MS + 5 s, and exits 0 after the last
 * one. A second signal finds no listener of ours and ends the primary at
 * once; the workers then exit on the IPC disconnect, as a second signal ends
 * the single process at once.
 *
 * Crashes: a worker that exits after it listened is respawned with the same
 * index, role and pool share, after a backoff of 1 s doubling to 30 s (reset
 * after 60 s up); its locks and claims are released. A fork that could not
 * even start a process (EAGAIN, EMFILE, ENOMEM: Node reports an 'error', not
 * an 'exit') counts as such an exit and is retried the same way. Five
 * unexpected exits of one index within five minutes, or a worker that exits
 * before it ever listened during the first start, stop the others and exit 1,
 * so Docker restarts the container as it does for a failed start today. A
 * slot has at most one process: a fork waits for its pending respawn, and an
 * exit of a process that is no longer its slot's schedules nothing.
 *
 * Stalls are logged (a worker silent for 30 s, or one whose event loop lags
 * over 1 s), and the metrics of the others are not relayed to a silent
 * worker, nor to one whose IPC backlog is full, until it beats again. Only the
 * lead is ever killed for one: silent for LEAD_WATCHDOG_MS (90 s) after it
 * listened, it is SIGKILLed and respawned as after a crash. The lead runs
 * every once-per-container loop (chat routing, the call queue, alerting…)
 * while the followers keep /api/health at 200, so a wedged lead would stop
 * them all with nothing failing; one process failed its health check instead.
 * A follower that stalls stays (its connections go to the others).
 */
import cluster, { type Worker } from 'node:cluster';
import { createHub, type Hub } from './hub.js';
import type { ClusterPlan, WorkerRole } from './plan.js';
import { isHubOp, isKcbMessage, type ClusterStatus, type MetricsBatch, type WorkerHeartbeat } from './protocol.js';

export interface PrimaryOptions {
  /** The worker's entry (tests); the primary's own entry by default (start.ts). */
  exec?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the workers after the first signal before SIGKILL. */
  stopTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  stableAfterMs?: number;
  crashLoopExits?: number;
  crashLoopWindowMs?: number;
  heartbeatCheckMs?: number;
  heartbeatStaleMs?: number;
  /** How long the lead may be silent after it listened before it is SIGKILLed. */
  leadWatchdogMs?: number;
  rosterEveryMs?: number;
  /** process.exit by default (tests pass their own). */
  exit?: (code: number) => void;
  /** Whether to install SIGTERM/SIGINT listeners (true by default). */
  signals?: boolean;
}

interface Slot {
  index: number;
  role: WorkerRole;
  share: number;
  worker: Worker | null;
  listening: boolean;
  everListened: boolean;
  startedAt: number;
  restarts: number;
  exits: number[];
  backoffMs: number;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  beat: (WorkerHeartbeat & { at: number }) | null;
  /** When the current worker listened (the watchdog's start). */
  listenedAt: number;
  stallLogged: boolean;
  /** The lead's watchdog sent its SIGKILL (once per worker). */
  watchdogKilled: boolean;
  /** Metrics are not relayed to it: silent, or its IPC backlog is full; until it beats again. */
  relayPaused: boolean;
}

export interface PrimaryHandle {
  hub: Hub;
  status(): ClusterStatus;
  /** Starts the graceful stop (what SIGTERM does). */
  stop(signal?: string): void;
}

const LAG_WARN_MS = 1_000;
/** The lead is SIGKILLed after this long without a heartbeat (it beats every 5 s). */
export const LEAD_WATCHDOG_MS = 90_000;

function shutdownTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SHUTDOWN_TIMEOUT_MS || 25_000);
  return (Number.isFinite(n) && n >= 0 ? n : 25_000) + 5_000;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const errorText = (err: unknown) =>
  err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? err.name}: ${err.message}` : String(err);

export function runPrimary(plan: ClusterPlan, opts: PrimaryOptions = {}): PrimaryHandle {
  const env = opts.env ?? process.env;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const stopTimeout = opts.stopTimeoutMs ?? shutdownTimeoutMs(env);
  const backoffMin = opts.backoffMinMs ?? 1_000;
  const backoffMax = opts.backoffMaxMs ?? 30_000;
  const stableAfter = opts.stableAfterMs ?? 60_000;
  const crashLoopExits = opts.crashLoopExits ?? 5;
  const crashLoopWindow = opts.crashLoopWindowMs ?? 5 * 60_000;
  const staleAfter = opts.heartbeatStaleMs ?? 30_000;
  const leadWatchdog = opts.leadWatchdogMs ?? LEAD_WATCHDOG_MS;

  for (const [i, line] of plan.lines.entries()) {
    if (i === plan.lines.length - 1) console.log(line);
    else console.warn(line);
  }

  const startedAt = Date.now();
  const slots: Slot[] = plan.shares.map((share, index) => ({
    index,
    role: plan.roles[index] ?? (index === 0 ? 'lead' : 'follower'),
    share,
    worker: null,
    listening: false,
    everListened: false,
    startedAt: 0,
    restarts: 0,
    exits: [],
    backoffMs: backoffMin,
    respawnTimer: null,
    beat: null,
    listenedAt: 0,
    stallLogged: false,
    watchdogKilled: false,
    relayPaused: false,
  }));
  let ready = false;
  /** The followers are forked once, when the lead first listens. */
  let followersForked = false;
  /** Workers whose exit (or failed start) was handled: Node may report a failed fork twice. */
  const ended = new WeakSet<Worker>();
  let stopping = false;
  let exitCode = 0;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const status = (): ClusterStatus => ({
    processes: slots.length,
    alive: slots.filter((s) => s.worker && !s.worker.isDead()).length,
    listening: slots.filter((s) => s.listening).length,
    ready,
    restarts: slots.reduce((n, s) => n + s.restarts, 0),
  });
  const hub = createHub({ status });

  const settings: Parameters<typeof cluster.setupPrimary>[0] = {};
  if (opts.exec) settings.exec = opts.exec;
  if (opts.execArgv) settings.execArgv = opts.execArgv;
  cluster.setupPrimary(settings);

  /** False when not sent, or when the worker's IPC backlog is over Node's threshold. */
  const send = (worker: Worker | null, message: unknown): boolean => {
    if (!worker || !worker.isConnected()) return false;
    try {
      return worker.send(message as never) !== false;
    } catch {
      /* the worker is going away; its exit is handled below */
      return false;
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (killTimer) clearTimeout(killTimer);
    clearInterval(checkTimer);
    clearInterval(rosterTimer);
    hub.stop();
    console.log(`[cluster] all workers exited${exitCode ? ` (exit ${exitCode})` : ''}`);
    exit(exitCode);
  };

  const alive = () => slots.filter((s) => s.worker && !s.worker.isDead());

  const beginStop = (why: string, code: number) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const s of slots) {
      if (s.respawnTimer) clearTimeout(s.respawnTimer);
      s.respawnTimer = null;
    }
    const live = alive();
    console.log(`[cluster] ${why}: stopping ${live.length} worker(s)`);
    if (!live.length) {
      finish();
      return;
    }
    for (const s of live) {
      try {
        s.worker!.process.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    killTimer = setTimeout(() => {
      for (const s of alive()) {
        console.warn(`[cluster] w${s.index} still running after ${seconds(stopTimeout)}: SIGKILL`);
        try {
          s.worker!.process.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, stopTimeout);
    killTimer.unref?.();
  };

  const forkEnv = (s: Slot): NodeJS.ProcessEnv => ({
    ...(opts.env ?? {}),
    BACKEND_CLUSTER_ROLE: s.role,
    BACKEND_CLUSTER_INDEX: String(s.index),
    BACKEND_CLUSTER_SIZE: String(slots.length),
    BACKEND_CLUSTER_READY: ready ? '1' : '0',
    DATABASE_POOL_MAX: String(s.share),
  });

  const onMessage = (s: Slot, worker: Worker, message: unknown) => {
    if (!isKcbMessage(message)) return;
    const op = message.op;
    if (op === 'heartbeat') {
      const beat = (message as unknown as { beat?: WorkerHeartbeat }).beat;
      if (beat && s.worker === worker) {
        s.beat = { ...beat, at: Date.now() };
        s.relayPaused = false;
        if (s.stallLogged) {
          s.stallLogged = false;
          console.log(`[cluster] w${s.index} heard from again`);
        }
        if (beat.lagMaxMs > LAG_WARN_MS) {
          console.warn(`[cluster] w${s.index} event loop lagged ${beat.lagMaxMs} ms in the last 5 s (p99 ${beat.lagP99Ms} ms)`);
        }
      }
      return;
    }
    if (op === 'metrics') {
      const batch = (message as unknown as { batch?: MetricsBatch }).batch;
      for (const other of slots) {
        // Not to a worker that does not read them (silent, or its backlog
        // full): the queue would grow in this process, which holds the hub.
        if (other === s || other.relayPaused) continue;
        if (!send(other.worker, { kcb: 1, op: 'metrics', from: s.index, batch }) && other.worker) other.relayPaused = true;
      }
      return;
    }
    if (!isHubOp(op)) {
      if (typeof message.id === 'number') send(worker, { kcb: 1, re: message.id, ok: false, error: 'unknown_op' });
      return;
    }
    const id = message.id;
    const args = (message as unknown as { args?: unknown }).args;
    Promise.resolve()
      .then(() => hub.handle(worker.id, op, args))
      .then(
        (result) => {
          if (typeof id === 'number') send(worker, { kcb: 1, re: id, ok: true, result: result ?? null });
        },
        (err: unknown) => {
          if (typeof id === 'number') {
            send(worker, { kcb: 1, re: id, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        },
      );
  };

  const fork = (s: Slot) => {
    if (stopping) return;
    // One process per slot: never beside a live one, and never twice for one
    // exit (a pending respawn is this fork).
    if (s.worker && !s.worker.isDead()) return;
    if (s.respawnTimer) {
      clearTimeout(s.respawnTimer);
      s.respawnTimer = null;
    }
    s.listening = false;
    s.beat = null;
    s.listenedAt = 0;
    s.stallLogged = false;
    s.watchdogKilled = false;
    s.relayPaused = false;
    s.startedAt = Date.now();
    let worker: Worker;
    try {
      worker = cluster.fork(forkEnv(s));
    } catch (err) {
      // Thrown at once (ENOMEM and the like): handled as an exit, so it is
      // retried with the backoff, or ends the start or a crash loop.
      s.worker = null;
      onStartFailure(s, err);
      return;
    }
    s.worker = worker;
    worker.on('message', (message: unknown) => onMessage(s, worker, message));
    worker.on('error', (err: unknown) => {
      // No pid: the process never started (EAGAIN, EMFILE, ENOENT…), and Node
      // reports no 'exit' for it. Otherwise a failed send or kill; its exit,
      // if any, comes as usual.
      if (worker.process.pid === undefined) onExit(s, worker, null, null, `could not be started: ${errorText(err)}`);
      else console.warn(`[cluster] w${s.index} process error: ${errorText(err)}`);
    });
    worker.on('listening', () => {
      if (s.worker !== worker) return;
      s.listening = true;
      s.everListened = true;
      s.listenedAt = Date.now();
      console.log(`[cluster] w${s.index} listening after ${seconds(Date.now() - s.startedAt)}`);
      if (s.index === 0 && !followersForked) {
        followersForked = true;
        for (const f of slots.slice(1)) fork(f);
      }
      if (!ready && slots.every((x) => x.listening)) {
        ready = true;
        console.log(`[cluster] all ${slots.length} listening after ${seconds(Date.now() - startedAt)}`);
        for (const x of slots) send(x.worker, { kcb: 1, op: 'ready' });
      } else if (ready) {
        send(worker, { kcb: 1, op: 'ready' });
      }
    });
    worker.on('exit', (code: number | null, signal: string | null) => onExit(s, worker, code, signal));
  };

  const onExit = (s: Slot, worker: Worker, code: number | null, signal: string | null, failure?: string) => {
    if (ended.has(worker)) return;
    ended.add(worker);
    hub.releaseOwner(worker.id);
    const how = failure ?? (signal ? `signal ${signal}` : `code ${code}`);
    if (s.worker !== worker) {
      // Not the slot's current process (it was replaced): nothing to respawn.
      console.warn(`[cluster] w${s.index}: a replaced process exited (${how})`);
      if (stopping && !alive().length) finish();
      return;
    }
    s.worker = null;
    s.listening = false;
    onSlotDown(s, how);
  };

  /** A fork that threw: as an exit of a process that never started. */
  const onStartFailure = (s: Slot, err: unknown) => {
    onSlotDown(s, `could not be started: ${errorText(err)}`);
  };

  /** The slot has no process any more: finish, stop, or respawn it. */
  const onSlotDown = (s: Slot, how: string) => {
    if (stopping) {
      console.log(`[cluster] w${s.index} exited (${how})`);
      if (!alive().length) finish();
      return;
    }
    const now = Date.now();
    const uptime = now - s.startedAt;
    if (!ready && !s.everListened) {
      console.error(`[cluster] w${s.index} exited (${how}) before it listened: the container did not start`);
      beginStop('start failed', 1);
      return;
    }
    s.exits = [...s.exits.filter((t) => now - t < crashLoopWindow), now];
    if (s.exits.length >= crashLoopExits) {
      console.error(
        `[cluster] w${s.index} exited ${s.exits.length} times within ${seconds(crashLoopWindow)} (last: ${how}): crash loop`,
      );
      beginStop('crash loop', 1);
      return;
    }
    if (uptime >= stableAfter) s.backoffMs = backoffMin;
    const wait = s.backoffMs;
    s.backoffMs = Math.min(backoffMax, s.backoffMs * 2);
    s.restarts += 1;
    console.warn(`[cluster] w${s.index} (${s.role}) exited (${how}) after ${seconds(uptime)}; respawning in ${seconds(wait)}`);
    s.respawnTimer = setTimeout(() => {
      s.respawnTimer = null;
      fork(s);
    }, wait);
  };

  const checkTimer = setInterval(() => {
    const now = Date.now();
    for (const s of slots) {
      if (!s.worker || !s.listening) continue;
      const last = Math.max(s.beat?.at ?? 0, s.listenedAt, s.startedAt);
      const silent = now - last;
      if (silent > staleAfter && !s.stallLogged) {
        s.stallLogged = true;
        s.relayPaused = true;
        console.warn(
          `[cluster] w${s.index} has not been heard from for ${seconds(silent)}` +
            (s.index === 0 ? ` (the lead is restarted at ${seconds(leadWatchdog)})` : ' (nothing is killed for it)'),
        );
      }
      if (s.index === 0 && !stopping && !s.watchdogKilled && silent > leadWatchdog) {
        s.watchdogKilled = true;
        console.error(
          `[cluster] w0 (lead) has not been heard from for ${seconds(silent)}: its loops have stopped; SIGKILL and respawn`,
        );
        try {
          s.worker.process.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }, opts.heartbeatCheckMs ?? 5_000);
  checkTimer.unref?.();

  const rosterTimer = setInterval(() => {
    const parts = slots.map((s) => {
      const b = s.beat;
      if (!s.worker) return `w${s.index} down`;
      return b ? `w${s.index} ${b.requestsPerMin} req/min, lag p99 ${b.lagP99Ms} ms, rss ${b.rssMb} MB` : `w${s.index} starting`;
    });
    console.log(`[cluster] roster: ${parts.join('; ')}`);
  }, opts.rosterEveryMs ?? 10 * 60_000);
  rosterTimer.unref?.();

  if (opts.signals !== false) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => beginStop(`${signal} received`, 0));
    }
  }
  process.on('uncaughtException', (err) => {
    console.error('[cluster] primary uncaught exception (kept running):', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[cluster] primary unhandled rejection (kept running):', reason);
  });

  fork(slots[0]);

  return { hub, status, stop: (signal = 'stop') => beginStop(signal, 0) };
}
