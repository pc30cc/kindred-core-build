/**
 * AI Agent — file ingestion service.
 *
 * Self-hosted, provider-driven. Uses the active workspace storage provider
 * (server/services/storage) to persist the original file, then parses and
 * indexes the extracted text into ai_knowledge_chunks (source_type='file').
 *
 * Pending/failed/deleted file sources never produce active chunks.
 */

import crypto from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import {
  uploadFile, downloadFile, deleteFile, resolveStorageConfig,
} from '../../storage/index.js';
import { chunkText } from '../knowledgeIndex/chunker.js';
import { indexSource, getEmbedderForWorkspace } from '../knowledgeIndex/indexer.js';
import { resolveAiAgentDataLimits } from '../limits.js';
import {
  parseAiFile, isSupportedMime, parserFor, ParseError, type ParseResult,
} from './parsers.js';
import {
  enqueueSourceSyncJob, cancelSourceSyncJob,
} from '../sourceJobs.js';

const HARD_FILE_CAP_MB = 50;
/**
 * JSON base64 transport hard cap. Express JSON limit is 50MB and base64
 * inflates payload by ~33%, so we cap raw file size at 25MB for the
 * /files/upload JSON endpoint. Multipart/streaming is a future pass.
 */
export const JSON_TRANSPORT_MAX_FILE_MB = 25;

export interface IngestInput {
  workspaceId: string;
  userId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface IngestResult {
  source: any;
  chunks_created: number;
  embedded_chunks: number;
  parser: string;
  warnings: string[];
  page_count?: number;
}

export interface QueuedIngestResult {
  source: any;
  jobId: string;
  status: 'queued';
}

export class IngestError extends Error {
  code: string;
  status: number;
  details?: any;
  constructor(code: string, status = 400, message?: string, details?: any) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function safeFileName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  const stripped = base.replace(/\u0000/g, '').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  const trimmed = stripped.slice(0, 180);
  return trimmed || 'file';
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function logFileEvent(
  config: ServerConfig,
  args: {
    workspaceId: string; sourceId: string; status: string; message?: string;
    metadata?: Record<string, unknown>;
    pages_found?: number; chunks_created?: number; embedded_chunks?: number; errors?: number;
  },
) {
  try {
    await getServiceClient(config).from('ai_source_sync_logs').insert({
      workspace_id: args.workspaceId,
      source_id: args.sourceId,
      status: args.status,
      message: args.message ?? null,
      pages_found: args.pages_found ?? 0,
      chunks_created: args.chunks_created ?? 0,
      embedded_chunks: args.embedded_chunks ?? 0,
      errors: args.errors ?? 0,
      metadata: { source_type: 'file', ...(args.metadata || {}) },
    });
  } catch {/* best-effort */}
}

export async function countActiveFileSources(
  config: ServerConfig, workspaceId: string,
): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('ai_data_sources')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .neq('status', 'deleted');
  return count || 0;
}

export interface ResolvedFileLimits {
  maxFiles: number;
  maxFileSizeMB: number;
  effectiveMaxFileSizeMB: number;
  storageProvider: string | null;
  storageReady: boolean;
  storageError: string | null;
  transport: 'json_base64';
  transportMaxFileSizeMB: number;
}

export async function resolveFileLimits(
  config: ServerConfig, workspaceId: string,
): Promise<ResolvedFileLimits> {
  const { limits } = await resolveAiAgentDataLimits(config, workspaceId);
  const storage = await resolveStorageConfig(config, workspaceId);
  const providerCap = storage?.maxFileSizeMB || HARD_FILE_CAP_MB;
  const maxFileSizeMB = Math.min(limits.ai_kb_file_size_mb, providerCap, HARD_FILE_CAP_MB);
  const effectiveMaxFileSizeMB = Math.min(maxFileSizeMB, JSON_TRANSPORT_MAX_FILE_MB);
  const readiness = checkStorageReadiness(storage);
  return {
    maxFiles: limits.ai_kb_file_count,
    maxFileSizeMB,
    effectiveMaxFileSizeMB,
    storageProvider: storage?.provider || null,
    storageReady: readiness.ready,
    storageError: readiness.error,
    transport: 'json_base64',
    transportMaxFileSizeMB: JSON_TRANSPORT_MAX_FILE_MB,
  };
}

function checkStorageReadiness(
  storage: Awaited<ReturnType<typeof resolveStorageConfig>>,
): { ready: boolean; error: string | null } {
  if (!storage) return { ready: false, error: 'storage_not_configured' };
  const p = storage.provider;
  if (p === 'local') {
    if (!storage.publicUrl) return { ready: false, error: 'local_storage_public_url_unconfigured' };
    return { ready: true, error: null };
  }
  if (p === 'bunny_storage') {
    if (!storage.apiKey || !storage.storageZone) return { ready: false, error: 'bunny_missing_api_key_or_zone' };
    return { ready: true, error: null };
  }
  if (['s3', 'cloudflare_r2', 'minio', 'do_spaces', 'gcs', 'azure_blob'].includes(p)) {
    if (!storage.accessKeyId || !storage.secretAccessKey || !storage.bucket) {
      return { ready: false, error: `${p}_missing_credentials_or_bucket` };
    }
    if (p !== 's3' && !storage.endpoint && !storage.s3Region) {
      return { ready: false, error: `${p}_missing_endpoint_or_region` };
    }
    return { ready: true, error: null };
  }
  return { ready: false, error: `unsupported_provider:${p}` };
}

export async function ingestAiFile(
  config: ServerConfig,
  input: IngestInput,
  opts: { bypassPlanLimits?: boolean } = {},
): Promise<IngestResult> {
  const { workspaceId, userId, fileName, mimeType, buffer } = input;

  if (!isSupportedMime(mimeType)) {
    throw new IngestError('unsupported_file_type', 415);
  }
  const parser = parserFor(mimeType)!;

  // Resolve limits & storage provider
  const limits = await resolveFileLimits(config, workspaceId);
  if (!limits.storageProvider) {
    throw new IngestError('storage_not_configured', 500);
  }
  if (!limits.storageReady) {
    throw new IngestError('storage_not_ready', 500, undefined, {
      storageProvider: limits.storageProvider,
      storageError: limits.storageError,
    });
  }
  const sizeMB = buffer.length / (1024 * 1024);
  // Transport cap (JSON base64) always enforced — admin bypass cannot exceed it.
  if (sizeMB > limits.transportMaxFileSizeMB) {
    throw new IngestError('file_size_limit_reached', 413, undefined, {
      maxMB: limits.transportMaxFileSizeMB, actualMB: Math.round(sizeMB * 100) / 100,
      reason: 'transport_cap',
    });
  }
  if (!opts.bypassPlanLimits && sizeMB > limits.effectiveMaxFileSizeMB) {
    throw new IngestError('file_size_limit_reached', 413, undefined, {
      maxMB: limits.effectiveMaxFileSizeMB, actualMB: Math.round(sizeMB * 100) / 100,
    });
  }
  if (!opts.bypassPlanLimits) {
    const used = await countActiveFileSources(config, workspaceId);
    if (used >= limits.maxFiles) {
      throw new IngestError('file_count_limit_reached', 403, undefined, {
        used, limit: limits.maxFiles,
      });
    }
  }

  const sb = getServiceClient(config);
  const safeName = safeFileName(fileName);
  const sha = sha256Hex(buffer);

  // 1. Insert ai_data_sources row first to get id (status='syncing').
  const { data: source, error: insErr } = await sb
    .from('ai_data_sources')
    .insert({
      workspace_id: workspaceId,
      source_type: 'file',
      name: fileName.slice(0, 240),
      base_url: null,
      status: 'syncing',
      include_rules: [],
      exclude_rules: [],
      crawl_depth: 1,
      max_pages: 1,
      refresh_interval: 'manual',
      metadata: {
        original_file_name: fileName,
        safe_file_name: safeName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        sha256: sha,
        parser,
        uploaded_by: userId,
        uploaded_at: new Date().toISOString(),
        storage_provider: limits.storageProvider,
      },
    })
    .select('*')
    .single();
  if (insErr || !source) {
    throw new IngestError('source_create_failed', 500, insErr?.message);
  }

  // 2. Build storage path (workspace-scoped, source-scoped).
  const fileKey = `workspace/${workspaceId}/ai-agent/files/${source.id}/${crypto.randomUUID()}-${safeName}`;

  // 3. Upload original file.
  const upload = await uploadFile(config, {
    workspaceId, fileKey, data: buffer, contentType: mimeType,
  });
  if (!upload.success) {
    await sb.from('ai_data_sources').update({
      status: 'failed',
      last_error: 'upload_failed',
      metadata: { ...(source.metadata as any || {}), upload_error: upload.error },
    }).eq('id', source.id);
    throw new IngestError('upload_failed', 500, upload.error);
  }

  // 4. Parse + index.
  return finalizeIndex(config, source.id, workspaceId, fileName, mimeType, buffer, {
    storage_path: fileKey,
    storage_url: upload.url || null,
    storage_provider: limits.storageProvider,
    safe_file_name: safeName,
    sha256: sha,
    size_bytes: buffer.length,
    uploaded_by: userId,
    uploaded_at: (source.metadata as any)?.uploaded_at || new Date().toISOString(),
    original_file_name: fileName,
    mime_type: mimeType,
    parser,
  });
}

/**
 * Production path (Pass E4-C): Validate, store original file, insert
 * ai_data_sources row, queue file_ingest job. Worker handles parse + index.
 */
export async function queueAiFileIngest(
  config: ServerConfig,
  input: IngestInput,
  opts: { bypassPlanLimits?: boolean } = {},
): Promise<QueuedIngestResult> {
  const { workspaceId, userId, fileName, mimeType, buffer } = input;

  if (!isSupportedMime(mimeType)) throw new IngestError('unsupported_file_type', 415);
  const parser = parserFor(mimeType)!;

  const limits = await resolveFileLimits(config, workspaceId);
  if (!limits.storageProvider) throw new IngestError('storage_not_configured', 500);
  if (!limits.storageReady) {
    throw new IngestError('storage_not_ready', 500, undefined, {
      storageProvider: limits.storageProvider, storageError: limits.storageError,
    });
  }
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB > limits.transportMaxFileSizeMB) {
    throw new IngestError('file_size_limit_reached', 413, undefined, {
      maxMB: limits.transportMaxFileSizeMB, actualMB: Math.round(sizeMB * 100) / 100, reason: 'transport_cap',
    });
  }
  if (!opts.bypassPlanLimits && sizeMB > limits.effectiveMaxFileSizeMB) {
    throw new IngestError('file_size_limit_reached', 413, undefined, {
      maxMB: limits.effectiveMaxFileSizeMB, actualMB: Math.round(sizeMB * 100) / 100,
    });
  }
  if (!opts.bypassPlanLimits) {
    const used = await countActiveFileSources(config, workspaceId);
    if (used >= limits.maxFiles) {
      throw new IngestError('file_count_limit_reached', 403, undefined, { used, limit: limits.maxFiles });
    }
  }

  const sb = getServiceClient(config);
  const safeName = safeFileName(fileName);
  const sha = sha256Hex(buffer);

  // 1. Insert ai_data_sources (status='syncing'; ai_data_sources CHECK forbids 'queued').
  const { data: source, error: insErr } = await sb
    .from('ai_data_sources').insert({
      workspace_id: workspaceId,
      source_type: 'file',
      name: fileName.slice(0, 240),
      base_url: null,
      status: 'syncing',
      include_rules: [],
      exclude_rules: [],
      crawl_depth: 1,
      max_pages: 1,
      refresh_interval: 'manual',
      metadata: {
        original_file_name: fileName,
        safe_file_name: safeName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        sha256: sha,
        parser,
        uploaded_by: userId,
        uploaded_at: new Date().toISOString(),
        storage_provider: limits.storageProvider,
        job_status: 'queued',
      },
    }).select('*').single();
  if (insErr || !source) throw new IngestError('source_create_failed', 500, insErr?.message);

  await logFileEvent(config, {
    workspaceId, sourceId: source.id, status: 'file_upload_received',
    message: `Upload accepted: ${fileName}`,
    metadata: { mime_type: mimeType, size_bytes: buffer.length, parser },
  });

  // 2. Upload original file to active storage provider.
  const fileKey = `workspace/${workspaceId}/ai-agent/files/${source.id}/${crypto.randomUUID()}-${safeName}`;
  const upload = await uploadFile(config, { workspaceId, fileKey, data: buffer, contentType: mimeType });
  if (!upload.success) {
    await sb.from('ai_data_sources').update({
      status: 'failed', last_error: 'upload_failed',
      metadata: { ...(source.metadata as any || {}), upload_error: upload.error, job_status: 'failed' },
    }).eq('id', source.id);
    await logFileEvent(config, {
      workspaceId, sourceId: source.id, status: 'file_parse_failed',
      message: `Storage upload failed: ${upload.error || 'unknown'}`, errors: 1,
    });
    throw new IngestError('upload_failed', 500, upload.error);
  }

  // 3. Persist storage path on the source row.
  await sb.from('ai_data_sources').update({
    metadata: {
      ...(source.metadata as any || {}),
      storage_path: fileKey,
      storage_provider: limits.storageProvider,
      job_status: 'queued',
    },
  }).eq('id', source.id);
  await logFileEvent(config, {
    workspaceId, sourceId: source.id, status: 'file_stored',
    message: 'Original stored', metadata: { storage_provider: limits.storageProvider },
  });

  // 4. Enqueue file_ingest job.
  const job = await enqueueSourceSyncJob(config, {
    workspaceId, sourceId: source.id, jobType: 'file_ingest',
    createdBy: userId, metadata: { trigger: 'upload', original_file_name: fileName },
  });
  await sb.from('ai_data_sources').update({
    metadata: { ...(source.metadata as any || {}), storage_path: fileKey, ingestion_job_id: job.id, job_status: 'queued' },
  }).eq('id', source.id);
  await logFileEvent(config, {
    workspaceId, sourceId: source.id, status: 'file_job_queued',
    message: 'Ingestion job queued', metadata: { job_id: job.id },
  });

  const { data: refreshed } = await sb.from('ai_data_sources').select('*').eq('id', source.id).maybeSingle();
  return { source: refreshed || source, jobId: job.id, status: 'queued' };
}

/**
 * Worker entrypoint. Called by sourceWorker when claiming a job_type='file_ingest' job.
 * Returns ingest summary for log/metadata payload.
 */
export async function runFileIngestJob(
  config: ServerConfig,
  args: { workspaceId: string; sourceId: string; jobId: string; workerId: string },
): Promise<IngestResult> {
  const sb = getServiceClient(config);
  const { data: source } = await sb.from('ai_data_sources').select('*').eq('id', args.sourceId).maybeSingle();
  if (!source) throw new IngestError('source_not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  if (source.workspace_id !== args.workspaceId) throw new IngestError('workspace_mismatch', 400);
  if (source.status === 'deleted') throw new IngestError('source_deleted', 400);
  if (source.status === 'paused') throw new IngestError('source_paused', 400);

  const meta = (source.metadata as any) || {};
  const storagePath: string | undefined = meta.storage_path;
  if (!storagePath) throw new IngestError('storage_path_missing', 400);

  await sb.from('ai_data_sources').update({
    status: 'syncing', last_error: null,
    metadata: { ...meta, job_status: 'running', ingestion_job_id: args.jobId },
  }).eq('id', args.sourceId);
  await logFileEvent(config, {
    workspaceId: args.workspaceId, sourceId: args.sourceId,
    status: 'file_job_started', message: 'Worker started',
    metadata: { job_id: args.jobId, worker_id: args.workerId },
  });

  await logFileEvent(config, {
    workspaceId: args.workspaceId, sourceId: args.sourceId, status: 'file_parse_started',
  });

  const dl = await downloadFile(config, source.workspace_id, storagePath);
  if (!dl.success || !dl.data) {
    const code = 'download_failed';
    await sb.from('ai_data_sources').update({
      status: 'failed', last_error: code,
      metadata: { ...meta, download_error: dl.error || 'unknown', job_status: 'failed' },
    }).eq('id', args.sourceId);
    await logFileEvent(config, {
      workspaceId: args.workspaceId, sourceId: args.sourceId,
      status: 'file_parse_failed', message: code, errors: 1,
    });
    throw new IngestError(code, 500, dl.error);
  }

  const result = await finalizeIndex(
    config, args.sourceId, source.workspace_id,
    meta.original_file_name || source.name || 'file',
    meta.mime_type || 'application/octet-stream',
    dl.data, meta,
  ).catch(async (e) => {
    await logFileEvent(config, {
      workspaceId: args.workspaceId, sourceId: args.sourceId,
      status: e instanceof IngestError && e.code === 'index_failed' ? 'file_index_failed' : 'file_parse_failed',
      message: (e as any)?.message || 'failed', errors: 1,
    });
    throw e;
  });

  // Mark job_status=completed on metadata (status='active' is set by finalizeIndex)
  const { data: latest } = await sb.from('ai_data_sources').select('metadata').eq('id', args.sourceId).maybeSingle();
  await sb.from('ai_data_sources').update({
    metadata: { ...((latest?.metadata as any) || {}), job_status: 'completed' },
  }).eq('id', args.sourceId);

  await logFileEvent(config, {
    workspaceId: args.workspaceId, sourceId: args.sourceId,
    status: 'file_index_completed', message: 'Indexed',
    chunks_created: result.chunks_created, embedded_chunks: result.embedded_chunks,
    pages_found: result.page_count || 1,
    metadata: { parser: result.parser, warnings: result.warnings.slice(0, 10) },
  });
  return result;
}

/** Queue a reindex job; cancels any queued duplicate first. */
export async function queueReindexAiFile(
  config: ServerConfig, sourceId: string, userId: string | null,
): Promise<{ source: any; jobId: string; status: 'queued' }> {
  const sb = getServiceClient(config);
  const { data: source } = await sb.from('ai_data_sources').select('*').eq('id', sourceId).maybeSingle();
  if (!source) throw new IngestError('not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  if (source.status === 'deleted') throw new IngestError('source_deleted', 400);
  const meta = (source.metadata as any) || {};
  if (!meta.storage_path) throw new IngestError('storage_path_missing', 400);

  const job = await enqueueSourceSyncJob(config, {
    workspaceId: source.workspace_id, sourceId, jobType: 'file_ingest',
    createdBy: userId, metadata: { trigger: 'reindex' },
  });
  await sb.from('ai_data_sources').update({
    status: 'syncing', last_error: null,
    metadata: { ...meta, ingestion_job_id: job.id, job_status: 'queued' },
  }).eq('id', sourceId);
  await logFileEvent(config, {
    workspaceId: source.workspace_id, sourceId, status: 'file_job_queued',
    message: 'Reindex queued', metadata: { job_id: job.id },
  });
  const { data: refreshed } = await sb.from('ai_data_sources').select('*').eq('id', sourceId).maybeSingle();
  return { source: refreshed || source, jobId: job.id, status: 'queued' };
}

/** Cancel queued/running file_ingest jobs for a source. */
export async function cancelFileIngestJobsForSource(
  config: ServerConfig, sourceId: string,
): Promise<number> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('ai_source_sync_jobs')
    .select('id, status').eq('source_id', sourceId).eq('job_type', 'file_ingest')
    .in('status', ['queued', 'running']);
  for (const j of (data || [])) {
    await cancelSourceSyncJob(config, { jobId: (j as any).id });
  }
  return (data || []).length;
}

/** Parse + index an already-stored file. */
export async function reindexAiFile(
  config: ServerConfig, sourceId: string,
): Promise<IngestResult> {
  const sb = getServiceClient(config);
  const { data: source } = await sb
    .from('ai_data_sources').select('*').eq('id', sourceId).maybeSingle();
  if (!source) throw new IngestError('not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);

  const meta = (source.metadata as any) || {};
  const storagePath: string | undefined = meta.storage_path;
  if (!storagePath) throw new IngestError('storage_path_missing', 400);

  await sb.from('ai_data_sources').update({ status: 'syncing', last_error: null }).eq('id', sourceId);

  const dl = await downloadFile(config, source.workspace_id, storagePath);
  if (!dl.success || !dl.data) {
    await sb.from('ai_data_sources').update({
      status: 'failed', last_error: 'download_failed',
      metadata: { ...meta, download_error: dl.error || 'unknown' },
    }).eq('id', sourceId);
    throw new IngestError('download_failed', 500, dl.error);
  }

  return finalizeIndex(
    config, sourceId, source.workspace_id,
    meta.original_file_name || source.name || 'file',
    meta.mime_type || 'application/octet-stream',
    dl.data,
    meta,
  );
}

async function finalizeIndex(
  config: ServerConfig,
  sourceId: string,
  workspaceId: string,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  baseMeta: Record<string, any>,
): Promise<IngestResult> {
  const sb = getServiceClient(config);

  // Parse text.
  let parsed: ParseResult;
  try {
    parsed = await parseAiFile(mimeType, buffer);
  } catch (e: any) {
    const code = e instanceof ParseError ? e.code : 'parse_failed';
    await sb.from('ai_data_sources').update({
      status: 'failed', last_error: code,
      metadata: { ...baseMeta, parse_error: code, parse_error_message: e?.message || null },
    }).eq('id', sourceId);
    // Deactivate any existing chunks (fail-closed retrieval).
    await sb.from('ai_knowledge_chunks').update({ status: 'deleted' })
      .eq('workspace_id', workspaceId).eq('source_type', 'file').eq('source_id', sourceId)
      .neq('status', 'deleted');
    throw new IngestError('parse_failed', 422, code);
  }

  // Chunk + index.
  const chunks = chunkText(parsed.text);
  const embedder = await getEmbedderForWorkspace(config, workspaceId);
  try {
    await indexSource(config, {
      workspaceId,
      sourceType: 'file',
      sourceId,
      title: fileName,
      // Never expose storage URLs in retrieval chunks. Storage path/URL
      // live only on ai_data_sources.metadata for internal diagnostics.
      sourceUrl: null,
      locale: null,
      chunks,
      metadata: {
        original_file_name: baseMeta.original_file_name || fileName,
        mime_type: mimeType,
        sha256: baseMeta.sha256,
        parser: parsed.parser,
      },
    }, embedder);
  } catch (e: any) {
    await sb.from('ai_data_sources').update({
      status: 'failed', last_error: 'index_failed',
      metadata: { ...baseMeta, index_error: e?.message || 'unknown' },
    }).eq('id', sourceId);
    throw new IngestError('index_failed', 500, e?.message);
  }

  // Recompute actual active chunk counts so reindex/idempotent runs reflect
  // the real state of the index (not just embeddings produced this run).
  const { count: activeCount } = await sb
    .from('ai_knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .eq('source_id', sourceId)
    .eq('status', 'active');
  const { count: embeddedCount } = await sb
    .from('ai_knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .eq('source_id', sourceId)
    .eq('status', 'active')
    .not('embedding', 'is', null);

  const finalMeta = {
    ...baseMeta,
    parser: parsed.parser,
    page_count: parsed.pageCount ?? baseMeta.page_count ?? null,
    text_length: parsed.textLength,
    warnings: parsed.warnings,
    indexed_at: new Date().toISOString(),
  };
  // clear stale error fields
  delete (finalMeta as any).parse_error;
  delete (finalMeta as any).parse_error_message;
  delete (finalMeta as any).upload_error;
  delete (finalMeta as any).download_error;
  delete (finalMeta as any).index_error;

  const { data: updated } = await sb
    .from('ai_data_sources')
    .update({
      status: 'active',
      last_synced_at: new Date().toISOString(),
      last_error: null,
      last_warning: parsed.warnings[0] || null,
      pages_found: parsed.pageCount || 1,
      chunks_created: activeCount || 0,
      embedded_chunks: embeddedCount || 0,
      metadata: finalMeta,
    })
    .eq('id', sourceId)
    .select('*')
    .single();

  return {
    source: updated,
    chunks_created: activeCount || 0,
    embedded_chunks: embeddedCount || 0,
    parser: parsed.parser,
    warnings: parsed.warnings,
    page_count: parsed.pageCount,
  };
}

export async function deleteAiFile(
  config: ServerConfig, sourceId: string,
): Promise<{ chunks_deleted: number; storage_deleted: boolean; storage_error?: string }> {
  const sb = getServiceClient(config);
  const { data: source } = await sb
    .from('ai_data_sources').select('*').eq('id', sourceId).maybeSingle();
  if (!source) throw new IngestError('not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);

  // 1. Deactivate/delete chunks first.
  const { data: deletedChunks } = await sb
    .from('ai_knowledge_chunks')
    .update({ status: 'deleted' })
    .eq('workspace_id', source.workspace_id)
    .eq('source_type', 'file')
    .eq('source_id', sourceId)
    .neq('status', 'deleted')
    .select('id');

  // 2. Mark source deleted.
  const meta = (source.metadata as any) || {};
  const storagePath: string | undefined = meta.storage_path;

  // 3. Best-effort storage delete.
  let storageDeleted = false;
  let storageError: string | undefined;
  if (storagePath) {
    const r = await deleteFile(config, source.workspace_id, storagePath);
    storageDeleted = !!r.success;
    if (!r.success) storageError = r.error || 'storage_delete_failed';
  }

  await sb.from('ai_data_sources').update({
    status: 'deleted',
    metadata: { ...meta, deleted_at: new Date().toISOString(), storage_delete_error: storageError || null },
  }).eq('id', sourceId);

  return {
    chunks_deleted: (deletedChunks || []).length,
    storage_deleted: storageDeleted,
    storage_error: storageError,
  };
}

export async function pauseAiFile(config: ServerConfig, sourceId: string): Promise<void> {
  const sb = getServiceClient(config);
  const { data: source } = await sb
    .from('ai_data_sources').select('workspace_id, source_type').eq('id', sourceId).maybeSingle();
  if (!source) throw new IngestError('not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  await sb.from('ai_data_sources').update({ status: 'paused' }).eq('id', sourceId);
  await sb.from('ai_knowledge_chunks')
    // ai_knowledge_chunks CHECK allows active|stale|deleted only.
    // 'stale' = retained but excluded from runtime retrieval.
    .update({ status: 'stale' })
    .eq('workspace_id', source.workspace_id)
    .eq('source_type', 'file')
    .eq('source_id', sourceId)
    .eq('status', 'active');
  await cancelFileIngestJobsForSource(config, sourceId);
  await logFileEvent(config, {
    workspaceId: source.workspace_id, sourceId, status: 'file_paused',
    message: 'Source paused; chunks marked stale; queued jobs cancelled',
  });
}

/** Resume by re-queuing a file_ingest job (worker re-parses from stored original). */
export async function resumeAiFile(
  config: ServerConfig, sourceId: string, userId: string | null,
): Promise<{ source: any; jobId: string; status: 'queued' }> {
  const sb = getServiceClient(config);
  const { data: source } = await sb.from('ai_data_sources').select('*').eq('id', sourceId).maybeSingle();
  if (!source) throw new IngestError('not_found', 404);
  if (source.source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  if (source.status === 'deleted') throw new IngestError('source_deleted', 400);
  await logFileEvent(config, {
    workspaceId: source.workspace_id, sourceId, status: 'file_resumed', message: 'Source resumed',
  });
  return queueReindexAiFile(config, sourceId, userId);
}