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
import { WooCommerceConnector, normalizeWooCommerceProduct } from './connectors/woocommerce.js';
import { upsertProductInIndex } from './productIndex.js';
import { commerceHttpRequest } from './httpClient.js';
import { buildSignedHeaders } from './signing.js';
import { catalogExportPaths } from './catalogPaths.js';

const MAX_PAGES_PER_RUN = 20; // bounds one worker tick to <= 1000 products
const MAX_ATTEMPTS = 5;

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
    if ((error as any).code === '23505') return null; // one active job per connection already exists
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
): Promise<{ products: any[]; hasMore: boolean }> {
  const { signedPath, requestPath } = catalogExportPaths(page, modifiedAfter);
  const headers = buildSignedHeaders(secret, installationId, 'GET', signedPath, '');
  const res = await commerceHttpRequest({ url: `${origin}${requestPath}`, method: 'GET', headers, retryable: true });
  if (res.status >= 400) throw new CommerceError('commerce_live_unavailable', `catalog export failed: ${res.status}`);
  const body = res.json as any;
  return { products: Array.isArray(body?.products) ? body.products : [], hasMore: body?.has_more === true };
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
    .select('id, workspace_id, installation_id, approved_origin, revoked_at')
    .eq('id', job.connection_id)
    .maybeSingle();
  if (connError) throw new Error(connError.message);
  if (!connection || connection.revoked_at) {
    await failJob(config, job, 'commerce_not_connected', true);
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

  let page = job.job_type === 'incremental_sync' || job.job_type === 'reconciliation' ? 1 : (cursorRow?.page ?? 1);
  const modifiedAfter = job.job_type === 'incremental_sync' || job.job_type === 'reconciliation' ? (cursorRow?.modified_after ?? null) : null;

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

      await sb.from('commerce_sync_cursors').upsert(
        { connection_id: job.connection_id, cursor_type: cursorType, page: page + 1, modified_after: modifiedAfter, ...(sweepSupported ? { sweep_epoch: sweepEpoch } : {}), updated_at: new Date().toISOString() },
        { onConflict: 'connection_id,cursor_type' },
      );

      hasMore = more;
      page += 1;
      pagesThisRun += 1;
    }

    if (hasMore) {
      // Bounded run limit reached but more pages remain — re-queue rather
      // than blocking this worker tick indefinitely.
      await sb.from('commerce_sync_jobs').update({ status: 'queued' }).eq('id', job.id);
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
      await sweepUnseenProducts(config, job.connection_id, sweepEpoch, now);
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
 * Tombstones the products a completed FULL sync never met.
 *
 * `last_seen_at` is stamped page by page during the run, so "older than the
 * epoch, or never stamped at all" is exactly "absent from the store's
 * catalogue". Rows already tombstoned are skipped, so a repeat sync is a
 * no-op rather than a rewrite of every gravestone.
 *
 * Variants follow their parent: the product rows are what the assistant
 * searches, but leaving a dead product's variants live would keep stale
 * prices in the index for anything that later reads them.
 *
 * Never called for an incremental sync — see the call site.
 */
async function sweepUnseenProducts(
  config: ServerConfig,
  connectionId: string,
  sweepEpoch: string,
  nowIso: string,
): Promise<void> {
  const sb = getServiceClient(config);

  const { data: stale, error } = await sb
    .from('commerce_products')
    .select('id')
    .eq('connection_id', connectionId)
    .is('deleted_at', null)
    .or(`last_seen_at.is.null,last_seen_at.lt.${sweepEpoch}`);
  if (error) {
    // A failed sweep must not fail the sync: the catalogue itself is already
    // written and correct, and the next full sync sweeps again.
    console.warn('[commerce.sync] sweep query failed:', error.message);
    return;
  }

  const ids = (stale ?? []).map((r: { id: string }) => r.id);
  if (!ids.length) return;

  await sb.from('commerce_products').update({ deleted_at: nowIso }).in('id', ids);
  await sb.from('commerce_product_variants').update({ deleted_at: nowIso }).in('product_id', ids).is('deleted_at', null);
  console.log('[commerce.sync] swept products absent from store', { connectionId, count: ids.length });
}

async function failJob(config: ServerConfig, job: SyncJobRow, code: string, permanent: boolean): Promise<void> {
  const sb = getServiceClient(config);
  // 401/403/invalid-installation-shaped errors and exhausted retries go to
  // dead_letter; anything else is requeued for the next worker tick.
  const isPermanentCode = code === 'commerce_permission_denied' || code === 'commerce_not_connected' || code === 'protocol_mismatch';
  const status = permanent || isPermanentCode ? 'dead_letter' : 'queued';
  await sb
    .from('commerce_sync_jobs')
    .update({ status, last_error_code: code, last_error_at: new Date().toISOString() })
    .eq('id', job.id);
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
