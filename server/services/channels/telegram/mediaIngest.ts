/**
 * Inbound channel media — CORE SIDE (persistence only, NO network).
 *
 * Core cannot reach the provider in a restricted-network deployment, so the
 * download itself is a `media_fetch` provider operation executed by the
 * Channels Worker. The worker streams the raw bytes back over the internal
 * boundary (`POST /internal/channels/media-ingest`) and this module does what
 * it always did with them: validate size/mime, enforce the SAME storage_gb
 * entitlement as the widget and operator upload routes, and persist through
 * the SAME in-process storage service.
 *
 * Hard rule (unchanged): nothing derived from the bot token — the token, or a
 * provider URL containing it — may ever reach a database row, a log line or
 * an attachment. Only the bot-agnostic `file_id` is allowed in metadata.
 *
 * Failures are NON-FATAL: a media problem must never lose the already
 * inserted text message.
 */

import crypto from 'crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { redactToken } from '../../../../shared/channels/redact.js';
import { requestProviderOperation, type ProviderOperation } from '../operations.js';
import { uploadFile, resolveStorageConfig, getFileUrlWithConfig } from '../../storage/index.js';
import { requireLimit } from '../../../middleware/featureGating.js';
import { usageFnForLimit } from '../../billing/usageResolvers.js';

export type TelegramInboundAttachment = {
  fileId: string;
  kind: string;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

export type TelegramMediaOutcome = {
  fileId: string;
  kind: string;
  status: 'stored' | 'failed' | 'pending';
  attachmentId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Redacted — safe to persist in message metadata / logs. */
  error?: string;
};

// ─── Hard bounds — mirrors conversationAttachments.ts / widgetAttachments.ts ──
export const HARD_MAX_BYTES = 25 * 1024 * 1024; // 25MB, same as visitor/operator uploads
/** Profile photos are small; anything bigger is not a legitimate avatar. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
  'video/mp4',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

function safeFileName(name: string, mime: string): string {
  const stripped = String(name || '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (stripped) return stripped;
  return `file.${EXT_BY_MIME[mime] || 'bin'}`;
}

/** Identical convention to conversationAttachments.ts / widgetAttachments.ts. */
function buildStoragePath(workspaceId: string, fileName: string, mime: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  return `workspace/${workspaceId}/attachments/${yyyy}/${mm}/${uuid}-${safeFileName(fileName, mime)}`;
}

/**
 * Enforces the same storage_gb entitlement as the HTTP upload routes by
 * calling the shared `requireLimit` middleware in-process with a minimal
 * fake req/res. No route-local storage math — see docs/STORAGE_LIMIT_POLICY.md.
 */
async function checkStorageQuota(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const limitMw = requireLimit('storage_gb', usageFnForLimit('storage_gb'));
  const req: any = { body: { workspace_id: workspaceId }, query: {}, params: {}, serverConfig: config };
  let allowed = false;
  let reason: string | undefined;
  const res: any = {
    status(code: number) { (res as any)._status = code; return res; },
    json(body: any) { reason = body?.error || `limit_check_failed_${(res as any)._status}`; return res; },
  };
  await limitMw(req, res, () => { allowed = true; });
  return allowed ? { allowed: true } : { allowed: false, reason: reason || 'storage_gb limit reached' };
}

export type TelegramMediaIngestInput = {
  workspaceId: string;
  integrationId: string;
  conversationId: string;
  messageId: string;
  attachments: TelegramInboundAttachment[];
};

/**
 * Queues the download. Returns `pending` outcomes so the message metadata is
 * honest about what is still in flight instead of pretending the media failed.
 */
export async function requestTelegramMediaFetch(
  config: ServerConfig,
  input: TelegramMediaIngestInput,
): Promise<{ outcomes: TelegramMediaOutcome[]; operation: ProviderOperation | null }> {
  const outcomes: TelegramMediaOutcome[] = input.attachments.map((att) => ({
    fileId: att.fileId,
    kind: att.kind,
    status: 'pending' as const,
  }));
  if (!input.attachments.length) return { outcomes, operation: null };

  try {
    const operation = await requestProviderOperation(config, {
      provider: 'telegram',
      operation: 'media_fetch',
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
      installationId: null,
      request: {
        conversation_id: input.conversationId,
        message_id: input.messageId,
        max_bytes: HARD_MAX_BYTES,
        attachments: input.attachments.map((att) => ({
          file_id: att.fileId,
          kind: att.kind,
          file_name: att.fileName ?? null,
          mime_type: att.mimeType ?? null,
          size: att.size ?? null,
        })),
      },
    });
    return { outcomes, operation };
  } catch (err) {
    const reason = redactToken(err instanceof Error ? err.message : String(err)).slice(0, 300);
    return {
      outcomes: input.attachments.map((att) => ({
        fileId: att.fileId,
        kind: att.kind,
        status: 'failed' as const,
        error: reason,
      })),
      operation: null,
    };
  }
}

export function resolveInboundMimeType(
  declaredMime: string | null | undefined,
  kind: string,
  filePath: string,
): string {
  if (declaredMime) return declaredMime.toLowerCase();
  if (kind === 'photo') return 'image/jpeg';
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', txt: 'text/plain',
    ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    mp4: 'video/mp4',
  };
  return byExt[ext] || 'application/octet-stream';
}

/**
 * Persists ONE attachment delivered by the worker. Never throws: the caller
 * gets an outcome it can safely write into message metadata.
 */
export async function persistInboundAttachment(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    fileId: string;
    kind: string;
    fileName?: string | null;
    mimeType?: string | null;
    filePath?: string | null;
    bytes: Buffer;
  },
): Promise<TelegramMediaOutcome> {
  const sb = getServiceClient(config);
  try {
    if (input.bytes.byteLength > HARD_MAX_BYTES) throw new Error('file_too_large');

    const mimeType = resolveInboundMimeType(input.mimeType, input.kind, input.filePath || input.fileName || '');
    if (!ALLOWED_MIMES.has(mimeType)) throw new Error(`mime_type_not_allowed:${mimeType}`);

    // Same storage_gb entitlement gate as the HTTP upload routes.
    const quota = await checkStorageQuota(config, input.workspaceId);
    if (!quota.allowed) throw new Error(quota.reason || 'storage_gb_limit_reached');

    const fileName = safeFileName(
      input.fileName || (input.filePath || '').split('/').pop() || `telegram-${input.kind}`,
      mimeType,
    );
    const storagePath = buildStoragePath(input.workspaceId, fileName, mimeType);

    const storageConfig = await resolveStorageConfig(config, input.workspaceId);
    const providerName = storageConfig?.provider || 'local';

    // Reserve the canonical row exactly like the widget/operator path.
    const { data: row, error: insertError } = await sb
      .from('conversation_attachments')
      .insert({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        storage_provider: providerName,
        storage_path: storagePath,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: input.bytes.byteLength,
        uploaded_by_type: 'contact',
        uploaded_by_id: null,
        status: 'uploading',
      })
      .select('id')
      .single();
    if (insertError || !row) throw new Error('attachment_row_insert_failed');

    const uploadResult = await uploadFile(config, {
      workspaceId: input.workspaceId,
      fileKey: storagePath,
      data: input.bytes,
      contentType: mimeType,
    });

    if (!uploadResult.success) {
      await sb
        .from('conversation_attachments')
        .update({ status: 'failed', error_message: (uploadResult.error || 'upload_failed').slice(0, 200) })
        .eq('id', (row as any).id);
      throw new Error(uploadResult.error || 'upload_failed');
    }

    await sb
      .from('conversation_attachments')
      .update({ status: 'uploaded', finalized_at: new Date().toISOString() })
      .eq('id', (row as any).id);

    return {
      fileId: input.fileId,
      kind: input.kind,
      status: 'stored',
      attachmentId: (row as any).id,
      fileName,
      mimeType,
      sizeBytes: input.bytes.byteLength,
    };
  } catch (err) {
    const reason = redactToken(err instanceof Error ? err.message : String(err)).slice(0, 200);
    console.warn('[telegram-media] attachment rejected:', reason);
    return { fileId: input.fileId, kind: input.kind, status: 'failed', error: reason };
  }
}

/**
 * Merges the worker's outcomes into the message metadata, replacing the
 * `pending` placeholders written when the fetch was queued.
 */
export async function recordMediaOutcomes(
  config: ServerConfig,
  messageId: string,
  outcomes: TelegramMediaOutcome[],
): Promise<void> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversation_messages')
    .select('id, metadata')
    .eq('id', messageId)
    .maybeSingle();
  if (!data) return;

  const metadata = { ...(((data as any).metadata ?? {}) as Record<string, unknown>) };
  const previous: TelegramMediaOutcome[] = Array.isArray((metadata as any).attachments)
    ? ((metadata as any).attachments as TelegramMediaOutcome[])
    : [];
  const byFileId = new Map(previous.map((item) => [item.fileId, item]));
  for (const outcome of outcomes) byFileId.set(outcome.fileId, outcome);
  metadata.attachments = Array.from(byFileId.values());

  await sb.from('conversation_messages').update({ metadata }).eq('id', messageId);
}

/** Persists a contact avatar delivered by the worker. Never throws. */
export async function persistContactAvatar(
  config: ServerConfig,
  input: { workspaceId: string; contactId: string; fileKeyHint: string; bytes: Buffer },
): Promise<void> {
  try {
    if (input.bytes.byteLength > MAX_AVATAR_BYTES) return;
    const sb = getServiceClient(config);
    const { data: contact } = await sb
      .from('contacts')
      .select('id, metadata')
      .eq('id', input.contactId)
      .maybeSingle();
    if (!contact) return;

    const fileKey = `workspace/${input.workspaceId}/avatars/telegram/${input.fileKeyHint}.jpg`;
    const uploaded = await uploadFile(config, {
      workspaceId: input.workspaceId,
      fileKey,
      data: input.bytes,
      contentType: 'image/jpeg',
    });
    if (!uploaded.success) return;

    const storageConfig = await resolveStorageConfig(config, input.workspaceId);
    const url = uploaded.url || (storageConfig ? getFileUrlWithConfig(storageConfig, fileKey) : null);
    if (!url) return;

    await sb
      .from('contacts')
      .update({
        avatar_url: url,
        metadata: {
          ...((contact as any).metadata || {}),
          avatar_source: 'telegram',
          avatar_synced_at: new Date().toISOString(),
        },
      })
      .eq('id', input.contactId);
  } catch (err) {
    console.warn('[telegram-avatar] persist skipped:', redactToken(err instanceof Error ? err.message : String(err)));
  }
}
