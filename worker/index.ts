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
// 'file-ingest' is an alias for 'source-sync' — both kinds poll
// public.ai_source_sync_jobs and dispatch by job_type. Operators run a
// dedicated container with WORKER_KIND=file-ingest for production isolation,
// or WORKER_KIND=source-sync to handle both website and file ingestion.
// 'regression-runner' (E10) polls ai_agent_regression_batches and schedules.
// 'channels' polls public.channel_jobs for plugin channel traffic (Telegram
// inbound/outbound). It is intentionally a SEPARATE kind so channel volume
// can never starve AI workers, and vice versa.
const ALLOWED = new Set([
  'intelligence',
  'source-sync',
  'file-ingest',
  'regression-runner',
  'channels',
  'all',
]);

if (!ALLOWED.has(RAW_KIND)) {
  console.error(
    `[worker] invalid WORKER_KIND="${RAW_KIND}". Allowed: ${[...ALLOWED].join(' | ')}`,
  );
  process.exit(1);
}


console.log('[worker] starting', { kind: RAW_KIND });

async function main() {
  if (RAW_KIND === 'intelligence' || RAW_KIND === 'all') {
    const mod = await import('./intelligence/index.js');
    mod.startAiKbWorker?.();
  }
  if (RAW_KIND === 'source-sync' || RAW_KIND === 'file-ingest' || RAW_KIND === 'all') {
    const mod = await import('./source-sync/index.js');
    mod.startSourceSyncWorker?.();
  }
  if (RAW_KIND === 'regression-runner' || RAW_KIND === 'all') {
    const mod = await import('./regression-runner/index.js');
    mod.startRegressionWorker?.();
  }
  if (RAW_KIND === 'channels' || RAW_KIND === 'all') {
    const mod = await import('./channels/index.js');
    mod.startChannelsWorker?.();
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