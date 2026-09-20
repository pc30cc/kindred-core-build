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
import { recordSourceSyncLog } from '../sourceSyncLog.js';
import { getServiceClient } from '../../../supabase.js';
import {
  uploadFile, downloadFile, deleteFile, resolveStorageConfig,
} from '../../storage/index.js';
import { aiAgentFileKey } from '../../storage/keys.js';
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

/**
 * Race-safe guard. Throws IngestError with one of:
 *   source_deleted | source_paused | source_not_found | not_a_file_source |
 *   workspace_mismatch | job_cancelled
 * Caller must treat these as cancellation, not failure.
 */
export async function assertFileIngestStillAllowed(
  config: ServerConfig,
  args: { workspaceId: string; sourceId: string; jobId: string; workerId?: string; phase: string },
): Promise<void> {
  const sb = getServiceClient(config);
  const { data: source } = await sb
    .from('ai_data_sources')
    .select('id, source_type, workspace_id, status')
    .eq('id', args.sourceId)
    .maybeSingle();
  if (!source) throw new IngestError('source_not_found', 404);
  if ((source as any).source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  if ((source as any).workspace_id !== args.workspaceId) throw new IngestError('workspace_mismatch', 400);
  if ((source as any).status === 'deleted') throw new IngestError('source_deleted', 400, `phase=${args.phase}`);
  if ((source as any).status === 'paused') throw new IngestError('source_paused', 400, `phase=${args.phase}`);

  const { data: job } = await sb
    .from('ai_source_sync_jobs')
    .select('id, status, job_type, locked_by')
    .eq('id', args.jobId)
    .maybeSingle();
  if (!job) throw new IngestError('job_cancelled', 400, `phase=${args.phase}`);
  if ((job as any).job_type !== 'file_ingest') throw new IngestError('job_cancelled', 400, 'wrong_job_type');
  if ((job as any).status !== 'running') throw new IngestError('job_cancelled', 400, `phase=${args.phase}:status=${(job as any).status}`);
  if (args.workerId && (job as any).locked_by && (job as any).locked_by !== args.workerId) {
    throw new IngestError('job_cancelled', 400, 'worker_mismatch');
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

export async function logFileEvent(
  config: ServerConfig,
  args: {
    workspaceId: string; sourceId: string; status: string; message?: string;
    metadata?: Record<string, unknown>;
    pages_found?: number; chunks_created?: number; embedded_chunks?: number; errors?: number;
  },
) {
  // This caller — and only this one — swallowed its insert error before the
  // shared helper existed. recordSourceSyncLog deliberately does not catch,
  // so the guard stays here rather than moving into it, which would have
  // silently made the four bare call sites non-throwing too.
  try {
    await recordSourceSyncLog(config, {
      workspaceId: args.workspaceId,
      sourceId: args.sourceId,
      status: args.status,
      message: args.message ?? null,
      pagesFound: args.pages_found,
      chunksCreated: args.chunks_created,
      embeddedChunks: args.embedded_chunks,
      errors: args.errors,
      metadata: { source_type: 'file', ...(args.metadata || {}) },
    });
  } catch {/* best-effort */}
}

/**
 * Race-safe terminal failure updater. Only writes status='failed' if the
 * source is STILL in 'syncing'. If admin paused/deleted in the meantime, we
 * preserve that terminal status and surface a cancellation IngestError so the
 * worker wrapper cancels (not fails) the job.
 *
 * Always deactivates any chunks belonging to this file source on failure
 * (default chunkStatusOnFailure='deleted') so retrieval stays fail-closed.
 */
async function markFileSourceFailedIfStillSyncing(
  config: ServerConfig,
  args: {
    workspaceId: string;
    sourceId: string;
    errorCode: string;
    metadataPatch?: Record<string, unknown>;
    chunkStatusOnFailure?: 'deleted' | 'stale';
  },
): Promise<void> {
  const sb = getServiceClient(config);
  const { data: cur } = await sb
    .from('ai_data_sources')
    .select('id, source_type, workspace_id, status, metadata')
    .eq('id', args.sourceId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle();
  if (!cur) throw new IngestError('source_not_found', 404);
  if ((cur as any).source_type !== 'file') throw new IngestError('not_a_file_source', 400);
  const status = (cur as any).status as string;
  if (status === 'deleted') throw new IngestError('source_deleted', 400, args.errorCode);
  if (status === 'paused')  throw new IngestError('source_paused', 400, args.errorCode);
  if (status !== 'syncing') throw new IngestError('job_cancelled', 400, `status=${status}`);

  const baseMeta = ((cur as any).metadata as Record<string, unknown>) || {};
  const merged = { ...baseMeta, ...(args.metadataPatch || {}), job_status: 'failed' };
  // Conditional update: still must be 'syncing' at write time.
  const { data: updated } = await sb
    .from('ai_data_sources')
    .update({ status: 'failed', last_error: args.errorCode, metadata: merged })
    .eq('id', args.sourceId)
    .eq('workspace_id', args.workspaceId)
    .eq('source_type', 'file')
    .eq('status', 'syncing')
    .select('id')
    .maybeSingle();
  if (!updated) {
    // Lost the race between read and write.
    const { data: re } = await sb
      .from('ai_data_sources').select('status').eq('id', args.sourceId).maybeSingle();
    const s = (re as any)?.status as string | undefined;
    if (s === 'deleted') throw new IngestError('source_deleted', 400, args.errorCode);
    if (s === 'paused')  throw new IngestError('source_paused', 400, args.errorCode);
    throw new IngestError('job_cancelled', 400, `status=${s || 'unknown'}`);
  }

  const chunkStatus = args.chunkStatusOnFailure || 'deleted';
  await sb.from('ai_knowledge_chunks')
    .update({ status: chunkStatus })
    .eq('workspace_id', args.workspaceId)
    .eq('source_type', 'file')
    .eq('source_id', args.sourceId)
    .neq('status', 'deleted');
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

/**
 * REMOVED in Pass E4-G. All production file ingestion MUST go through
 * queueAiFileIngest / queueReindexAiFile + the file_ingest worker. Calling
 * the legacy synchronous path bypassed the race-safe job state machine
 * (cancel/pause guards, conditional finalize/complete).
 */
export async function ingestAiFile(): Promise<never> {
  throw new IngestError(
    'sync_file_ingestion_disabled', 410,
    'ingestAiFile is removed. Use queueAiFileIngest.',
  );
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

  // 2. Upload original file to active storage provider, via the central
  // aiAgentFileKey() builder (server/services/storage/keys.ts).
  const fileKey = aiAgentFileKey({ workspaceId, sourceId: source.id, fileName: safeName });
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
  await assertFileIngestStillAllowed(config, { ...args, phase: 'pre_download' });
  const { data: source } = await sb.from('ai_data_sources').select('*').eq('id', args.sourceId).maybeSingle();
  if (!source) throw new IngestError('source_not_found', 404);

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
    // Race-safe: do not overwrite paused/deleted status. Reload first via helper.
    await markFileSourceFailedIfStillSyncing(config, {
      workspaceId: args.workspaceId,
      sourceId: args.sourceId,
      errorCode: code,
      metadataPatch: { download_error: dl.error || 'unknown' },
      chunkStatusOnFailure: 'deleted',
    });
    await logFileEvent(config, {
      workspaceId: args.workspaceId, sourceId: args.sourceId,
      status: 'file_parse_failed', message: code, errors: 1,
    });
    throw new IngestError(code, 500, dl.error);
  }

  // Race-safe: source may have been paused/deleted while downloading.
  await assertFileIngestStillAllowed(config, { ...args, phase: 'post_download_pre_parse' });

  const result = await finalizeIndex(
    config, args.sourceId, source.workspace_id,
    meta.original_file_name || source.name || 'file',
    meta.mime_type || 'application/octet-stream',
    dl.data, meta,
    { jobId: args.jobId, workerId: args.workerId },
  ).catch(async (e) => {
    // Cancellation codes — bubble up untouched so wrapper cancels (not fails) the job.
    const cancellation = new Set(['source_paused', 'source_deleted', 'job_cancelled']);
    if (e instanceof IngestError && cancellation.has(e.code)) {
      await logFileEvent(config, {
        workspaceId: args.workspaceId, sourceId: args.sourceId,
        status: 'file_job_cancelled',
        message: e.code === 'source_paused' ? 'file_ingest_skipped_source_paused'
               : e.code === 'source_deleted' ? 'file_ingest_skipped_source_deleted'
               : 'file_ingest_skipped_job_cancelled',
      });
      throw e;
    }
    await logFileEvent(config, {
      workspaceId: args.workspaceId, sourceId: args.sourceId,
      status: e instanceof IngestError && e.code === 'index_failed' ? 'file_index_failed' : 'file_parse_failed',
      message: (e as any)?.message || 'failed', errors: 1,
    });
    throw e;
  });

  // Mark job_status=completed on metadata only if source is still 'active'.
  // If admin paused/deleted between finalizeIndex and here, do not overwrite.
  const { data: latest } = await sb.from('ai_data_sources')
    .select('status, metadata').eq('id', args.sourceId).maybeSingle();
  if ((latest as any)?.status === 'active') {
    await sb.from('ai_data_sources').update({
      metadata: { ...(((latest as any)?.metadata as any) || {}), job_status: 'completed' },
    }).eq('id', args.sourceId).eq('status', 'active');
  }

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

/**
 * REMOVED in Pass E4-G. Use queueReindexAiFile instead. The legacy sync
 * path bypassed cancel/pause guards and could leave active chunks for a
 * paused/deleted source.
 */
export async function reindexAiFile(): Promise<never> {
  throw new IngestError(
    'sync_file_ingestion_disabled', 410,
    'reindexAiFile is removed. Use queueReindexAiFile.',
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
  guard?: { jobId: string; workerId: string },
): Promise<IngestResult> {
  const sb = getServiceClient(config);

  // Parse text.
  let parsed: ParseResult;
  try {
    parsed = await parseAiFile(mimeType, buffer);
  } catch (e: any) {
    const code = e instanceof ParseError ? e.code : 'parse_failed';
    // Race-safe: only mark failed if source is still 'syncing'. If admin
    // paused/deleted mid-parse, helper throws cancellation IngestError so the
    // worker wrapper cancels the job rather than overwriting status.
    await markFileSourceFailedIfStillSyncing(config, {
      workspaceId, sourceId, errorCode: code,
      metadataPatch: {
        ...baseMeta,
        parse_error: code,
        parse_error_message: e?.message || null,
      },
      chunkStatusOnFailure: 'deleted',
    });
    throw new IngestError(code, 422, e?.message || code);
  }

  // Race-safe: skip indexing if the source was paused/deleted while parsing.
  if (guard) {
    await assertFileIngestStillAllowed(config, {
      workspaceId, sourceId, jobId: guard.jobId, workerId: guard.workerId, phase: 'post_parse_pre_index',
    });
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
    // Race-safe: only mark failed if still 'syncing'.
    await markFileSourceFailedIfStillSyncing(config, {
      workspaceId, sourceId, errorCode: 'index_failed',
      metadataPatch: { ...baseMeta, index_error: e?.message || 'unknown' },
      chunkStatusOnFailure: 'deleted',
    });
    throw new IngestError('index_failed', 500, e?.message);
  }

  // Race-safe: final guard before flipping source/chunks active.
  if (guard) {
    try {
      await assertFileIngestStillAllowed(config, {
        workspaceId, sourceId, jobId: guard.jobId, workerId: guard.workerId, phase: 'pre_finalize',
      });
    } catch (e) {
      // Source paused/deleted between index and finalize: do NOT activate.
      // Fail-closed: mark new chunks stale (paused) or deleted (deleted).
      const { data: cur } = await sb.from('ai_data_sources').select('status').eq('id', sourceId).maybeSingle();
      const targetChunkStatus = (cur as any)?.status === 'deleted' ? 'deleted' : 'stale';
      await sb.from('ai_knowledge_chunks')
        .update({ status: targetChunkStatus })
        .eq('workspace_id', workspaceId).eq('source_type', 'file').eq('source_id', sourceId)
        .eq('status', 'active');
      await logFileEvent(config, {
        workspaceId, sourceId, status: 'file_ingest_finalization_aborted',
        message: e instanceof IngestError ? e.code : 'finalization_aborted',
        metadata: { phase: 'pre_finalize', reason: (e as any)?.code || 'unknown' },
      });
      throw e;
    }
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
    job_status: 'completed',
  };
  // clear stale error fields
  delete (finalMeta as any).parse_error;
  delete (finalMeta as any).parse_error_message;
  delete (finalMeta as any).upload_error;
  delete (finalMeta as any).download_error;
  delete (finalMeta as any).index_error;

  // Conditional final update: only flip to 'active' if status is still
  // 'syncing'. If admin paused/deleted/cancelled the source after the
  // pre_finalize guard, the row count = 0 and we fail closed — never leave
  // active chunks behind for a paused/deleted source.
  let updateQuery = sb
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
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .eq('status', 'syncing');
  const { data: updated } = await updateQuery.select('*').maybeSingle();

  if (!updated) {
    // Race lost. Reload to learn the actual terminal status.
    const { data: cur } = await sb
      .from('ai_data_sources').select('status, metadata').eq('id', sourceId).maybeSingle();
    const curStatus = (cur as any)?.status as string | undefined;
    const targetChunkStatus = curStatus === 'deleted' ? 'deleted' : 'stale';
    await sb.from('ai_knowledge_chunks')
      .update({ status: targetChunkStatus })
      .eq('workspace_id', workspaceId).eq('source_type', 'file').eq('source_id', sourceId)
      .eq('status', 'active');
    const code = curStatus === 'deleted' ? 'source_deleted'
               : curStatus === 'paused'  ? 'source_paused'
               : 'job_cancelled';
    await logFileEvent(config, {
      workspaceId, sourceId, status: 'file_ingest_finalization_aborted',
      message: `final_update_lost_race:${curStatus || 'unknown'}`,
      metadata: { phase: 'final_update', current_status: curStatus || null },
    });
    throw new IngestError(code, 400, `final_update_lost_race:${curStatus || 'unknown'}`);
  }

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

  const meta = (source.metadata as any) || {};

  // Idempotent: if already deleted, do not re-run chunk/storage ops.
  if (source.status === 'deleted') {
    return { chunks_deleted: 0, storage_deleted: false, storage_error: 'already_deleted' };
  }

  // 1. Mark source deleted FIRST so concurrent workers' guards (which read
  //    ai_data_sources.status) immediately see source_deleted and abort.
  //    Preserve storage_path in metadata for the storage-cleanup step below.
  await sb.from('ai_data_sources').update({
    status: 'deleted',
    metadata: { ...meta, deleted_at: new Date().toISOString(), job_status: 'cancelled' },
  }).eq('id', sourceId);

  // 2. Cancel queued/running file_ingest jobs for that source so the worker
  //    wrapper bails out before reactivating anything.
  await cancelFileIngestJobsForSource(config, sourceId);

  // 3. Mark all chunks deleted (no active chunks may remain).
  const { data: deletedChunks } = await sb
    .from('ai_knowledge_chunks')
    .update({ status: 'deleted' })
    .eq('workspace_id', source.workspace_id)
    .eq('source_type', 'file')
    .eq('source_id', sourceId)
    .neq('status', 'deleted')
    .select('id');

  // 4. Best-effort storage delete using saved storage_path.
  const storagePath: string | undefined = meta.storage_path;
  let storageDeleted = false;
  let storageError: string | undefined;
  if (storagePath) {
    const r = await deleteFile(config, source.workspace_id, storagePath);
    storageDeleted = !!r.success;
    if (!r.success) storageError = r.error || 'storage_delete_failed';
  }

  // 5. Persist storage_delete_error if any (do not flip status away from 'deleted').
  if (storageError) {
    const { data: cur } = await sb.from('ai_data_sources').select('metadata').eq('id', sourceId).maybeSingle();
    await sb.from('ai_data_sources').update({
      metadata: { ...((cur?.metadata as any) || {}), storage_delete_error: storageError },
    }).eq('id', sourceId);
  }

  await logFileEvent(config, {
    workspaceId: source.workspace_id, sourceId, status: 'file_deleted',
    message: `Deleted; chunks_removed=${(deletedChunks || []).length}, storage_deleted=${storageDeleted}`,
    metadata: { storage_delete_error: storageError || null },
  });

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