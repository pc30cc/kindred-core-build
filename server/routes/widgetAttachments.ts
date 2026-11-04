/**
 * Phase 6a — Widget attachment endpoints (visitor-facing)
 *
 * All routes require:
 *   - X-Widget-Token (HMAC widget session token)
 *   - HttpOnly visitor cookie (dvsid) for identity
 *
 * STORAGE ENFORCEMENT (non-negotiable):
 *   - storage_provider is resolved server-side via resolveStorageConfig()
 *   - storage_path is built server-side (via the central chatAttachmentKey()
 *     builder, server/services/storage/keys.ts), NEVER from client input
 *   - Path format is enforced both by the builder AND by a CHECK constraint
 *     in SQL requiring the `workspace/{workspace_id}/attachments/%` prefix:
 *       workspace/{workspace_id}/attachments/chat/{yyyy}/{mm}/{uuid}-{safeFileName}
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
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { widgetPlanDenied, WIDGET_PLAN_ATTACHMENTS, WIDGET_PLAN_CHAT, WIDGET_PLAN_VOICE_NOTES } from '../services/widget/planGate.js';
import {
  enforceWidgetToken,
  enforceOrigin,
  widgetRateLimit,
  resolveWorkspaceId,
  verifyConversationOwnership,
} from '../services/widget/security.js';
import { uploadFile, downloadFile, resolveStorageConfig } from '../services/storage/index.js';
import { chatAttachmentKey } from '../services/storage/keys.js';
import { requireLimit } from '../middleware/featureGating.js';
import { setTrustedGateWorkspaceId } from '../middleware/gateWorkspace.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';
import { visitorSystemPreview, type VisitorSystemPreview } from '../../shared/systemMessages.js';
import { isResolveClosedLine } from '../services/widget/visitorConversations.js';
import { readVisitorCookie } from '../services/widget/visitorIdentity.js';
import { isMissingColumnError } from '../lib/missingColumn.js';

export const widgetAttachmentsRouter = Router();

/** ServerConfig attached to every request by the app bootstrap middleware. */
function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

/**
 * The visitor who uploaded a widget file (migration 301): the signed visitor
 * of /init. A file no conversation holds yet (status `uploading` or
 * `uploaded`) is only that visitor's, to upload into, to attach to their
 * message and to download (audit widgetapi-5, 2026-11-04). Before it, any
 * widget token of the workspace could do all three with a file's id,
 * operators' team-chat files (conversation_id NULL) included.
 */
const UPLOADER_COLUMN = 'uploaded_by_visitor_id';

/** The request's signed visitor in `workspaceId` (dvsid cookie or visitor credential), or null. */
function signedVisitorOf(req: Request, workspaceId: string): string | null {
  try {
    return readVisitorCookie(req, workspaceId)?.v || null;
  } catch {
    return null;
  }
}

interface UploaderRow {
  uploaded_by_type?: string | null;
  uploaded_by_visitor_id?: string | null;
}

/**
 * Whether `visitorId` uploaded this row through the widget. On a database
 * without migration 301 yet (`legacy`: RESPOK's migrator runs with the
 * deploy) the uploader is unknown, and `legacyAllowed` decides: a visitor's
 * upload then passes as it did before, never an operator's file.
 */
export function isVisitorsOwnUpload(
  row: UploaderRow,
  visitorId: string | null,
  legacy = false,
  legacyAllowed = false,
): boolean {
  if (!visitorId || row.uploaded_by_type !== 'visitor') return false;
  if (legacy) return legacyAllowed;
  return !!row.uploaded_by_visitor_id && row.uploaded_by_visitor_id === visitorId;
}

/**
 * One attachment row with the uploader column, or (before 301) without it:
 * `legacy` says the column is not there yet.
 */
async function readAttachmentRow<T>(
  config: ServerConfig,
  attachmentId: string,
  columns: string,
): Promise<{ row: (T & UploaderRow) | null; legacy: boolean }> {
  const sb = getServiceClient(config);
  const first = await sb
    .from('conversation_attachments')
    .select(`${columns}, uploaded_by_type, ${UPLOADER_COLUMN}`)
    .eq('id', attachmentId)
    .maybeSingle();
  if (!first.error) return { row: (first.data as unknown as (T & UploaderRow) | null) ?? null, legacy: false };
  if (!isMissingColumnError(first.error, [UPLOADER_COLUMN])) return { row: null, legacy: false };
  const second = await sb
    .from('conversation_attachments')
    .select(`${columns}, uploaded_by_type`)
    .eq('id', attachmentId)
    .maybeSingle();
  return { row: (second.data as unknown as (T & UploaderRow) | null) ?? null, legacy: true };
}

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
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  if (stripped) return stripped;
  const ext = EXT_BY_MIME[mime] || 'bin';
  return `file.${ext}`;
}

/**
 * Build the canonical workspace-scoped storage path via the central
 * chatAttachmentKey() builder (server/services/storage/keys.ts) — this
 * route's own MIME-based safeFileName() fallback above is preserved and
 * fed into the builder. Backend-only. Client never picks any part of
 * this path.
 */
function buildStoragePath(workspaceId: string, fileName: string, mime: string): string {
  return chatAttachmentKey({ workspaceId, fileName: safeFileName(fileName, mime) });
}

async function loadWorkspaceAttachmentSettings(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  // The workspace's own switches, and what its plan allows (the raw columns
  // survive a downgrade; /config hides the controls, this refuses them).
  const [{ data }, denied] = await Promise.all([
    sb
      .from('widget_settings')
      .select('attachments_enabled, attachments_max_size_mb, attachments_allowed_mimes, voice_notes_enabled, enabled, chat_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    widgetPlanDenied(config, workspaceId, [WIDGET_PLAN_CHAT, WIDGET_PLAN_ATTACHMENTS, WIDGET_PLAN_VOICE_NOTES]),
  ]);
  return {
    widgetEnabled: data?.enabled !== false,
    chatEnabled: data?.chat_enabled !== false && !denied.has(WIDGET_PLAN_CHAT),
    enabled: !!data?.attachments_enabled && !denied.has(WIDGET_PLAN_ATTACHMENTS),
    voiceEnabled: !!data?.voice_notes_enabled && !denied.has(WIDGET_PLAN_VOICE_NOTES),
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
  const config = serverConfigOf(req);
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

  // The file is the signed visitor's (see UPLOADER_COLUMN): a request
  // without one could never attach or read it back.
  const visitorId = signedVisitorOf(req, workspaceId);
  if (!visitorId) return res.status(401).json({ error: 'Visitor identity required', code: 'VISITOR_REQUIRED' });

  // If conversation_id is provided, verify ownership (by the signed visitor
  // alone: a body visitor_id / session_id names nobody). If invalid, drop it
  // (we'll attach to a freshly created conversation when /message is sent).
  let convId: string | null = null;
  if (data.conversation_id) {
    const ownership = await verifyConversationOwnership(
      config, data.conversation_id, workspaceId, null, null, req
    );
    if (ownership.valid) convId = data.conversation_id;
  }

  // Resolve provider name (server-side only)
  const sb = getServiceClient(config);
  // We don't expose the provider; we just need to know its name to record it,
  // resolved the way the upload resolves it (which then records the one it used).
  const providerName = (await resolveStorageConfig(config, workspaceId))?.provider || 'local';

  const storagePath = buildStoragePath(workspaceId, data.file_name, data.mime_type);

  // The visitor's own session only: a body session_id names nobody.
  let ownSessionId: string | null = null;
  if (data.session_id) {
    const { data: ownSession } = await sb
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .eq('id', data.session_id)
      .maybeSingle();
    ownSessionId = (ownSession?.id as string | undefined) ?? null;
  }
  const insertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    conversation_id: convId,
    storage_provider: providerName,
    storage_path: storagePath,
    file_name: safeFileName(data.file_name, data.mime_type),
    mime_type: data.mime_type,
    size_bytes: data.size_bytes,
    uploaded_by_type: 'visitor',
    uploaded_by_id: null,
    visitor_session_id: ownSessionId,
    status: 'uploading',
    [UPLOADER_COLUMN]: visitorId,
  };
  const insertAttachment = (values: Record<string, unknown>) => sb
    .from('conversation_attachments')
    .insert(values)
    .select('id, storage_path, mime_type, size_bytes, file_name')
    .single();
  let { data: row, error } = await insertAttachment(insertRow);
  if (error && isMissingColumnError(error, [UPLOADER_COLUMN])) {
    // Before migration 301: the row as it was written before.
    const { [UPLOADER_COLUMN]: _uploader, ...legacyRow } = insertRow;
    ({ data: row, error } = await insertAttachment(legacyRow));
  }

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
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

  const sb = getServiceClient(config);
  const { row, legacy } = await readAttachmentRow<{
    id: string; workspace_id: string; storage_path: string; storage_provider: string;
    mime_type: string; size_bytes: number; status: string;
  }>(config, String(req.params.id), 'id, workspace_id, storage_path, storage_provider, mime_type, size_bytes, status');

  if (!row) return res.status(404).json({ error: 'Attachment not found' });
  if (row.workspace_id !== workspaceId) return res.status(403).json({ error: 'Forbidden' });
  // Only the visitor who reserved it writes its bytes.
  if (!isVisitorsOwnUpload(row, signedVisitorOf(req, workspaceId), legacy, true)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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

  // ── storage_mb cap enforcement (visitor-facing) ──
  // Mirrors the operator upload routes; see docs/STORAGE_LIMIT_POLICY.md.
  // workspace_id is the server-resolved one from the validated widget token
  // (X-Widget-Token + cookie). It is pinned on the request so the shared
  // gate evaluates it and ignores any workspaceId/workspace_id the visitor
  // put in the body (the schema is {data: base64} and never carries one).
  // Forward-correct only; no route-local storage math.
  setTrustedGateWorkspaceId(req, workspaceId);
  const limitMw = requireLimit('storage_mb', usageFnForLimit('storage_mb'));
  let proceeded = false;
  await limitMw(req, res, () => { proceeded = true; });
  if (!proceeded) {
    // Cap reached: middleware already wrote a 403. Mark the reserved row
    // failed so the visitor's widget doesn't see a stranded 'uploading'
    // attachment row, and so /init's reserved slot is released.
    await sb.from('conversation_attachments')
      .update({ status: 'failed', error_message: 'storage_mb limit reached' })
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
      .update({
        status: 'uploaded',
        finalized_at: new Date().toISOString(),
        ...(result.provider ? { storage_provider: result.provider } : {}),
      })
      .eq('id', row.id);

    return res.json({ attachment_id: row.id, status: 'uploaded' });
  } catch (err: unknown) {
    const errMsg = (err as { message?: string } | null | undefined)?.message;
    await sb.from('conversation_attachments')
      .update({ status: 'failed', error_message: errMsg?.slice(0, 200) || 'Upload exception' })
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
  const config = serverConfigOf(req);
  const workspaceId = resolveWorkspaceId(req, res);
  if (res.headersSent) return;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  const { row, legacy } = await readAttachmentRow<{
    id: string; workspace_id: string; conversation_id: string | null; storage_path: string;
    mime_type: string; file_name: string; status: string;
  }>(config, String(req.params.id), 'id, workspace_id, conversation_id, storage_path, mime_type, file_name, status');

  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.workspace_id !== workspaceId) return res.status(403).json({ error: 'Forbidden' });
  if (row.status !== 'uploaded' && row.status !== 'attached') {
    return res.status(404).json({ error: 'Attachment not available' });
  }

  if (row.conversation_id) {
    // Bound to a conversation: the signed visitor must own it (a query
    // visitor_id / session_id names nobody).
    const ownership = await verifyConversationOwnership(
      config, row.conversation_id, workspaceId, null, null, req
    );
    if (!ownership.valid) return res.status(403).json({ error: 'Forbidden' });
  } else if (!isVisitorsOwnUpload(row, signedVisitorOf(req, workspaceId), legacy, false)) {
    // Bound to nothing: only its uploader's (never an operator's team-chat
    // file). The widget never reads its own file back before sending it, so
    // without migration 301 nobody's is served.
    return res.status(403).json({ error: 'Forbidden' });
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

/** Reads `metadata.attachment_id` off an untyped message metadata blob. */
function metadataAttachmentId(metadata: unknown): unknown {
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).attachment_id
    : undefined;
}

export async function enrichMessagesWithAttachments<T extends { id?: string; metadata?: unknown }>(
  config: ServerConfig,
  workspaceId: string,
  messages: T[],
  /**
   * The one conversation all of `messages` belong to, when the caller knows
   * it (the widget's reads): a file is then described only when it is bound
   * to that conversation, so a visitor's message naming another file's id
   * (POST /message stores the id it is given) never shows its name, type
   * and size (audit widgetapi-5).
   */
  opts?: { conversationId?: string | null },
): Promise<Array<T | (T & { attachment: PublicAttachmentMeta })>> {
  const scopeConversationId = opts?.conversationId || null;
  const inScope = (r: { conversation_id?: string | null }) => !scopeConversationId || r.conversation_id === scopeConversationId;
  if (!messages || messages.length === 0) return messages || [];

  const idsFromMeta = new Set<string>();
  const messageIds = new Set<string>();
  for (const m of messages) {
    const aid = metadataAttachmentId(m?.metadata);
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
      .select('id, file_name, mime_type, size_bytes, message_id, status, workspace_id, conversation_id')
      .in('id', Array.from(idsFromMeta))
      .eq('workspace_id', workspaceId);
    for (const r of (data || [])) {
      if (r.status !== 'attached' && r.status !== 'uploaded') continue;
      if (!inScope(r)) continue;
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
      .select('id, file_name, mime_type, size_bytes, message_id, status, workspace_id, conversation_id')
      .in('message_id', Array.from(messageIds))
      .eq('workspace_id', workspaceId)
      .eq('status', 'attached');
    for (const r of (data || [])) {
      if (!r.message_id || byMsgId[r.message_id]) continue;
      if (!inScope(r)) continue;
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
    const aid = metadataAttachmentId(m?.metadata);
    let att: PublicAttachmentMeta | undefined;
    if (typeof aid === 'string' && byAttId[aid]) att = byAttId[aid];
    else if (typeof m.id === 'string' && byMsgId[m.id]) att = byMsgId[m.id];
    if (!att) return m;
    return { ...m, attachment: att };
  });
}

/**
 * Canonical visitor-message-visibility predicate — the ONE place that
 * decides whether a message's metadata marks it as something a visitor
 * must never see: internal staffing/assignment/system notices, written with
 * `metadata.internal === true` (see server/routes/conversations.ts's
 * transfer notice), and the closed line an older server wrote on "Resolve"
 * (isResolveClosedLine: resolved is live for the visitor, 2026-10-24). Every
 * accessor that might expose a message (or a preview of one) to the widget —
 * enrichMessagesWithSender's /poll+/history filter, /identity/history, the
 * conversation list, and enrichMessagesWithReplyTo below — shares this one
 * rule instead of maintaining independent copies that can drift.
 */
export function isVisitorVisibleMessageMeta(metadata: unknown): boolean {
  const meta = (metadata && typeof metadata === 'object') ? metadata as Record<string, unknown> : null;
  return !(meta && (meta.internal === true || isResolveClosedLine(meta)));
}

/**
 * Filters a full message LIST down to visitor-visible ones, built on
 * isVisitorVisibleMessageMeta above. This is the counterpart for an array
 * of message objects (each carrying its own `metadata`) — the ONE place
 * every read path that returns a message list to the widget applies the
 * rule, so it does not matter whether that path also happens to run
 * sender-profile enrichment (enrichMessagesWithSender uses this too) or
 * not (GET /identity/history has no sender enrichment step at all, and
 * must still get the same visibility guarantee from calling this directly).
 */
export function filterVisitorVisibleMessages<T extends { metadata?: unknown }>(messages: T[]): T[] {
  if (!messages || !messages.length) return messages || [];
  return messages.filter((m) => isVisitorVisibleMessageMeta(m?.metadata));
}

/**
 * Attach a resolved reply-to preview to every message carrying a
 * `reply_to_message_id`, in ONE batch query — not one lookup per message.
 * Shared by POST /message (the send response + realtime envelope), GET
 * /poll, GET /history, and GET /identity/history so the structured reply
 * relationship travels the same way through every read path a message can
 * reach the widget through, matching the `enrichMessagesWithAttachments`
 * pipeline style above.
 *
 * `conversationId` is the caller's ALREADY-KNOWN, already-authorized
 * conversation id (every call site queries a single conversation) — not
 * something read off the client messages, and never round-tripped back to
 * the browser. `reply_to_message_id` self-references `conversation_messages`
 * but the database does NOT enforce that a parent lives in the same
 * conversation, so this is defense in depth: a parent is only ever attached
 * when `parent.conversation_id === conversationId`.
 *
 * A parent is sanitized to "no reply, indistinguishable from having none"
 * in THREE cases — NOT just `reply_to` (the body-carrying preview), but
 * also the public `reply_to_message_id` field is nulled out, so a visitor
 * can never use "the id is present but the preview is null" as an oracle
 * for "something I can't see exists here":
 *   - it no longer resolves at all (deleted — reply_to_message_id is
 *     `ON DELETE SET NULL`, but a narrow race window exists between the
 *     parent row disappearing and the FK actually nulling out)
 *   - it resolves but belongs to a DIFFERENT conversation (should be
 *     unreachable given the FK + this helper's own callers, but never
 *     trusted blindly)
 *   - it resolves in the same conversation but fails the canonical
 *     visitor-visibility check (an internal staffing/system notice) — its
 *     body must never reach `reply_to.text`, and its id must not leak via
 *     `reply_to_message_id` either
 *   - it is a system row the widget cannot write as a sentence (an
 *     unknown kind: visitorReplyPreview below)
 * The true FK is whatever the DB row already had before this function ran
 * (untouched at the database level — this only sanitizes the copy that
 * goes out over the wire to the widget).
 */
export type ReplyToPreview = {
  id: string;
  text: string;
  sender_type: string;
  /** A system parent's kind and the names its sentence needs; the widget writes it in the visitor's language. */
  kind?: VisitorSystemPreview['kind'];
  meta?: VisitorSystemPreview['meta'];
};

/**
 * The quote of a parent as the visitor gets it, or null when it must look
 * like no reply at all. A system row ("Your message is in the support
 * queue.") is quoted as its kind (shared/systemMessages.ts
 * visitorSystemPreview), from which the widget writes the sentence in the
 * visitor's language, as the thread does; one it cannot write is not
 * quoted. `text` stays the stored body for a runtime loaded before `kind`.
 * Shared by enrichMessagesWithReplyTo and POST /message (widget.ts).
 */
export function visitorReplyPreview(parent: { id: string; body: string | null; sender_type: string; metadata: unknown }): ReplyToPreview | null {
  if (!isVisitorVisibleMessageMeta(parent.metadata)) return null;
  const preview: ReplyToPreview = { id: parent.id, text: parent.body ?? '', sender_type: parent.sender_type };
  if (parent.sender_type !== 'system') return preview;
  const system = visitorSystemPreview(parent.metadata);
  return system ? { ...preview, kind: system.kind, meta: system.meta } : null;
}

/** Any widget message shape carrying an optional reply-to FK. */
type ReplyEnrichableMessage = { reply_to_message_id?: string | null; [k: string]: unknown };

/** Parent row as selected by enrichMessagesWithReplyTo. */
interface ReplyParentRow {
  id: string;
  conversation_id: string;
  body: string | null;
  sender_type: string;
  metadata: unknown;
}

export async function enrichMessagesWithReplyTo(
  config: ServerConfig,
  conversationId: string,
  messages: ReplyEnrichableMessage[],
): Promise<Array<ReplyEnrichableMessage & { reply_to?: ReplyToPreview | null }>> {
  if (!messages || messages.length === 0) return messages || [];
  const replyIds = Array.from(new Set(
    messages
      .map((m) => m.reply_to_message_id)
      .filter((id): id is string => typeof id === 'string' && !!id),
  ));
  if (!replyIds.length) return messages;

  const sb = getServiceClient(config);
  const parentMap: Record<string, ReplyToPreview> = {};
  try {
    const { data } = await sb
      .from('conversation_messages')
      .select('id, conversation_id, body, sender_type, metadata')
      .in('id', replyIds);
    for (const p of (data || []) as ReplyParentRow[]) {
      if (p.conversation_id !== conversationId) continue; // defense in depth — see doc comment above
      // An internal notice or a system row the widget cannot write — never preview its body.
      const preview = visitorReplyPreview(p);
      if (preview) parentMap[p.id] = preview;
    }
  } catch (e: unknown) {
    console.warn('[widget-reply-enrich] parent lookup failed:', (e as { message?: string } | null | undefined)?.message || e);
  }

  return messages.map((m) => {
    if (!m.reply_to_message_id) return m;
    const parent = parentMap[m.reply_to_message_id];
    // No visible, same-conversation parent → the public shape must be
    // identical to "this message never had a reply target": null the id
    // too, not just the preview, so its presence can never be used to
    // infer that a hidden/foreign message exists.
    if (!parent) return { ...m, reply_to_message_id: null, reply_to: null };
    return { ...m, reply_to: parent };
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
  /**
   * A visitor's message (POST /message): the file must be this signed
   * visitor's own upload (see UPLOADER_COLUMN), never another visitor's or
   * an operator's. Omitted for an operator's reply (routes/conversations.ts).
   */
  visitor?: { visitorId: string | null },
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { row, legacy } = await readAttachmentRow<{ id: string; workspace_id: string; status: string }>(
    config, attachmentId, 'id, workspace_id, status',
  );

  if (!row || row.workspace_id !== workspaceId) return false;
  if (row.status !== 'uploaded') return false;
  if (visitor && !isVisitorsOwnUpload(row, visitor.visitorId, legacy, true)) return false;

  const { error } = await sb
    .from('conversation_attachments')
    .update({
      conversation_id: conversationId,
      message_id: messageId,
      status: 'attached',
    })
    .eq('id', attachmentId)
    .eq('status', 'uploaded');

  return !error;
}
