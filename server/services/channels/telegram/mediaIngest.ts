/**
 * Real inbound Telegram media persistence.
 *
 * Runs AFTER the canonical `conversation_messages` row exists. Downloads
 * each Telegram attachment via the Bot API, validates it against the same
 * size/mime rules and storage_gb entitlement enforced by the widget and
 * operator attachment routes, and persists it through the SAME in-process
 * storage service — never via HTTP calls back into our own API.
 *
 * Hard rule: nothing derived from the bot token (the token itself, or an
 * api.telegram.org URL containing it) may ever reach a database row, a log
 * line, or the resulting attachment. Only the bot-agnostic `file_id` from
 * the provider update is allowed in message metadata.
 *
 * Failures here are NON-FATAL — a media problem must never lose the
 * already-inserted text message. Callers get a redacted failure summary to
 * attach to message metadata / logs instead of an exception.
 */

import crypto from 'crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { readPluginSecret, TELEGRAM_BOT_TOKEN_KEY } from '../../plugins/secrets.js';
import { getIntegrationById } from '../integrations.js';
import { getFile, downloadFile, redactToken } from './client.js';
import { uploadFile, resolveStorageConfig } from '../../storage/index.js';
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
  status: 'stored' | 'failed';
  attachmentId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Redacted — safe to persist in message metadata / logs. */
  error?: string;
};

// ─── Hard bounds — mirrors conversationAttachments.ts / widgetAttachments.ts ──
const HARD_MAX_BYTES = 25 * 1024 * 1024; // 25MB absolute ceiling, same as visitor/operator uploads

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

function resolveMimeType(att: TelegramInboundAttachment, filePath: string): string {
  if (att.mimeType) return att.mimeType.toLowerCase();
  if (att.kind === 'photo') return 'image/jpeg';
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
 * Enforces the same storage_gb entitlement as the HTTP upload routes by
 * calling the shared `requireLimit` middleware in-process with a minimal
 * fake req/res. No route-local storage math — see docs/STORAGE_LIMIT_POLICY.md.
 */
async function checkStorageQuota(config: ServerConfig, workspaceId: string): Promise<{ allowed: boolean; reason?: string }> {
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
 * Downloads and persists every inbound Telegram attachment. Never throws —
 * per-attachment failures are reported in the returned array so the caller
 * can record a redacted summary without losing the text message.
 */
export async function ingestTelegramMedia(
  config: ServerConfig,
  input: TelegramMediaIngestInput,
): Promise<TelegramMediaOutcome[]> {
  const outcomes: TelegramMediaOutcome[] = [];
  if (!input.attachments.length) return outcomes;

  const sb = getServiceClient(config);

  let botToken: string | null = null;
  try {
    const integration = await getIntegrationById(config, input.integrationId);
    if (!integration) throw new Error('integration_not_found');
    botToken = await readPluginSecret(config, integration.installation_id, TELEGRAM_BOT_TOKEN_KEY);
    if (!botToken) throw new Error('bot_token_not_configured');
  } catch (err) {
    const reason = redactToken(err instanceof Error ? err.message : String(err));
    for (const att of input.attachments) {
      outcomes.push({ fileId: att.fileId, kind: att.kind, status: 'failed', error: reason });
    }
    console.warn('[telegram-media] token resolution failed:', reason);
    return outcomes;
  }

  for (const att of input.attachments) {
    try {
      // 1. Declared size pre-check (before spending a download) — never
      //    trust it alone, but reject obviously-oversized media early.
      if (typeof att.size === 'number' && att.size > HARD_MAX_BYTES) {
        throw new Error('file_too_large');
      }

      // 2. Resolve the real file path (still no credentials leave this fn).
      const fileInfo = await getFile(botToken, att.fileId);
      if (typeof fileInfo.file_size === 'number' && fileInfo.file_size > HARD_MAX_BYTES) {
        throw new Error('file_too_large');
      }
      if (!fileInfo.file_path) throw new Error('file_path_missing');

      const mimeType = resolveMimeType(att, fileInfo.file_path);
      if (!ALLOWED_MIMES.has(mimeType)) {
        throw new Error(`mime_type_not_allowed:${mimeType}`);
      }

      // 3. Download bytes (hard-capped again inside downloadFile itself).
      const bytes = await downloadFile(botToken, fileInfo.file_path, HARD_MAX_BYTES);
      if (bytes.byteLength > HARD_MAX_BYTES) throw new Error('file_too_large');

      // 4. Same storage_gb entitlement gate as the HTTP upload routes.
      const quota = await checkStorageQuota(config, input.workspaceId);
      if (!quota.allowed) throw new Error(quota.reason || 'storage_gb_limit_reached');

      const fileName = safeFileName(
        att.fileName || fileInfo.file_path.split('/').pop() || `telegram-${att.kind}`,
        mimeType,
      );
      const storagePath = buildStoragePath(input.workspaceId, fileName, mimeType);

      // Resolve the provider name for record-keeping — same lookup the
      // widget/operator init routes do — the storage service resolves it
      // again internally at upload time.
      const storageConfig = await resolveStorageConfig(config, input.workspaceId);
      const providerName = storageConfig?.provider || 'local';

      // 5. Reserve the canonical row exactly like the widget/operator path.
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
          size_bytes: bytes.byteLength,
          uploaded_by_type: 'contact',
          uploaded_by_id: null,
          status: 'uploading',
        })
        .select('id')
        .single();
      if (insertError || !row) throw new Error('attachment_row_insert_failed');

      // 6. Persist through the SAME in-process storage pipeline.
      const uploadResult = await uploadFile(config, {
        workspaceId: input.workspaceId,
        fileKey: storagePath,
        data: Buffer.from(bytes),
        contentType: mimeType,
      });

      if (!uploadResult.success) {
        await sb.from('conversation_attachments')
          .update({ status: 'failed', error_message: (uploadResult.error || 'upload_failed').slice(0, 200) })
          .eq('id', (row as any).id);
        throw new Error(uploadResult.error || 'upload_failed');
      }

      await sb.from('conversation_attachments')
        .update({
          status: 'uploaded',
          finalized_at: new Date().toISOString(),
        })
        .eq('id', (row as any).id);

      outcomes.push({
        fileId: att.fileId,
        kind: att.kind,
        status: 'stored',
        attachmentId: (row as any).id,
        fileName,
        mimeType,
        sizeBytes: bytes.byteLength,
      });
    } catch (err) {
      const reason = redactToken(err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.warn('[telegram-media] attachment ingest failed:', reason);
      outcomes.push({ fileId: att.fileId, kind: att.kind, status: 'failed', error: reason });
    }
  }

  return outcomes;
}
