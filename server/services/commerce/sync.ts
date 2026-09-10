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

const PAGE_SIZE = 50;
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
  const path = '/wp-json/webyar/v1/catalog/export';
  const query = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE) });
  if (modifiedAfter) query.set('modified_after', modifiedAfter);
  const fullPath = `${path}?${query.toString()}`;
  const headers = buildSignedHeaders(secret, installationId, 'GET', fullPath, '');
  const res = await commerceHttpRequest({ url: `${origin}${fullPath}`, method: 'GET', headers, retryable: true });
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
  const { data: cursorRow } = await sb
    .from('commerce_sync_cursors')
    .select('page, modified_after')
    .eq('connection_id', job.connection_id)
    .eq('cursor_type', cursorType)
    .maybeSingle();

  let page = job.job_type === 'incremental_sync' || job.job_type === 'reconciliation' ? 1 : (cursorRow?.page ?? 1);
  const modifiedAfter = job.job_type === 'incremental_sync' || job.job_type === 'reconciliation' ? (cursorRow?.modified_after ?? null) : null;

  let pagesThisRun = 0;
  let hasMore = true;

  try {
    while (hasMore && pagesThisRun < MAX_PAGES_PER_RUN) {
      const { products, hasMore: more } = await fetchProductPage(
        config, job.connection_id, connection.installation_id, connection.approved_origin, secret, page, modifiedAfter,
      );

      for (const raw of products) {
        const product = normalizeWooCommerceProduct(raw);
        if (product) await upsertProductInIndex(config, connection.workspace_id, job.connection_id, product);
      }

      await sb.from('commerce_sync_cursors').upsert(
        { connection_id: job.connection_id, cursor_type: cursorType, page: page + 1, modified_after: modifiedAfter, updated_at: new Date().toISOString() },
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
    await sb.from('commerce_sync_jobs').update({ status: 'succeeded' }).eq('id', job.id);
    await sb
      .from('commerce_sync_cursors')
      .upsert(
        { connection_id: job.connection_id, cursor_type: cursorType, page: 1, modified_after: now, updated_at: now },
        { onConflict: 'connection_id,cursor_type' },
      );
    await sb.from('commerce_connections').update({ catalog_ready: true, last_sync_at: now }).eq('id', job.connection_id);
  } catch (err) {
    const code = err instanceof CommerceError ? err.code : 'commerce_live_unavailable';
    await failJob(config, job, code, job.attempts >= job.max_attempts);
  }
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
