/**
 * Installed in each cluster worker before index.ts loads (server/start.ts;
 * docs/operations/BACKEND_PROCESSES.md):
 *
 *   - every console line starts with `[wN] ` (added to the first string
 *     argument, so `%s` formats still work, and searches such as
 *     `[shutdown] SIGTERM received` still match);
 *   - the IPC client listens for the primary: `ready` (every worker listens,
 *     so /api/health may answer 200) and the metrics of the other workers;
 *   - a heartbeat every HEARTBEAT_EVERY_MS: pid, role, memory, event-loop
 *     delay, requests answered in the last minute and in flight.
 *
 * Shutdown is index.ts's own (services/jobs/processShutdown.ts): the primary
 * sends each worker one SIGTERM. A worker whose IPC channel closes without
 * one (the primary died) exits at once: that is Node's own cluster rule.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import type { ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { clusterRole, clusterWorkerIndex, markClusterReady } from './role.js';
import { onPrimaryNotice, sendToPrimary } from './client.js';
import type { WorkerHeartbeat } from './protocol.js';

export const HEARTBEAT_EVERY_MS = 5_000;
const BUCKETS_PER_MINUTE = Math.round(60_000 / HEARTBEAT_EVERY_MS);

/** Prefixes the console's lines with `prefix` (once per process). */
export function installLogPrefix(prefix: string, target: Console = console): void {
  const marked = target as Console & { __clusterPrefix?: string };
  if (marked.__clusterPrefix) return;
  marked.__clusterPrefix = prefix;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      if (typeof args[0] === 'string') args[0] = `${prefix} ${args[0]}`;
      else args.unshift(prefix);
      original(...args);
    };
  }
}

const index = clusterWorkerIndex() ?? 0;
installLogPrefix(`[w${index}]`);

onPrimaryNotice('ready', () => markClusterReady());

// ── Requests, for the heartbeat ───────────────────────────────────────────
let inFlight = 0;
let answeredThisBeat = 0;
const answeredPerBeat: number[] = [];

diagnosticsChannel.subscribe('http.server.request.start', (message) => {
  const response = (message as { response?: ServerResponse }).response;
  if (!response) return;
  inFlight += 1;
  response.once('close', () => {
    inFlight = Math.max(0, inFlight - 1);
    answeredThisBeat += 1;
  });
});

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();

const beat = setInterval(() => {
  answeredPerBeat.push(answeredThisBeat);
  answeredThisBeat = 0;
  if (answeredPerBeat.length > BUCKETS_PER_MINUTE) answeredPerBeat.shift();
  const memory = process.memoryUsage();
  const heartbeat: WorkerHeartbeat = {
    pid: process.pid,
    role: clusterRole(),
    rssMb: Math.round(memory.rss / 1_048_576),
    heapMb: Math.round(memory.heapUsed / 1_048_576),
    lagP99Ms: Math.round(lag.percentile(99) / 1e6),
    lagMaxMs: Math.round(lag.max / 1e6),
    requestsPerMin: answeredPerBeat.reduce((a, b) => a + b, 0),
    inFlight,
  };
  lag.reset();
  sendToPrimary({ kcb: 1, op: 'heartbeat', beat: heartbeat });
}, HEARTBEAT_EVERY_MS);
beat.unref?.();
