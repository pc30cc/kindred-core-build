/**
 * DATA HUB — the single choke point for `ai_source_sync_logs` writes.
 *
 * Four producers append to this trail: the source worker (start + finish of a
 * website crawl), file ingestion, and the two knowledge routes that queue or
 * retry a sync job. It is a diagnostics trail, not a job-state store — the
 * authoritative status lives on `ai_data_sources` and `ai_source_sync_jobs`,
 * so suppressing these rows never changes what the worker does or which jobs
 * run. What it does cost is the Data Hub's "did the last sync succeed?"
 * answer and its sync history, which is why this sits behind
 * DELIVERY_DIAGNOSTICS_LOGGING rather than the analytics flag.
 * See server/config.ts.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient, type ServiceClient } from '../../supabase.js';

export interface SourceSyncLogInput {
  workspaceId: string;
  sourceId: string;
  status: string;
  message?: string | null;
  pagesFound?: number;
  chunksCreated?: number;
  embeddedChunks?: number;
  errors?: number;
  metadata?: Record<string, unknown>;
}

/**
 * No-op when DELIVERY_DIAGNOSTICS_LOGGING=off; otherwise inserts the row.
 *
 * Deliberately does NOT catch. Four of the five call sites
 * (sourceWorker.ts:150 and :186, routes/ai-agent/knowledge.ts:1103 and
 * :1147) were bare `await sb.from(...).insert(...)` before this helper
 * existed, so swallowing here would quietly change their default-path error
 * semantics — the flag must not alter behaviour when it is unset. The one
 * caller that DID guard its insert (files/fileIngestion.ts) keeps its own
 * local try/catch, exactly as it had before.
 *
 * `sb` is optional so callers that do not already hold a client (file
 * ingestion) do not have to build one just to reach the flag check.
 */
export async function recordSourceSyncLog(
  config: ServerConfig,
  input: SourceSyncLogInput,
  sb?: ServiceClient,
): Promise<void> {
  if (config.deliveryDiagnosticsLoggingEnabled === false) return;
  await (sb ?? getServiceClient(config)).from('ai_source_sync_logs').insert({
    workspace_id: input.workspaceId,
    source_id: input.sourceId,
    status: input.status,
    message: input.message ?? null,
    pages_found: input.pagesFound ?? 0,
    chunks_created: input.chunksCreated ?? 0,
    embedded_chunks: input.embeddedChunks ?? 0,
    errors: input.errors ?? 0,
    metadata: input.metadata ?? {},
  });
}
