/**
 * The cluster primary for src/test/cluster/lifecycle.test.ts: the real
 * runPrimary with the real plan, its workers running stubWorker.ts, with
 * short bounds so each case takes seconds.
 */
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { planCluster } from '../../../../server/cluster/plan.js';
import { runPrimary } from '../../../../server/cluster/primary.js';

const env = process.env;
const plan = planCluster(
  {
    DATABASE_URL: 'postgres://u:p@localhost:5432/x',
    DATABASE_POOL_MAX: env.FIXTURE_POOL ?? '15',
    BACKEND_PROCESSES: env.FIXTURE_N ?? '2',
  } as NodeJS.ProcessEnv,
  64,
);

runPrimary(plan, {
  exec: fileURLToPath(new URL('./stubWorker.ts', import.meta.url)),
  stopTimeoutMs: Number(env.FIXTURE_STOP_MS ?? 8_000),
  backoffMinMs: 100,
  backoffMaxMs: 400,
  crashLoopExits: Number(env.FIXTURE_CRASH_LOOP ?? 5),
  heartbeatCheckMs: 1_000,
  ...(env.FIXTURE_WATCHDOG_MS ? { leadWatchdogMs: Number(env.FIXTURE_WATCHDOG_MS) } : {}),
});

// After the first exit, forks cannot start a process (a missing cwd: Node
// reports ENOENT as an 'error', with no 'exit') for FIXTURE_SPAWN_FAIL_MS.
if (env.FIXTURE_SPAWN_FAIL_MS) {
  cluster.once('exit', () => {
    cluster.setupPrimary({ cwd: '/nonexistent-kcb-cluster-cwd' });
    setTimeout(() => cluster.setupPrimary({ cwd: process.cwd() }), Number(env.FIXTURE_SPAWN_FAIL_MS));
  });
}
