/**
 * Storage Provider implementations — BunnyCDN, S3-compatible, local fallback
 * All operations run server-side only. Secrets never leave the backend.
 *
 * Two execution modes:
 *   1. Workspace-resolved   — uploadFile / downloadFile / deleteFile.
 *      Resolves the workspace's active attachment storage provider from
 *      provider_configs.
 *   2. Explicit-config      — uploadWithConfig / downloadWithConfig /
 *      deleteWithConfig. Caller passes a fully-resolved StorageConfig.
 *      Used by feature-scoped resolvers (e.g. privacy export storage).
 *      No allowed-types/MIME check is enforced here because the artifact
 *      shape is fixed by the caller (e.g. application/zip).
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface StorageConfig {
  provider: string;
  // BunnyCDN
  apiKey?: string;
  storageZone?: string;
  region?: string;
  cdnUrl?: string;
  // S3-compatible
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  s3Region?: string;
  endpoint?: string;
  // Local
  localPath?: string;
  publicUrl?: string;
  // Limits
  maxFileSizeMB?: number;
}

export interface UploadRequest {
  workspaceId: string;
  fileKey: string;
  data: Buffer;
  contentType: string;
}

export interface StorageResult {
  success: boolean;
  url?: string;
  fileKey?: string;
  error?: string;
}

// ─── Allowed file types ──────────────────────────────────────────

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/html', 'text/css',
  'application/javascript', 'application/json',
  'video/mp4', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac',
  'application/zip', 'application/gzip',
  // AI Agent file ingestion (Pass E4-A/B)
  'text/markdown', 'text/x-markdown', 'application/x-markdown',
  'text/csv', 'application/csv', 'application/vnd.ms-excel',
]);

const MAX_FILE_SIZE_DEFAULT = 50 * 1024 * 1024; // 50MB

function validateFile(data: Buffer, contentType: string, maxSizeMB?: number): string | null {
  const maxBytes = (maxSizeMB || 50) * 1024 * 1024;
  if (data.length > maxBytes) return `File too large (max ${maxSizeMB || 50}MB)`;
  if (!ALLOWED_TYPES.has(contentType)) return `File type not allowed: ${contentType}`;
  return null;
}

// ─── BunnyCDN Storage ────────────────────────────────────────────

async function bunnyUpload(config: StorageConfig, req: UploadRequest): Promise<StorageResult> {
  const regionPrefix = config.region && config.region !== 'de' ? `${config.region}.` : '';
  const baseUrl = `https://${regionPrefix}storage.bunnycdn.com/${config.storageZone}`;

  const res = await fetch(`${baseUrl}/${req.fileKey}`, {
    method: 'PUT',
    headers: {
      'AccessKey': config.apiKey!,
      'Content-Type': 'application/octet-stream',
    },
    body: req.data,
  });

  if (!res.ok) {
    return { success: false, error: `BunnyCDN upload failed: ${res.statusText}` };
  }

  const cdnBase = config.cdnUrl || `https://${config.storageZone}.b-cdn.net`;
  return { success: true, url: `${cdnBase}/${req.fileKey}`, fileKey: req.fileKey };
}

async function bunnyDelete(config: StorageConfig, fileKey: string): Promise<StorageResult> {
  const regionPrefix = config.region && config.region !== 'de' ? `${config.region}.` : '';
  const baseUrl = `https://${regionPrefix}storage.bunnycdn.com/${config.storageZone}`;

  const res = await fetch(`${baseUrl}/${fileKey}`, {
    method: 'DELETE',
    headers: { 'AccessKey': config.apiKey! },
  });

  return { success: res.ok, error: res.ok ? undefined : `Delete failed: ${res.statusText}` };
}

function bunnyGetUrl(config: StorageConfig, fileKey: string): string {
  const cdnBase = config.cdnUrl || `https://${config.storageZone}.b-cdn.net`;
  return `${cdnBase}/${fileKey}`;
}

// ─── S3-Compatible Storage ───────────────────────────────────────

function getS3Endpoint(config: StorageConfig): string {
  if (config.endpoint) return config.endpoint;
  return `https://s3.${config.s3Region || 'us-east-1'}.amazonaws.com`;
}

function signS3Request(
  method: string,
  url: string,
  config: StorageConfig,
  contentType?: string,
  body?: Buffer
): Record<string, string> {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const timeStr = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const region = config.s3Region || 'us-east-1';
  const parsed = new URL(url);

  const headers: Record<string, string> = {
    'Host': parsed.host,
    'x-amz-date': timeStr,
    'x-amz-content-sha256': body
      ? crypto.createHash('sha256').update(body).digest('hex')
      : 'UNSIGNED-PAYLOAD',
  };
  if (contentType) headers['Content-Type'] = contentType;

  // Simplified SigV4 — for production, use AWS SDK or a proper signing lib
  const credential = `${config.accessKeyId}/${dateStr}/${region}/s3/aws4_request`;
  const signedHeaders = Object.keys(headers).sort().join(';').toLowerCase();

  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k]}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    method,
    parsed.pathname,
    parsed.search?.slice(1) || '',
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timeStr,
    `${dateStr}/${region}/s3/aws4_request`,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = crypto.createHmac('sha256', `AWS4${config.secretAccessKey}`).update(dateStr).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

async function s3Upload(config: StorageConfig, req: UploadRequest): Promise<StorageResult> {
  const endpoint = getS3Endpoint(config);
  const url = `${endpoint}/${config.bucket}/${req.fileKey}`;
  const headers = signS3Request('PUT', url, config, req.contentType, req.data);

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': req.contentType },
    body: req.data,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `S3 upload failed: ${res.status} ${text.slice(0, 200)}` };
  }

  const publicUrl = config.cdnUrl
    ? `${config.cdnUrl}/${req.fileKey}`
    : `${endpoint}/${config.bucket}/${req.fileKey}`;

  return { success: true, url: publicUrl, fileKey: req.fileKey };
}

async function s3Delete(config: StorageConfig, fileKey: string): Promise<StorageResult> {
  const endpoint = getS3Endpoint(config);
  const url = `${endpoint}/${config.bucket}/${fileKey}`;
  const headers = signS3Request('DELETE', url, config);

  const res = await fetch(url, { method: 'DELETE', headers });
  return { success: res.ok, error: res.ok ? undefined : `Delete failed: ${res.statusText}` };
}

function s3GetUrl(config: StorageConfig, fileKey: string): string {
  if (config.cdnUrl) return `${config.cdnUrl}/${fileKey}`;
  const endpoint = getS3Endpoint(config);
  return `${endpoint}/${config.bucket}/${fileKey}`;
}

// ─── Local Storage (dev fallback) ────────────────────────────────

function ensureLocalDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function localUpload(config: StorageConfig, req: UploadRequest): Promise<StorageResult> {
  const basePath = config.localPath || '/tmp/storage';
  const filePath = path.join(basePath, req.fileKey);
  ensureLocalDir(path.dirname(filePath));
  fs.writeFileSync(filePath, req.data);
  const base = (config.publicUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    // Fail loud rather than silently link visitors to localhost on a
    // production deploy. The local provider must be configured with a
    // public_url that's reachable from the browser.
    return {
      success: false,
      error: 'local_storage_public_url_unconfigured',
    };
  }
  return { success: true, url: `${base}/${req.fileKey}`, fileKey: req.fileKey };
}

async function localDelete(config: StorageConfig, fileKey: string): Promise<StorageResult> {
  const filePath = path.join(config.localPath || '/tmp/storage', fileKey);
  try { fs.unlinkSync(filePath); } catch { /* file may already be gone */ }
  return { success: true };
}

function localGetUrl(config: StorageConfig, fileKey: string): string {
  const base = (config.publicUrl || '').trim().replace(/\/+$/, '');
  // Returning an empty path (rather than a localhost URL) ensures callers
  // that do not handle missing config will surface a broken link in dev
  // instead of silently pointing visitors at the operator's loopback.
  if (!base) return `/storage/${fileKey}`;
  return `${base}/${fileKey}`;
}

// ─── Download (server-side proxy fetch) ──────────────────────────
//
// Used by the widget attachment proxy route. Returns the raw bytes for a
// previously stored file. NEVER expose provider URLs to the visitor — this
// helper reads from the active provider on the backend so we can stream
// through an authenticated /api/widget/attachments/:id route.

export interface DownloadResult {
  success: boolean;
  data?: Buffer;
  error?: string;
}

// ─── Ranged Download (read-only, optional Range header) ──────────
//
// Used by the super-admin recording proxy to honor HTTP Range requests
// without pulling the entire artifact into memory when the client only
// needs a slice. The provider abstraction stays canonical: callers never
// see provider URLs or credentials. Behavior:
//
//   • rangeHeader undefined → full download (status 200)
//   • rangeHeader present + provider supports range → 206 with sliced bytes
//   • rangeHeader present + provider returns 200 → caller MUST treat as full
//
// This helper is intentionally read-only; it never mutates storage.

export interface RangedDownloadResult {
  success: boolean;
  status?: number;            // 200 (full) or 206 (partial)
  data?: Buffer;
  error?: string;
  contentLength?: number;     // length of returned body
  contentRange?: string;      // e.g. "bytes 0-1023/10485760"
  totalSize?: number;         // total object size when known
  acceptRanges?: boolean;     // provider confirmed range support
}

function parseSingleRange(range: string, totalSize?: number): { start: number; end?: number } | null {
  // Accept only the simple "bytes=START-END" / "bytes=START-" form.
  const m = /^bytes=(\d+)-(\d*)$/i.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  if (!Number.isFinite(start) || start < 0) return null;
  if (end != null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

async function bunnyDownloadRange(
  config: StorageConfig,
  fileKey: string,
  rangeHeader?: string,
): Promise<RangedDownloadResult> {
  const regionPrefix = config.region && config.region !== 'de' ? `${config.region}.` : '';
  const baseUrl = `https://${regionPrefix}storage.bunnycdn.com/${config.storageZone}`;
  const headers: Record<string, string> = { 'AccessKey': config.apiKey! };
  if (rangeHeader) headers['Range'] = rangeHeader;
  const res = await fetch(`${baseUrl}/${fileKey}`, { method: 'GET', headers });
  if (!res.ok && res.status !== 206) {
    return { success: false, status: res.status, error: `BunnyCDN download failed: ${res.statusText}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const cr = res.headers.get('content-range') || undefined;
  const cl = res.headers.get('content-length');
  return {
    success: true,
    status: res.status,
    data: buf,
    contentLength: cl ? Number(cl) : buf.length,
    contentRange: cr,
    acceptRanges: res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') || ''),
  };
}

async function s3DownloadRange(
  config: StorageConfig,
  fileKey: string,
  rangeHeader?: string,
): Promise<RangedDownloadResult> {
  const endpoint = getS3Endpoint(config);
  const url = `${endpoint}/${config.bucket}/${fileKey}`;
  const baseHeaders = signS3Request('GET', url, config);
  const headers: Record<string, string> = { ...baseHeaders };
  if (rangeHeader) headers['Range'] = rangeHeader;
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok && res.status !== 206) {
    return { success: false, status: res.status, error: `S3 download failed: ${res.status}` };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const cr = res.headers.get('content-range') || undefined;
  const cl = res.headers.get('content-length');
  return {
    success: true,
    status: res.status,
    data: buf,
    contentLength: cl ? Number(cl) : buf.length,
    contentRange: cr,
    acceptRanges: res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') || ''),
  };
}

async function localDownloadRange(
  config: StorageConfig,
  fileKey: string,
  rangeHeader?: string,
): Promise<RangedDownloadResult> {
  try {
    const filePath = path.join(config.localPath || '/tmp/storage', fileKey);
    const stat = fs.statSync(filePath);
    const total = stat.size;
    if (!rangeHeader) {
      const data = fs.readFileSync(filePath);
      return {
        success: true,
        status: 200,
        data,
        contentLength: data.length,
        totalSize: total,
        acceptRanges: true,
      };
    }
    const parsed = parseSingleRange(rangeHeader, total);
    if (!parsed) {
      // Unsatisfiable: return full body and let caller treat as 200.
      const data = fs.readFileSync(filePath);
      return { success: true, status: 200, data, contentLength: data.length, totalSize: total, acceptRanges: true };
    }
    const start = parsed.start;
    const end = Math.min(parsed.end ?? total - 1, total - 1);
    if (start >= total) {
      return { success: false, status: 416, error: 'range_not_satisfiable', totalSize: total };
    }
    const length = end - start + 1;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return {
        success: true,
        status: 206,
        data: buf,
        contentLength: length,
        contentRange: `bytes ${start}-${end}/${total}`,
        totalSize: total,
        acceptRanges: true,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

const rangedDownloadHandlers: Record<string, (c: StorageConfig, k: string, r?: string) => Promise<RangedDownloadResult>> = {
  bunny_storage: bunnyDownloadRange,
  s3: s3DownloadRange,
  cloudflare_r2: s3DownloadRange,
  minio: s3DownloadRange,
  do_spaces: s3DownloadRange,
  gcs: s3DownloadRange,
  azure_blob: s3DownloadRange,
  local: localDownloadRange,
};

/**
 * Download a file's bytes through the active provider, optionally honoring
 * an HTTP Range header. Read-only. Used by the super-admin recording proxy
 * so large recordings stream as partial content instead of being fully
 * buffered. Callers MUST handle both 200 (full) and 206 (partial) results.
 */
export async function downloadFileRange(
  serverConfig: ServerConfig,
  workspaceId: string,
  fileKey: string,
  rangeHeader?: string,
): Promise<RangedDownloadResult> {
  const storageConfig = await resolveStorageConfig(serverConfig, workspaceId);
  if (!storageConfig) return { success: false, error: 'No storage provider configured' };
  const handler = rangedDownloadHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported provider: ${storageConfig.provider}` };
  return handler(storageConfig, fileKey, rangeHeader);
}

async function bunnyDownload(config: StorageConfig, fileKey: string): Promise<DownloadResult> {
  const regionPrefix = config.region && config.region !== 'de' ? `${config.region}.` : '';
  const baseUrl = `https://${regionPrefix}storage.bunnycdn.com/${config.storageZone}`;
  const res = await fetch(`${baseUrl}/${fileKey}`, {
    method: 'GET',
    headers: { 'AccessKey': config.apiKey! },
  });
  if (!res.ok) return { success: false, error: `BunnyCDN download failed: ${res.statusText}` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { success: true, data: buf };
}

async function s3Download(config: StorageConfig, fileKey: string): Promise<DownloadResult> {
  const endpoint = getS3Endpoint(config);
  const url = `${endpoint}/${config.bucket}/${fileKey}`;
  const headers = signS3Request('GET', url, config);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) return { success: false, error: `S3 download failed: ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { success: true, data: buf };
}

async function localDownload(config: StorageConfig, fileKey: string): Promise<DownloadResult> {
  try {
    const filePath = path.join(config.localPath || '/tmp/storage', fileKey);
    const data = fs.readFileSync(filePath);
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

const downloadHandlers: Record<string, (config: StorageConfig, key: string) => Promise<DownloadResult>> = {
  bunny_storage: bunnyDownload,
  s3: s3Download,
  cloudflare_r2: s3Download,
  minio: s3Download,
  do_spaces: s3Download,
  gcs: s3Download,
  azure_blob: s3Download,
  local: localDownload,
};

/**
 * Download a file's bytes through the active provider (backend-only).
 * Used by the widget attachment proxy route.
 */
export async function downloadFile(
  serverConfig: ServerConfig,
  workspaceId: string,
  fileKey: string,
): Promise<DownloadResult> {
  const storageConfig = await resolveStorageConfig(serverConfig, workspaceId);
  if (!storageConfig) return { success: false, error: 'No storage provider configured' };
  const handler = downloadHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported provider: ${storageConfig.provider}` };
  return handler(storageConfig, fileKey);
}

// ─── Provider Router ─────────────────────────────────────────────

const uploadHandlers: Record<string, (config: StorageConfig, req: UploadRequest) => Promise<StorageResult>> = {
  bunny_storage: bunnyUpload,
  s3: s3Upload,
  cloudflare_r2: s3Upload,
  minio: s3Upload,
  do_spaces: s3Upload,
  gcs: s3Upload, // GCS has S3-compatible interop
  azure_blob: s3Upload,
  local: localUpload,
};

const deleteHandlers: Record<string, (config: StorageConfig, key: string) => Promise<StorageResult>> = {
  bunny_storage: bunnyDelete,
  s3: s3Delete,
  cloudflare_r2: s3Delete,
  minio: s3Delete,
  do_spaces: s3Delete,
  local: localDelete,
};

const urlHandlers: Record<string, (config: StorageConfig, key: string) => string> = {
  bunny_storage: bunnyGetUrl,
  s3: s3GetUrl,
  cloudflare_r2: s3GetUrl,
  minio: s3GetUrl,
  do_spaces: s3GetUrl,
  local: localGetUrl,
};

/**
 * Resolve storage config from DB for a workspace.
 */
export async function resolveStorageConfig(serverConfig: ServerConfig, workspaceId: string): Promise<StorageConfig | null> {
  const sb = getServiceClient(serverConfig);

  // 1. Workspace override
  const { data: wsConfig } = await sb
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'storage')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (wsConfig?.config) {
    return mapDBConfigToStorage(wsConfig.provider_name, wsConfig.config as any);
  }

  // 2. Global default
  const { data: globalConfig } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_storage_provider')
    .single();

  if (globalConfig?.value) {
    const c = globalConfig.value as any;
    const providerName = c.provider_name || c.provider || 'local';
    const providerConfig = c.config && typeof c.config === 'object' ? c.config : c;
    return mapDBConfigToStorage(providerName, providerConfig);
  }

  // 3. Fallback to local
  return { provider: 'local', localPath: '/tmp/storage' };
}

/**
 * Resolve the app-wide storage provider only (no workspace override).
 * Used for platform-owned assets such as global call-center ringback audio.
 */
export async function resolveGlobalStorageConfig(serverConfig: ServerConfig): Promise<StorageConfig | null> {
  const sb = getServiceClient(serverConfig);
  const { data: globalConfig } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_storage_provider')
    .maybeSingle();

  if (!globalConfig?.value) return null;
  const c = globalConfig.value as any;
  const providerName = c.provider_name || c.provider || 'local';
  const providerConfig = c.config && typeof c.config === 'object' ? c.config : c;
  return mapDBConfigToStorage(providerName, providerConfig);
}

function mapDBConfigToStorage(provider: string, c: any): StorageConfig {
  // Bunny Storage now ships with FTP-style fields in the admin UI
  // (username / hostname / connection_type / port / password). Map them
  // to the existing storage primitives so upload/delete handlers keep
  // working without provider-specific code paths.
  const bunnyApiKey = c.api_key || c.password;
  const bunnyZone = c.storage_zone || c.username;
  const bunnyEndpoint = c.endpoint || c.hostname;
  return {
    provider,
    apiKey: bunnyApiKey,
    storageZone: bunnyZone,
    region: c.region,
    cdnUrl: c.cdn_url || c.cdn_endpoint || c.public_url,
    accessKeyId: c.access_key_id || c.access_key,
    secretAccessKey: c.secret_access_key || c.secret_key,
    bucket: c.bucket || c.container,
    s3Region: c.region,
    endpoint: bunnyEndpoint,
    localPath: c.local_path || c.path,
    publicUrl: c.public_url || c.publicUrl,
    maxFileSizeMB: c.max_file_size ? parseInt(c.max_file_size) : undefined,
  };
}

/**
 * Upload a file through the resolved storage provider.
 */
export async function uploadFile(
  serverConfig: ServerConfig,
  req: UploadRequest
): Promise<StorageResult> {
  const storageConfig = await resolveStorageConfig(serverConfig, req.workspaceId);
  if (!storageConfig) {
    return { success: false, error: 'No storage provider configured' };
  }

  // Validate file
  const validationError = validateFile(req.data, req.contentType, storageConfig.maxFileSizeMB);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const handler = uploadHandlers[storageConfig.provider];
  if (!handler) {
    return { success: false, error: `Unsupported storage provider: ${storageConfig.provider}` };
  }

  const sb = getServiceClient(serverConfig);
  let result: StorageResult;

  try {
    result = await handler(storageConfig, req);

    await sb.from('storage_usage_logs').insert({
      workspace_id: req.workspaceId,
      provider_name: storageConfig.provider,
      operation: 'upload',
      file_key: req.fileKey,
      file_size: req.data.length,
      content_type: req.contentType,
      success: result.success,
      error_message: result.error,
    });
  } catch (err: any) {
    await sb.from('storage_usage_logs').insert({
      workspace_id: req.workspaceId,
      provider_name: storageConfig.provider,
      operation: 'upload',
      file_key: req.fileKey,
      success: false,
      error_message: err.message,
    });
    return { success: false, error: err.message };
  }

  return result;
}

/**
 * Delete a file through the resolved storage provider.
 */
export async function deleteFile(
  serverConfig: ServerConfig,
  workspaceId: string,
  fileKey: string
): Promise<StorageResult> {
  const storageConfig = await resolveStorageConfig(serverConfig, workspaceId);
  if (!storageConfig) return { success: false, error: 'No storage provider configured' };

  const handler = deleteHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported provider: ${storageConfig.provider}` };

  const sb = getServiceClient(serverConfig);
  try {
    const result = await handler(storageConfig, fileKey);
    // Resolve freed bytes from the latest successful upload log for this
    // (workspace, file_key). The canonical storage_bytes producer (DB trigger
    // on storage_usage_logs) decrements only when file_size is present, so
    // missing this lookup would silently leak counter occupancy. We never
    // guess sizes — if no prior upload row is found, file_size stays null
    // and the trigger correctly skips the decrement.
    let freedBytes: number | null = null;
    if (result.success) {
      const { data: prior } = await sb
        .from('storage_usage_logs')
        .select('file_size')
        .eq('workspace_id', workspaceId)
        .eq('file_key', fileKey)
        .eq('operation', 'upload')
        .eq('success', true)
        .not('file_size', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior && typeof (prior as any).file_size === 'number') {
        freedBytes = (prior as any).file_size as number;
      }
    }
    await sb.from('storage_usage_logs').insert({
      workspace_id: workspaceId,
      provider_name: storageConfig.provider,
      operation: 'delete',
      file_key: fileKey,
      file_size: freedBytes,
      success: result.success,
      error_message: result.error,
    });
    return result;
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Get public URL for a file.
 */
export async function getFileUrl(
  serverConfig: ServerConfig,
  workspaceId: string,
  fileKey: string
): Promise<string | null> {
  const storageConfig = await resolveStorageConfig(serverConfig, workspaceId);
  if (!storageConfig) return null;
  const handler = urlHandlers[storageConfig.provider];
  if (!handler) return null;
  return handler(storageConfig, fileKey);
}

export function getFileUrlWithConfig(storageConfig: StorageConfig, fileKey: string): string | null {
  const handler = urlHandlers[storageConfig.provider];
  if (!handler) return null;
  return handler(storageConfig, fileKey);
}

// ─── Explicit-config helpers (feature-scoped resolvers use these) ────
//
// These bypass the workspace attachment-storage resolver and trust the
// caller's StorageConfig. They're used by privacy exports and any future
// feature that needs a dedicated provider policy. No file-type whitelist
// is enforced because the caller fully controls the upload (e.g. ZIP).

export async function uploadWithConfig(
  storageConfig: StorageConfig,
  req: UploadRequest,
): Promise<StorageResult> {
  const handler = uploadHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported storage provider: ${storageConfig.provider}` };
  // Basic size guard only (no MIME whitelist — caller controls payload shape).
  const maxBytes = (storageConfig.maxFileSizeMB || 500) * 1024 * 1024;
  if (req.data.length > maxBytes) {
    return { success: false, error: `File too large (max ${storageConfig.maxFileSizeMB || 500}MB)` };
  }
  return handler(storageConfig, req);
}

export async function downloadWithConfig(
  storageConfig: StorageConfig,
  fileKey: string,
): Promise<DownloadResult> {
  const handler = downloadHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported provider: ${storageConfig.provider}` };
  return handler(storageConfig, fileKey);
}

export async function deleteWithConfig(
  storageConfig: StorageConfig,
  fileKey: string,
): Promise<StorageResult> {
  const handler = deleteHandlers[storageConfig.provider];
  if (!handler) return { success: false, error: `Unsupported provider: ${storageConfig.provider}` };
  return handler(storageConfig, fileKey);
}

/**
 * Test storage connection with a real upload + delete.
 */
export async function testStorageConnection(config: StorageConfig): Promise<{
  success: boolean;
  latencyMs: number;
  error?: string;
}> {
  const testKey = `_test/${Date.now()}.txt`;
  const testData = Buffer.from('connectivity test');
  const start = Date.now();

  const handler = uploadHandlers[config.provider];
  const delHandler = deleteHandlers[config.provider];

  if (!handler) return { success: false, latencyMs: 0, error: `Unknown provider: ${config.provider}` };

  try {
    const result = await handler(config, {
      workspaceId: 'test',
      fileKey: testKey,
      data: testData,
      contentType: 'text/plain',
    });

    if (!result.success) return { success: false, latencyMs: Date.now() - start, error: result.error };

    // Cleanup
    if (delHandler) await delHandler(config, testKey);

    return { success: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { success: false, latencyMs: Date.now() - start, error: err.message };
  }
}
