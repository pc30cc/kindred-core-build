/**
 * A cluster worker for src/test/cluster/lifecycle.test.ts: the real
 * cluster/worker.ts (log prefix, ready flag, heartbeat), the real hub client,
 * the real processShutdown, and a small HTTP server in place of the app.
 * FIXTURE_* variables make one worker misbehave on purpose.
 */
import '../../../../server/cluster/worker.js';
import http from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { hubLimiterStore, hubLock } from '../../../../server/cluster/client.js';
import { clusterWorkerIndex, clusterWorkerReady } from '../../../../server/cluster/role.js';
import { consumeReauth, issueReauth } from '../../../../server/services/privacy/reauth.js';
import { onProcessShutdown } from '../../../../server/services/jobs/processShutdown.js';

const env = process.env;
const index = clusterWorkerIndex();
const pid = process.pid;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mine = (name: string) => env[name] !== undefined && Number(env[name]) === index;

if (mine('FIXTURE_FAIL_BOOT_INDEX')) {
  console.error('failing before listen on purpose');
  process.exit(3);
}

const app = express();
app.get('/health', (_req, res) => res.status(clusterWorkerReady() ? 200 : 503).json({ pid }));
app.get('/pid', (_req, res) =>
  res.json({ pid, index, role: env.BACKEND_CLUSTER_ROLE, pool: env.DATABASE_POOL_MAX, ready: env.BACKEND_CLUSTER_READY }),
);
const limiter = rateLimit({
  ...hubLimiterStore('auth'),
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'everyone',
});
app.get('/limited', limiter, (_req, res) => res.json({ pid }));
app.get('/reauth', async (_req, res) => res.json({ pid, ...(await issueReauth('u1')) }));
app.get('/take', async (req, res) => {
  // Refuses (without taking) on the pid named, so the test can pick the other worker.
  if (Number(req.query.not) === pid) return res.status(409).json({ pid });
  return res.json({ pid, ok: await consumeReauth('u1', String(req.query.token)) });
});
app.get('/lock', async (req, res) => {
  const release = await hubLock('x', 5_000);
  const start = Date.now();
  await sleep(Number(req.query.hold ?? 300));
  const end = Date.now();
  release();
  res.json({ pid, start, end });
});
app.get('/hold', async (_req, res) => {
  await hubLock('x', 5_000); // never released: its worker is killed next
  res.json({ pid });
});

const server = http.createServer(app);
const delay = mine('FIXTURE_LISTEN_DELAY_INDEX') ? Number(env.FIXTURE_LISTEN_DELAY_MS) : 0;
setTimeout(() => server.listen(Number(env.PORT)), delay);
if (mine('FIXTURE_CRASH_INDEX')) server.on('listening', () => setTimeout(() => process.exit(1), 200));
// Wedges the event loop for good after listening, at the first start only.
if (mine('FIXTURE_WEDGE_INDEX') && env.BACKEND_CLUSTER_READY === '0') {
  server.on('listening', () =>
    setTimeout(() => {
      for (;;) {
        /* a synchronous hot loop */
      }
    }, 300),
  );
}

if (mine('FIXTURE_IGNORE_SIGTERM_INDEX')) {
  process.on('SIGTERM', () => console.log('ignoring SIGTERM on purpose'));
} else {
  onProcessShutdown('slow-drain', () => sleep(index === 0 ? Number(env.FIXTURE_DRAIN_MS ?? 0) : 0));
  onProcessShutdown('http', () => new Promise<void>((resolve) => server.close(() => resolve())), { last: true });
}
