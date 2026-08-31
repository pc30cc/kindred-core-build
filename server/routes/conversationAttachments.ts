/**
 * Phase 2 — Operator attachment endpoints (Inbox-facing)
 *
 * Mirrors the widget attachment contract but with operator-grade auth:
 *   - Identity = first-party session cookie (server/lib/workspaceAuth.ts)
 *   - Workspace membership re-verified per call
 *
 * Storage path scope is server-built and identical to the visitor flow:
 *   workspace/{workspace_id}/attachments/{yyyy}/{mm}/{uuid}-{safeFileName}
 *
 * The same `conversation_attachments` table is reused. The only difference:
 *   uploaded_by_type = 'agent'
 *   uploaded_by_id   = auth user id
 *
 * Routes:
 *   POST   /api/conversation-attachments/init       → reserve row + path
 *   POST   /api/conversation-attachments/:id/upload → stream bytes via storage
 *   DELETE /api/conversation-attachments/:id        → admin/owner only
 *
 * Attaching to a message happens via POST /api/conversations/send-message
 * by passing `attachment_id` (handled there).
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { uploadFile, downloadFileRange } from '../services/storage/index.js';
import { requireLimit } from '../middleware/featureGating.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const conversationAttachmentsRouter = Router();

// ─── Hard global bounds (mirrors widgetAttachments.ts) ──────────
const HARD_MAX_BYTES = 25 * 1024 * 1024;
const GLOBAL_ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
]);
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt',
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

function buildStoragePath(workspaceId: string, fileName: string, mime: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  return `workspace/${workspaceId}/attachments/${yyyy}/${mm}/${uuid}-${safeFileName(fileName, mime)}`;
}

/** Authenticate caller as a workspace member. Sends 401/403 on failure. */
async function authorizeMember(
  req: any, res: any, _config: ServerConfig, workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

// ═══════════════════════════════════════════════════════════════════
// POST /init  — reserve attachment row, return id
// Body: { workspace_id, conversation_id?, file_name, mime_type, size_bytes }
// ═══════════════════════════════════════════════════════════════════
const initSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable().optional(),
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.number().int().positive().max(HARD_MAX_BYTES),
});

conversationAttachmentsRouter.post('/init', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = initSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const data = parsed.data;
    const auth = await authorizeMember(req, res, config, data.workspace_id);
    if (!auth) return;

    if (!GLOBAL_ALLOWED_MIMES.has(data.mime_type)) {
      return res.status(415).json({ error: 'File type not allowed', mime_type: data.mime_type });
    }

    const sb = getServiceClient(config);

    // If conversation_id provided, verify it belongs to workspace.
    let convId: string | null = null;
    if (data.conversation_id) {
      const { data: conv } = await sb
        .from('conversations')
        .select('id, workspace_id')
        .eq('id', data.conversation_id)
        .maybeSingle();
      if (!conv || conv.workspace_id !== data.workspace_id) {
        return res.status(404).json({ error: 'Conversation not found in workspace' });
      }
      convId = data.conversation_id;
    }

    // Resolve provider name (for record-keeping; storage svc resolves at upload).
    const { data: wsConfig } = await sb
      .from('provider_configs')
      .select('provider_name')
      .eq('workspace_id', data.workspace_id)
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

    const storagePath = buildStoragePath(data.workspace_id, data.file_name, data.mime_type);

    const { data: row, error } = await sb
      .from('conversation_attachments')
      .insert({
        workspace_id: data.workspace_id,
        conversation_id: convId,
        storage_provider: providerName,
        storage_path: storagePath,
        file_name: safeFileName(data.file_name, data.mime_type),
        mime_type: data.mime_type,
        size_bytes: data.size_bytes,
        uploaded_by_type: 'agent',
        uploaded_by_id: auth.userId,
        status: 'uploading',
      })
      .select('id, file_name, mime_type, size_bytes')
      .single();

    if (error || !row) {
      return res.status(500).json({ error: error?.message || 'Failed to create attachment record' });
    }

    return res.json({
      attachment_id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
    });
  } catch (err: any) {
    console.error('[conversationAttachments/init]', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /:id/upload  — stream bytes via active storage provider
// Body: { workspace_id, data: base64 }
// ═══════════════════════════════════════════════════════════════════
const uploadSchema = z.object({
  workspace_id: z.string().uuid(),
  data: z.string().min(1),
});

conversationAttachmentsRouter.post('/:id/upload', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });

    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: row } = await sb
      .from('conversation_attachments')
      .select('id, workspace_id, storage_path, mime_type, size_bytes, status, uploaded_by_id, uploaded_by_type')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    if (row.workspace_id !== parsed.data.workspace_id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'uploading') return res.status(409).json({ error: 'Attachment not in uploading state' });
    // Operator upload route can only finalize operator-initiated rows.
    if (row.uploaded_by_type !== 'agent' || row.uploaded_by_id !== auth.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const expectedPrefix = `workspace/${parsed.data.workspace_id}/attachments/`;
    if (!row.storage_path.startsWith(expectedPrefix) || row.storage_path.includes('..')) {
      return res.status(500).json({ error: 'Invalid storage path' });
    }

    const buf = Buffer.from(parsed.data.data, 'base64');
    if (buf.length > row.size_bytes + 4) {
      return res.status(413).json({ error: 'Uploaded size exceeds declared size' });
    }

    // ── storage_gb cap enforcement ──
    // Mirrors POST /api/storage/upload. Forward-correct only; see
    // docs/STORAGE_LIMIT_POLICY.md. No route-local storage math — the shared
    // resolver reads canonical workspace_usage_counters.storage_bytes. On a
    // 403, flip the reserved row to 'failed' so it doesn't strand 'uploading'.
    const limitMw = requireLimit('storage_gb', usageFnForLimit('storage_gb'));
    let proceeded = false;
    await limitMw(req, res, () => { proceeded = true; });
    if (!proceeded) {
      // Mark the reserved row failed so it doesn't linger in 'uploading'.
      await sb.from('conversation_attachments')
        .update({ status: 'failed', error_message: 'storage_gb limit reached' })
        .eq('id', row.id);
      return; // middleware already wrote 403/400
    }

    const result = await uploadFile(config, {
      workspaceId: parsed.data.workspace_id,
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
    console.error('[conversationAttachments/upload]', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /:id  — soft-only DB delete by uploader (storage left to GC)
// Query: ?workspace_id=...
// ═══════════════════════════════════════════════════════════════════
conversationAttachmentsRouter.delete('/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: row } = await sb
      .from('conversation_attachments')
      .select('id, workspace_id, uploaded_by_id, uploaded_by_type, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.workspace_id !== workspaceId) return res.status(403).json({ error: 'Forbidden' });
    // Only the uploader (agent) can delete pending/uploaded operator attachments.
    if (row.uploaded_by_type !== 'agent' || row.uploaded_by_id !== auth.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await sb.from('conversation_attachments').delete().eq('id', row.id);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[conversationAttachments/delete]', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /:id/file — operator-side attachment stream (Inbox).
//
// The visitor proxy (/api/widget/attachments/:id) requires a widget token
// and visitor ownership, so operators could never load inbound media
// (Telegram / WhatsApp / Bale / Instagram voice notes, photos, documents).
// This route is the operator equivalent: identity comes from the first-party
// session cookie, the workspace is derived from the attachment row itself
// and membership is re-verified per call. Provider URLs never reach the
// client. Range requests are honored so <audio>/<video> can seek.
// ═══════════════════════════════════════════════════════════════════
conversationAttachmentsRouter.get('/:id/file', async (req: any, res: any) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);

    const { data: row } = await sb
      .from('conversation_attachments')
      .select('id, workspace_id, storage_path, mime_type, file_name, size_bytes, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'uploaded' && row.status !== 'attached') {
      return res.status(404).json({ error: 'attachment_not_available' });
    }

    // Authorization derives from the row's OWN workspace — a caller cannot
    // probe an arbitrary attachment id with a forged workspace_id.
    const auth = await authorizeMember(req, res, config, row.workspace_id as string);
    if (!auth) return;

    const expectedPrefix = `workspace/${row.workspace_id}/`;
    if (!String(row.storage_path).startsWith(expectedPrefix) || String(row.storage_path).includes('..')) {
      return res.status(500).json({ error: 'invalid_storage_path' });
    }

    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const dl = await downloadFileRange(config, row.workspace_id as string, row.storage_path as string, rangeHeader);
    if (!dl.success || !dl.data) {
      if (dl.status === 416) {
        if (dl.totalSize != null) res.setHeader('Content-Range', `bytes */${dl.totalSize}`);
        return res.status(416).json({ error: 'range_not_satisfiable' });
      }
      const msg = String(dl.error || '').toLowerCase();
      if (dl.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('no such')) {
        return res.status(404).json({ error: 'storage_object_missing' });
      }
      return res.status(502).json({ error: 'provider_download_failed' });
    }

    const wantAttachment = String(req.query.disposition || '').toLowerCase() === 'attachment';
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The SPA and the API live on different subdomains, so <img>/<audio>/<video>
    // loads are cross-origin. Helmet's default CORP (same-origin) makes the
    // browser discard the response even though the request itself succeeded.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `${wantAttachment ? 'attachment' : 'inline'}; filename="${String(row.file_name || 'file').replace(/"/g, '')}"`,
    );
    if (dl.contentLength != null) res.setHeader('Content-Length', String(dl.contentLength));
    if (dl.status === 206 && dl.contentRange) {
      res.setHeader('Content-Range', dl.contentRange);
      return res.status(206).send(dl.data);
    }
    return res.status(200).send(dl.data);
  } catch (err: any) {
    console.error('[conversationAttachments/file]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
