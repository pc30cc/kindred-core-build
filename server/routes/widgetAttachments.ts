/**
 * Phase 6a — Widget attachment endpoints (visitor-facing)
 *
 * All routes require:
 *   - X-Widget-Token (HMAC widget session token)
 *   - HttpOnly visitor cookie (dvsid) for identity
 *
 * STORAGE ENFORCEMENT (non-negotiable):
 *   - storage_provider is resolved server-side via resolveStorageConfig()
 *   - storage_path is built server-side, NEVER from client input
 *   - Path format is enforced both in code AND by a CHECK constraint in SQL:
 *       workspace/{workspace_id}/attachments/{yyyy}/{mm}/{uuid}-{safeFileName}
 *   - workspace_id is the server-resolved one (from token), not client-provided
 *
 * SECURITY:
 *   - Uploader is always uploaded_by_type='visitor'; uploaded_by_id is null
 *     because widget visitors are not Supabase users.
 *   - Conversation ownership is re-verified on attach + on download.
 *   - Allowed MIME types are workspace-configured AND globally bounded.
 *   - Max size is workspace-configured AND globally bounded.
 *   - GET /attachments/:id streams via provider; provider URLs are never
 *     returned to the client.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  enforceWidgetToken,
  enforceOrigin,
  widgetRateLimit,
  resolveWorkspaceId,
  verifyConversationOwnership,
} from '../services/widget/security.js';
import { uploadFile, downloadFile } from '../services/storage/index.js';
import { requireLimit } from '../middleware/featureGating.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';

export const widgetAttachmentsRouter = Router();

// Mounted BEFORE the parent widgetRouter's own enforceWidgetToken/
// enforceOrigin (see server/routes/widget.ts), so — like /identity,
// /callback, /departments, /call-invitations — this sub-router must enforce
// both itself. This was previously missing: each route below called
// enforceWidgetToken individually but none enforced Origin, so a stolen
// token could be replayed cross-origin against attachment upload/download.
widgetAttachmentsRouter.use(enforceWidgetToken);
widgetAttachmentsRouter.use(enforceOrigin);

// ─── Hard global bounds (regardless of workspace settings) ──────────
const HARD_MAX_BYTES = 25 * 1024 * 1024; // 25MB absolute ceiling for v1
// File attachments — gated by attachments_enabled + attachments_allowed_mimes.
const GLOBAL_ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
]);
// Voice notes — a SEPARATE toggle (voice_notes_enabled) from file
// attachments, with a fixed mime set (not admin-configurable, unlike
// attachments_allowed_mimes) — covers Chrome/Firefox (audio/webm),
// Safari (audio/mp4), and generic fallbacks.
const AUDIO_MIMES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
]);
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

// ─── Helpers ────────────────────────────────────────────────────────

function safeFileName(name: string, mime: string): string {
  const stripped = String(name || '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (stripped) return stripped;
  const ext = EXT_BY_MIME[mime] || 'bin';
  return `file.${ext}`;
}

/**
 * Build the canonical workspace-scoped storage path.
 * Backend-only. Client never picks any part of this path.
 */
function buildStoragePath(workspaceId: string, fileName: string, mime: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  const safe = safeFileName(fileName, mime);
  return `workspace/${workspaceId}/attachments/${yyyy}/${mm}/${uuid}-${safe}`;
}

async function loadWorkspaceAttachmentSettings(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('widget_settings')
    .select('attachments_enabled, attachments_max_size_mb, attachments_allowed_mimes, voice_notes_enabled, enabled, chat_enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return {
    widgetEnabled: data?.enabled !== false,
    chatEnabled: data?.chat_enabled !== false,
    enabled: !!data?.attachments_enabled,
    voiceEnabled: !!data?.voice_notes_enabled,
    maxBytes: Math.min(((data?.attachments_max_size_mb ?? 10) * 1024 * 1024), HARD_MAX_BYTES),
    allowedMimes: new Set<string>(
      (data?.attachments_allowed_mimes && Array.isArray(data.attachments_allowed_mimes)
        ? data.attachments_allowed_mimes
        : Array.from(GLOBAL_ALLOWED_MIMES))
        .filter((m: string) => GLOBAL_ALLOWED_MIMES.has(m))
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════
// POST /attachments/init
//   Validates + creates an `uploading` row. Returns attachment_id.
//   Body: { file_name, mime_type, size_bytes, conversation_id?, visitor_id?, session_id? }
// ═══════════════════════════════════════════════════════════════════
const initSchema = z.object({
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.number().int().positive().max(HARD_MAX_BYTES),
  conversation_id: z.string().uuid().nullable().optional(),
  visitor_id: z.string().min(1).max(255).optional(),
  session_id: z.string().uuid().nullable().optional(),
});

widgetAttachmentsRouter.post('/init', widgetRateLimit('upload'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = initSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors });
  }
  const data = parsed.data;
  const workspaceId = resolveWorkspaceId(req, res);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const settings = await loadWorkspaceAttachmentSettings(config, workspaceId);
  if (!settings.widgetEnabled || !settings.chatEnabled) {
    return res.status(403).json({ error: 'Widget chat not enabled' });
  }

  const isVoiceNote = AUDIO_MIMES.has(data.mime_type);
  if (isVoiceNote) {
    // Voice notes have their own toggle — independent of file attachments,
    // and not subject to the admin-configurable allowedMimes list.
    if (!settings.voiceEnabled) {
      return res.status(403).json({ error: 'Voice notes not enabled for this workspace' });
    }
  } else {
    if (!settings.enabled) {
      return res.status(403).json({ error: 'Attachments not enabled for this workspace' });
    }
    if (!settings.allowedMimes.has(data.mime_type)) {
      return res.status(415).json({ error: 'File type not allowed', mime_type: data.mime_type });
    }
  }
  if (data.size_bytes > settings.maxBytes) {
    return res.status(413).json({ error: 'File too large', max_bytes: settings.maxBytes });
  }

  // If conversation_id is provided, verify ownership. If invalid, drop it
  // (we'll attach to a freshly created conversation when /message is sent).
  let convId: string | null = null;
  if (data.conversation_id) {
    const ownership = await verifyConversationOwnership(
      config, data.conversation_id, workspaceId, data.visitor_id, data.session_id, req
    );
    if (ownership.valid) convId = data.conversation_id;
  }

  // Resolve provider name (server-side only)
  const sb = getServiceClient(config);
  // We don't expose the provider; we just need to know its name to record it.
  const { data: wsConfig } = await sb
    .from('provider_configs')
    .select('provider_name')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'storage')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let providerName = wsConfig?.provider_name as string | undefined;
  if (!providerName) {
    const { data: globalCfg } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', 'default_storage_provider')
      .maybeSingle();
    providerName = (globalCfg?.value as any)?.provider || 'local';
  }

  const storagePath = buildStoragePath(workspaceId, data.file_name, data.mime_type);

  const { data: row, error } = await sb
    .from('conversation_attachments')
    .insert({
      workspace_id: workspaceId,
      conversation_id: convId,
      storage_provider: providerName,
      storage_path: storagePath,
      file_name: safeFileName(data.file_name, data.mime_type),
      mime_type: data.mime_type,
      size_bytes: data.size_bytes,
      uploaded_by_type: 'visitor',
      uploaded_by_id: null,
      visitor_session_id: data.session_id || null,
      status: 'uploading',
    })
    .select('id, storage_path, mime_type, size_bytes, file_name')
    .single();

  if (error || !row) {
    return res.status(500).json({ error: 'Failed to create attachment record' });
  }

  return res.json({
    attachment_id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    // NOTE: storage_path is NOT returned to the client.
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /attachments/:id/upload
//   Body: { data: base64 }
//   Streams to active Storage Provider under workspace/{wsId}/attachments/...
//   Marks the row as 'uploaded' on success, 'failed' on error.
// ═══════════════════════════════════════════════════════════════════
const uploadSchema = z.object({
  data: z.string().min(1), // base64
});

widgetAttachmentsRouter.post('/:id/upload', widgetRateLimit('upload'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('conversation_attachments')
    .select('id, workspace_id, storage_path, storage_provider, mime_type, size_bytes, status')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'Attachment not found' });
  if (row.workspace_id !== workspaceId) return res.status(403).json({ error: 'Forbidden' });
  if (row.status !== 'uploading') return res.status(409).json({ error: 'Attachment not in uploading state' });

  // Defense in depth: re-verify the workspace path scope
  const expectedPrefix = `workspace/${workspaceId}/attachments/`;
  if (!row.storage_path.startsWith(expectedPrefix) || row.storage_path.includes('..')) {
    return res.status(500).json({ error: 'Invalid storage path' });
  }

  const buf = Buffer.from(parsed.data.data, 'base64');
  if (buf.length > row.size_bytes + 4) {
    // Allow a tiny base64 rounding margin only
    return res.status(413).json({ error: 'Uploaded size exceeds declared size' });
  }

  // ── storage_gb cap enforcement (visitor-facing) ──
  // Mirrors the operator upload routes; see docs/STORAGE_LIMIT_POLICY.md.
  // workspace_id is the server-resolved one from the validated widget token
  // (X-Widget-Token + cookie). We inject it into req.body so the shared
  // extractWorkspaceId() helper sees the trusted value — the body schema is
  // {data: base64} and intentionally never carried workspace_id from the
  // visitor. Forward-correct only; no route-local storage math.
  (req.body as any).workspace_id = workspaceId;
  const limitMw = requireLimit('storage_gb', usageFnForLimit('storage_gb'));
  let proceeded = false;
  await limitMw(req, res, () => { proceeded = true; });
  if (!proceeded) {
    // Cap reached: middleware already wrote a 403. Mark the reserved row
    // failed so the visitor's widget doesn't see a stranded 'uploading'
    // attachment row, and so /init's reserved slot is released.
    await sb.from('conversation_attachments')
      .update({ status: 'failed', error_message: 'storage_gb limit reached' })
      .eq('id', row.id);
    return;
  }

  try {
    const result = await uploadFile(config, {
      workspaceId,
      fileKey: row.storage_path,
      data: buf,
      contentType: row.mime_type,
    });

    if (!result.success) {
      await sb.from('conversation_attachments')
        .update({ status: 'failed', error_message: result.error || 'Upload failed' })
        .eq('id', row.id);
      return res.status(502).json({ error: result.error || 'Upload failed' });
    }

    await sb.from('conversation_attachments')
      .update({ status: 'uploaded', finalized_at: new Date().toISOString() })
      .eq('id', row.id);

    return res.json({ attachment_id: row.id, status: 'uploaded' });
  } catch (err: any) {
    await sb.from('conversation_attachments')
      .update({ status: 'failed', error_message: err.message?.slice(0, 200) || 'Upload exception' })
      .eq('id', row.id);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /attachments/:id
//   Backend proxy stream. Re-verifies workspace + conversation access,
//   then streams bytes from the active Storage Provider.
//   Provider URLs are NEVER returned to the client.
// ═══════════════════════════════════════════════════════════════════
widgetAttachmentsRouter.get('/:id', widgetRateLimit('default'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = resolveWorkspaceId(req, res);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const visitorId = (req.query.visitor_id as string) || undefined;
  const sessionId = (req.query.session_id as string) || undefined;

  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('conversation_attachments')
    .select('id, workspace_id, conversation_id, storage_path, mime_type, file_name, status')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.workspace_id !== workspaceId) return res.status(403).json({ error: 'Forbidden' });
  if (row.status !== 'uploaded' && row.status !== 'attached') {
    return res.status(404).json({ error: 'Attachment not available' });
  }

  // If the attachment is bound to a conversation, the visitor must own it.
  if (row.conversation_id) {
    const ownership = await verifyConversationOwnership(
      config, row.conversation_id, workspaceId, visitorId, sessionId, req
    );
    if (!ownership.valid) return res.status(403).json({ error: 'Forbidden' });
  }

  const dl = await downloadFile(config, workspaceId, row.storage_path);
  if (!dl.success || !dl.data) {
    return res.status(502).json({ error: dl.error || 'Provider download failed' });
  }

  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${row.file_name.replace(/"/g, '')}"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  return res.send(dl.data);
});

/**
 * Phase 6b — Enrich a list of widget message records with public-safe
 * attachment metadata. Resolves attachment ids found in:
 *   - row.metadata.attachment_id (set when /message inserted the row), OR
 *   - direct lookup by message_id on the attachments table (covers messages
 *     created by other surfaces, e.g. agent panel).
 *
 * The shape returned is intentionally minimal and provider-agnostic:
 *   { id, file_name, mime_type, size_bytes, kind: 'image'|'file' }
 *
 * NO provider URL is ever returned. The widget always loads files via the
 * proxy route GET /api/widget/attachments/:id, which re-checks ownership.
 */
export interface PublicAttachmentMeta {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: 'image' | 'audio' | 'file';
}

function classifyAttachmentKind(mimeType: string): 'image' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export async function enrichMessagesWithAttachments(
  config: ServerConfig,
  workspaceId: string,
  messages: Array<{ id?: string; metadata?: any; [k: string]: any }>,
): Promise<Array<any>> {
  if (!messages || messages.length === 0) return messages || [];

  const idsFromMeta = new Set<string>();
  const messageIds = new Set<string>();
  for (const m of messages) {
    const aid = m?.metadata?.attachment_id;
    if (typeof aid === 'string' && aid) idsFromMeta.add(aid);
    if (typeof m.id === 'string' && m.id) messageIds.add(m.id);
  }
  if (idsFromMeta.size === 0 && messageIds.size === 0) return messages;

  const sb = getServiceClient(config);
  const byAttId: Record<string, PublicAttachmentMeta> = {};
  const byMsgId: Record<string, PublicAttachmentMeta> = {};

  // Lookup by attachment id (from metadata)
  if (idsFromMeta.size > 0) {
    const { data } = await sb
      .from('conversation_attachments')
      .select('id, file_name, mime_type, size_bytes, message_id, status, workspace_id')
      .in('id', Array.from(idsFromMeta))
      .eq('workspace_id', workspaceId);
    for (const r of (data || [])) {
      if (r.status !== 'attached' && r.status !== 'uploaded') continue;
      const meta: PublicAttachmentMeta = {
        id: r.id,
        file_name: r.file_name,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        kind: classifyAttachmentKind(r.mime_type),
      };
      byAttId[r.id] = meta;
      if (r.message_id) byMsgId[r.message_id] = meta;
    }
  }

  // Lookup by message_id (covers cases where metadata didn't carry it)
  if (messageIds.size > 0) {
    const { data } = await sb
      .from('conversation_attachments')
      .select('id, file_name, mime_type, size_bytes, message_id, status, workspace_id')
      .in('message_id', Array.from(messageIds))
      .eq('workspace_id', workspaceId)
      .eq('status', 'attached');
    for (const r of (data || [])) {
      if (!r.message_id || byMsgId[r.message_id]) continue;
      byMsgId[r.message_id] = {
        id: r.id,
        file_name: r.file_name,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        kind: classifyAttachmentKind(r.mime_type),
      };
    }
  }

  return messages.map((m) => {
    const aid = m?.metadata?.attachment_id;
    let att: PublicAttachmentMeta | undefined;
    if (typeof aid === 'string' && byAttId[aid]) att = byAttId[aid];
    else if (typeof m.id === 'string' && byMsgId[m.id]) att = byMsgId[m.id];
    if (!att) return m;
    return { ...m, attachment: att };
  });
}

/**
 * Helper used by POST /message to attach an uploaded file to a message.
 * Exposed here so widget.ts can call it without duplicating logic.
 */
export async function attachUploadedFileToMessage(
  config: ServerConfig,
  attachmentId: string,
  workspaceId: string,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('conversation_attachments')
    .select('id, workspace_id, status')
    .eq('id', attachmentId)
    .maybeSingle();

  if (!row || row.workspace_id !== workspaceId) return false;
  if (row.status !== 'uploaded') return false;

  const { error } = await sb
    .from('conversation_attachments')
    .update({
      conversation_id: conversationId,
      message_id: messageId,
      status: 'attached',
    })
    .eq('id', attachmentId);

  return !error;
}
