/**
 * The backend container's entry (Dockerfile.server's CMD).
 *
 * With BACKEND_PROCESSES unset (the default) this only loads index.ts: the
 * same process and the same start as before it existed. (index.ts, the
 * security middleware and the monitoring collector import the small cluster
 * seam, cluster/client.ts and cluster/metricsRelay.ts, which stay inert in
 * one process.) Otherwise cluster/plan.ts decides how many processes to run
 * (docs/operations/BACKEND_PROCESSES.md): with one, index.ts here; with
 * several, this process becomes the cluster primary, which forks the workers
 * and never loads the app itself (it would open a database pool and start
 * timers at import); each worker installs its IPC client and log prefix
 * (cluster/worker.ts) and then loads index.ts.
 *
 * Every import is a literal, so the CI check of the image's modules
 * (src/test/ci/dockerfileModuleClosure.test.ts) follows index.ts from here.
 */
if (!process.env.BACKEND_PROCESSES?.trim() && !process.env.BACKEND_CLUSTER_ROLE) {
  await import('./index.js');
} else {
  const { default: cluster } = await import('node:cluster');
  if (cluster.isWorker) {
    await import('./cluster/worker.js');
    try {
      await import('./index.js');
    } catch (err) {
      // A worker that cannot start (the database never answered, a bad
      // setting) exits, so the primary sees it: its IPC channel would keep it
      // alive, never listening, forever.
      console.error('[cluster] worker failed to start:', err);
      process.exit(1);
    }
  } else {
    const { availableParallelism } = await import('node:os');
    const { planCluster } = await import('./cluster/plan.js');
    const plan = planCluster(process.env, availableParallelism());
    if (plan.n < 2) {
      for (const line of plan.lines) console.warn(line);
      await import('./index.js');
    } else {
      const { runPrimary } = await import('./cluster/primary.js');
      runPrimary(plan);
    }
  }
}

export {};
