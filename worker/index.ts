/**
 * Multi-worker dispatcher.
 *
 * One Dockerfile.worker, many Coolify services. WORKER_KIND selects which
 * loop to run inside this container:
 *
 *   intelligence  → AI KB Builder (public.ai_kb_jobs)
 *   source-sync   → Data Hub source sync (public.ai_source_sync_jobs)
 *   all           → both loops in the same process (dev/small deploys only)
 *
 * Default is "intelligence" so existing Coolify deployments built from the
 * old Dockerfile.worker keep working without env changes.
 */

const RAW_KIND = (process.env.WORKER_KIND || 'intelligence').trim().toLowerCase();
const ALLOWED = new Set(['intelligence', 'source-sync', 'all']);

if (!ALLOWED.has(RAW_KIND)) {
  console.error(`[worker] invalid WORKER_KIND="${RAW_KIND}". Allowed: intelligence | source-sync | all`);
  process.exit(1);
}

console.log('[worker] starting', { kind: RAW_KIND });

async function main() {
  if (RAW_KIND === 'intelligence' || RAW_KIND === 'all') {
    const mod = await import('./intelligence/index.js');
    mod.startAiKbWorker?.();
  }
  if (RAW_KIND === 'source-sync' || RAW_KIND === 'all') {
    const mod = await import('./source-sync/index.js');
    mod.startSourceSyncWorker?.();
  }
  if (RAW_KIND === 'all') {
    console.warn('[worker] WORKER_KIND=all is allowed but not recommended for production isolation');
  }
}

main().catch((e) => {
  console.error('[worker] fatal startup error:', e?.message || e);
  process.exit(1);
});

// Keep the event loop alive in case the chosen worker uses unref'd timers.
const keepAlive = setInterval(() => {}, 1 << 30);
process.on('exit', () => clearInterval(keepAlive));