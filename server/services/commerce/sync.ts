/**
 * Catalog synchronization — paginated, resumable, bounded, idempotent
 * (docs/commerce/CONNECTOR_PROTOCOL.md §Sync). Consumed by
 * worker/commerce-sync/index.ts; enqueueSyncJob is also called directly
 * from the connections admin route ("Sync now") and right after a
 * successful pairing handshake.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { CommerceError } from '../../../shared/commerce/types.js';
import { readInstallationSecret } from './credentials.js';
import { normalizeWooCommerceProduct } from './connectors/woocommerce.js';
import { getProviderDescriptor } from './connectors/registry.js';
import { upsertProductInIndex } from './productIndex.js';
import { commerceHttpRequest } from './httpClient.js';
import { buildSignedHeaders } from './signing.js';
import { catalogExportPaths } from './catalogPaths.js';

const MAX_PAGES_PER_RUN = 20; // bounds one worker tick to <= 1000 products
const MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;

export interface SyncJobRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  job_type: 'initial_sync' | 'incremental_sync' | 'reconciliation' | 'manual_resync';
  status: string;
  attempts: number;
  max_attempts: number;
}

export async function enqueueSyncJob(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  jobType: SyncJobRow['job_type'],
): Promise<{ id: string } | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_sync_jobs')
    .insert({ workspace_id: workspaceId, connection_id: connectionId, job_type: jobType, max_attempts: MAX_ATTEMPTS })
    .select('id')
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505') return null; // one active job per connection already exists
    throw new Error(`sync job enqueue failed: ${error.message}`);
  }
  return data as { id: string } | null;
}

export async function claimNextSyncJob(config: ServerConfig, workerId: string): Promise<SyncJobRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('commerce_claim_sync_job', { p_worker_id: workerId, p_lease_seconds: 300 });
  if (error) throw new Error(`sync job claim failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as SyncJobRow | null) ?? null;
}

async function fetchProductPage(
  config: ServerConfig,
  connectionId: string,
  installationId: string,
  origin: string,
  secret: string,
  page: number,
  modifiedAfter: string | null,
): Promise<{ products: unknown[]; hasMore: boolean }> {
  const { signedPath, requestPath } = catalogExportPaths(page, modifiedAfter);
  const headers = buildSignedHeaders(secret, installationId, 'GET', signedPath, '');
  const res = await commerceHttpRequest({ url: `${origin}${requestPath}`, method: 'GET', headers, retryable: true });
  if (res.status >= 400) throw new CommerceError('commerce_live_unavailable', `catalog export failed: ${res.status}`);
  const body = (res.json && typeof res.json === 'object' ? res.json : {}) as { products?: unknown; has_more?: unknown };
  return { products: Array.isArray(body.products) ? body.products : [], hasMore: body.has_more === true };
}

/**
 * Runs up to MAX_PAGES_PER_RUN pages of one sync job, persists the cursor
 * after every page (resumable — a crash mid-run loses at most one page of
 * work), and marks the job succeeded once the store reports no more pages.
 * Version-aware upserts mean a page landing after a newer live event is a
 * safe no-op, not a regression.
 */
export async function runSyncJobOnce(config: ServerConfig, job: SyncJobRow): Promise<void> {
  const sb = getServiceClient(config);
  const { data: connection, error: connError } = await sb
    .from('commerce_connections')
    .select('id, workspace_id, installation_id, approved_origin, revoked_at, provider_type')
    .eq('id', job.connection_id)
    .maybeSingle();
  if (connError) throw new Error(connError.message);
  if (!connection || connection.revoked_at) {
    await failJob(config, job, 'commerce_not_connected', true);
    return;
  }
  // Only a catalogue-indexed provider is ever synced. A live-queried billing
  // connection (WHMCS) has nothing to copy, by design — see docs/commerce/WHMCS.md.
  if (getProviderDescriptor(String(connection.provider_type ?? 'woocommerce'))?.usesCatalogIndex === false) {
    await failJob(config, job, 'commerce_permission_denied', true);
    return;
  }

  const secret = await readInstallationSecret(config, connection.installation_id);
  if (!secret) {
    await failJob(config, job, 'commerce_not_connected', true);
    return;
  }

  const cursorType = 'products';
  // `sweep_epoch` arrives with migration 198. The migration workflow runs on
  // its own trigger and skips silently when DATABASE_URL is unset, so the
  // worker can legitimately meet a database that does not have the column
  // yet. Asking for it and falling back keeps that case working exactly as it
  // did before, instead of failing every sync on an unknown column.
  let sweepSupported = true;
  let cursorRow: { page?: number; modified_after?: string | null; sweep_epoch?: string | null } | null = null;
  {
    const withSweep = await sb
      .from('commerce_sync_cursors')
      .select('page, modified_after, sweep_epoch')
      .eq('connection_id', job.connection_id)
      .eq('cursor_type', cursorType)
      .maybeSingle();
    if (withSweep.error) {
      sweepSupported = false;
      const legacy = await sb
        .from('commerce_sync_cursors')
        .select('page, modified_after')
        .eq('connection_id', job.connection_id)
        .eq('cursor_type', cursorType)
        .maybeSingle();
      cursorRow = legacy.data ?? null;
    } else {
      cursorRow = withSweep.data ?? null;
    }
  }

  const modifiedAfter = job.job_type === 'incremental_sync' || job.job_type === 'reconciliation' ? (cursorRow?.modified_after ?? null) : null;
  // Resume where the cursor stopped, but only a walk over the same window:
  // the stored page counts through the catalogue AS FILTERED by the cursor's
  // modified_after. An incremental job reads exactly that window, so it
  // always resumes. It used to restart at page 1 on every run instead, so a
  // change set bigger than one run's page budget (a bulk price edit, or the
  // first reconciliation of a large store, which walks everything) re-queued
  // itself forever, re-reading the same MAX_PAGES_PER_RUN pages each time. A
  // full sync resumes only a full walk, never an incremental one's page.
  let page = (cursorRow?.modified_after ?? null) === modifiedAfter ? (cursorRow?.page ?? 1) : 1;

  // A full sync walks the WHOLE catalogue, so anything it does not meet is
  // gone from the store. An incremental one fetches only what changed, where
  // "not met" means nothing at all — sweeping there would empty the index.
  const isFullSync = modifiedAfter === null;
  // The epoch belongs to the whole sync, not to one worker tick: a large
  // catalogue is re-queued across several runs (MAX_PAGES_PER_RUN), and the
  // sweep may only fire once the last page is in. Page 1 starts a new one.
  const sweepEpoch = isFullSync && sweepSupported ? (page === 1 ? new Date().toISOString() : (cursorRow?.sweep_epoch ?? null)) : null;

  let pagesThisRun = 0;
  let hasMore = true;

  try {
    while (hasMore && pagesThisRun < MAX_PAGES_PER_RUN) {
      const { products, hasMore: more } = await fetchProductPage(
        config, job.connection_id, connection.installation_id, connection.approved_origin, secret, page, modifiedAfter,
      );

      const seen: string[] = [];
      for (const raw of products) {
        const product = normalizeWooCommerceProduct(raw);
        if (!product) continue;
        await upsertProductInIndex(config, connection.workspace_id, job.connection_id, product);
        seen.push(product.externalId);
      }

      // Stamp the page in one statement. This cannot be folded into the
      // upsert: commerce_upsert_product skips a row whose version has not
      // moved, and an unchanged product is still very much present.
      if (sweepEpoch && seen.length) {
        await sb
          .from('commerce_products')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('connection_id', job.connection_id)
          .in('external_id', seen);
      }

      // The last page needs no checkpoint of its own: completion rewrites the
      // cursor just below. A pass that finds nothing new — most periodic
      // reconciliations — saves a write this way.
      if (more) {
        await sb.from('commerce_sync_cursors').upsert(
          { connection_id: job.connection_id, cursor_type: cursorType, page: page + 1, modified_after: modifiedAfter, ...(sweepSupported ? { sweep_epoch: sweepEpoch } : {}), updated_at: new Date().toISOString() },
          { onConflict: 'connection_id,cursor_type' },
        );
      }

      hasMore = more;
      page += 1;
      pagesThisRun += 1;
    }

    if (hasMore) {
      // Bounded run limit reached but more pages remain — re-queue rather
      // than blocking this worker tick indefinitely. A run that used its
      // whole page budget made progress, so it is not a failed attempt: every
      // claim counts one, and without the reset a catalogue of more than
      // MAX_ATTEMPTS runs dead-lettered on its first transient error.
      await sb.from('commerce_sync_jobs').update({ status: 'queued', attempts: 0 }).eq('id', job.id);
      return;
    }

    // Sync finished cleanly.
    const now = new Date().toISOString();

    // Sweep: the catalogue has been walked end to end, so a live row this
    // sync never met no longer exists in the store. Deletion is otherwise the
    // only fact carried by webhooks alone — every other drift is corrected by
    // the next sync simply because it rewrites what it finds — so without this
    // a missed `product.deleted` is permanent, and the assistant keeps
    // recommending a product whose page 404s.
    if (isFullSync && sweepEpoch) {
      await sweepUnseenProducts(config, job.connection_id, sweepEpoch);
    }

    await sb.from('commerce_sync_jobs').update({ status: 'succeeded' }).eq('id', job.id);
    await sb
      .from('commerce_sync_cursors')
      .upsert(
        { connection_id: job.connection_id, cursor_type: cursorType, page: 1, modified_after: now, ...(sweepSupported ? { sweep_epoch: null } : {}), updated_at: now },
        { onConflict: 'connection_id,cursor_type' },
      );
    await sb.from('commerce_connections').update({ catalog_ready: true, last_sync_at: now }).eq('id', job.connection_id);
  } catch (err) {
    const code = err instanceof CommerceError ? err.code : 'commerce_live_unavailable';
    await failJob(config, job, code, job.attempts >= job.max_attempts);
  }
}

/**
 * Removes the products a completed FULL sync never met.
 *
 * `last_seen_at` is stamped page by page during the run, so "older than the
 * epoch, or never stamped at all" is exactly "absent from the store's
 * catalogue". Those rows are deleted outright — what stays is one line per
 * product in `commerce_deleted_entities`, so a straggling update from the
 * store's event queue cannot put it back (see the migration).
 *
 * Variants follow their parent through the foreign key's ON DELETE CASCADE:
 * leaving a dead product's variants behind would keep stale prices in the
 * index for anything that later read them.
 *
 * One statement rather than a read followed by two writes, so a sweep of a
 * large catalogue is a single round trip and cannot half-apply.
 *
 * Never called for an incremental sync — see the call site.
 */
async function sweepUnseenProducts(
  config: ServerConfig,
  connectionId: string,
  sweepEpoch: string,
): Promise<void> {
  const sb = getServiceClient(config);

  const { data, error } = await sb.rpc('commerce_sweep_absent_products', {
    p_connection_id: connectionId,
    p_sweep_epoch: sweepEpoch,
  });
  if (error) {
    // A failed sweep must not fail the sync: the catalogue itself is already
    // written and correct, and the next full sync sweeps again.
    console.warn('[commerce.sync] sweep failed:', error.message);
    return;
  }

  const count = typeof data === 'number' ? data : 0;
  if (count) console.log('[commerce.sync] removed products absent from store', { connectionId, count });
}

/** Wait before retrying a transiently failed sync: 30s, 1m, 2m, 4m, ... */
export function syncRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

async function failJob(config: ServerConfig, job: SyncJobRow, code: string, permanent: boolean): Promise<void> {
  const sb = getServiceClient(config);
  const now = Date.now();
  // 401/403/invalid-installation-shaped errors and exhausted retries go to
  // dead_letter; anything else is retried after a backoff.
  const isPermanentCode = code === 'commerce_permission_denied' || code === 'commerce_not_connected' || code === 'protocol_mismatch';
  if (permanent || isPermanentCode) {
    await sb
      .from('commerce_sync_jobs')
      .update({ status: 'dead_letter', last_error_code: code, last_error_at: new Date(now).toISOString() })
      .eq('id', job.id);
    return;
  }
  // Re-queued at once, a failed job was claimed again on the worker's very
  // next poll (50ms later), so all MAX_ATTEMPTS ran within a couple of
  // seconds: a store that was down for one minute dead-lettered its sync. The
  // job instead keeps a lease that nobody holds until the retry is due, and
  // commerce_claim_sync_job reclaims an expired lease exactly as it does a
  // crashed worker's, so this needs no schema change.
  await sb
    .from('commerce_sync_jobs')
    .update({
      status: 'running',
      leased_by: null,
      leased_until: new Date(now + syncRetryDelayMs(job.attempts)).toISOString(),
      last_error_code: code,
      last_error_at: new Date(now).toISOString(),
    })
    .eq('id', job.id);
}

const SUCCEEDED_JOB_KEEP_MS = 7 * 24 * 60 * 60_000;
const DEAD_LETTER_JOB_KEEP_MS = 30 * 24 * 60 * 60_000;
const PRUNE_BATCH = 500;
const MAX_PRUNE_BATCHES = 10;

/**
 * Deletes finished sync jobs that have outlived their use, and returns how
 * many went.
 *
 * Every reconciliation pass enqueues a job per connected store — 96 a day
 * each — and nothing ever removed one, so the table only grew. Succeeded
 * jobs are kept a week; dead-lettered ones a month, since the admin
 * diagnostics list them for retrying. Queued and running jobs are never
 * touched. `updated_at` is set by every claim, so for a finished job it is
 * when its last run started. Bounded per call: at most
 * MAX_PRUNE_BATCHES × PRUNE_BATCH rows per status, and any error just stops
 * this pass.
 */
export async function pruneFinishedSyncJobs(config: ServerConfig, now: number = Date.now()): Promise<number> {
  const sb = getServiceClient(config);
  let removed = 0;
  const rules: Array<[status: string, keepMs: number]> = [
    ['succeeded', SUCCEEDED_JOB_KEEP_MS],
    ['dead_letter', DEAD_LETTER_JOB_KEEP_MS],
  ];
  for (const [status, keepMs] of rules) {
    const cutoff = new Date(now - keepMs).toISOString();
    for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch++) {
      const { data, error } = await sb
        .from('commerce_sync_jobs')
        .select('id')
        .eq('status', status)
        .lt('updated_at', cutoff)
        .limit(PRUNE_BATCH);
      if (error || !data?.length) break;
      const ids = (data as Array<{ id: string }>).map((row) => row.id);
      const { error: deleteError } = await sb.from('commerce_sync_jobs').delete().in('id', ids).eq('status', status);
      if (deleteError) break;
      removed += ids.length;
      if (ids.length < PRUNE_BATCH) break;
    }
  }
  return removed;
}

/** Admin diagnostics — failed jobs without PII/secrets (spec §17). */
export async function listFailedSyncJobs(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_sync_jobs')
    .select('id, connection_id, job_type, status, attempts, last_error_code, last_error_at, created_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'dead_letter')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function retrySyncJob(config: ServerConfig, workspaceId: string, jobId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('commerce_sync_jobs')
    .update({ status: 'queued', attempts: 0, last_error_code: null, last_error_at: null })
    .eq('id', jobId)
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(error.message);
}
