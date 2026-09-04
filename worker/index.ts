/**
 * Multi-worker dispatcher.
 *
 * One Dockerfile.worker, many Coolify services. WORKER_KIND selects which
 * loop(s) run inside this container. It accepts a single kind, a
 * comma-separated list of kinds (any subset, grouped however you like
 * across containers), or the literal "all":
 *
 *   intelligence            → AI KB Builder (public.ai_kb_jobs)
 *   source-sync             → Data Hub source sync (public.ai_source_sync_jobs)
 *   seo-crawler,channels    → e.g. these two kinds sharing one container
 *   invitations             → a different kind in another container
 *   all                     → every loop in the same process (dev/small deploys only)
 *
 * Default is "intelligence" so existing Coolify deployments built from the
 * old Dockerfile.worker keep working without env changes.
 */

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
  'invitations',
  'seo-crawler',
  'all',
]);

const RAW_INPUT = (process.env.WORKER_KIND || 'intelligence').trim().toLowerCase();
const REQUESTED = RAW_INPUT.split(',').map((s) => s.trim()).filter(Boolean);
const invalid = REQUESTED.filter((k) => !ALLOWED.has(k));

if (invalid.length > 0 || REQUESTED.length === 0) {
  console.error(
    `[worker] invalid WORKER_KIND="${RAW_INPUT}". Unknown: ${invalid.join(', ') || '(empty)'}. Allowed: ${[...ALLOWED].join(' | ')} (comma-separated list also accepted, e.g. "seo-crawler,channels")`,
  );
  process.exit(1);
}

const KINDS = new Set(REQUESTED);
// 'all' can appear alongside other kinds in the list without harm — it just
// turns every loop on regardless of what else was requested.
const runsAll = KINDS.has('all');
const runs = (kind: string) => runsAll || KINDS.has(kind);

console.log('[worker] starting', { kinds: [...KINDS] });

async function main() {
  if (runs('intelligence')) {
    const mod = await import('./intelligence/index.js');
    mod.startAiKbWorker?.();
  }
  if (runs('source-sync') || runs('file-ingest')) {
    const mod = await import('./source-sync/index.js');
    mod.startSourceSyncWorker?.();
  }
  if (runs('regression-runner')) {
    const mod = await import('./regression-runner/index.js');
    mod.startRegressionWorker?.();
  }
  if (runs('channels')) {
    const mod = await import('./channels/index.js');
    mod.startChannelsWorker?.();
  }
  if (runs('invitations')) {
    const [{ loadConfig }, worker, bootstrap, secrets] = await Promise.all([
      import('../server/config.js'),
      import('../server/services/invitations/worker.js'),
      import('../server/services/invitations/bootstrap.js'),
      import('../server/services/invitations/secretBootstrap.js'),
    ]);
    const config = loadConfig();
    // Same key material as the API process: env wins, otherwise the durable
    // database-provisioned keys are loaded before any delivery job runs.
    await secrets.ensureInvitationSecrets(config);
    const entitlement = await bootstrap.syncSeatEntitlementMode(config);
    if (!entitlement.ok) throw new Error('invitation entitlement bootstrap failed');
    worker.startInvitationWorker(config);
  }
  if (runs('seo-crawler')) {
    const mod = await import('./seo-crawler/index.js');
    mod.startSeoCrawlerWorker?.();
  }

  if (runsAll) {
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
