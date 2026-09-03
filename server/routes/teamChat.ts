/**
 * Team chat — internal direct messages between workspace operators.
 *
 * Self-hosted Express only (no edge functions). Identity = first-party
 * session cookie (server/lib/workspaceAuth.ts); membership is verified via
 * `is_workspace_member` before every operation, and RLS on `team_messages`
 * enforces the same rule defensively at the database layer.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   GET  /api/team-chat/colleagues?workspace_id=  → directory + unread + last msg
 *   GET  /api/team-chat/thread?workspace_id=&peer_id=[&limit=]
 *   POST /api/team-chat/messages   { workspace_id, recipient_id, body }
 *   POST /api/team-chat/read       { workspace_id, peer_id }
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const teamChatRouter = Router();

async function authorizeMember(
  req: any,
  res: any,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  return { userId: auth.userId };
}

/**
 * Attachments for internal messages reuse `conversation_attachments` with
 * `conversation_id = NULL` (operator-uploaded, never bound to a visitor
 * thread). Rendering needs the same shape the Inbox uses.
 */
type AttachmentRow = {
  id: string; file_name: string; mime_type: string; size_bytes: number; status: string;
};

function attachmentKind(mime: string): 'image' | 'audio' | 'video' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

async function hydrateAttachments(
  sb: any,
  workspaceId: string,
  ids: string[],
): Promise<Map<string, any>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return new Map();
  const { data } = await sb
    .from('conversation_attachments')
    .select('id, file_name, mime_type, size_bytes, status, workspace_id')
    .eq('workspace_id', workspaceId)
    .in('id', unique);
  const map = new Map<string, any>();
  for (const a of (data ?? []) as AttachmentRow[]) {
    map.set(a.id, {
      id: a.id,
      file_name: a.file_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      kind: attachmentKind(String(a.mime_type || '')),
    });
  }
  return map;
}

// ═══ GET /api/team-chat/colleagues ═════════════════════════════════
teamChatRouter.get('/colleagues', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: members, error: memErr } = await sb
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId);
    if (memErr) return res.status(500).json({ error: memErr.message });

    const ids = (members ?? []).map((m: any) => m.user_id).filter(Boolean);
    const [{ data: profiles }, { data: msgs }] = await Promise.all([
      ids.length
        ? sb.from('profiles').select('id, full_name, email, avatar_url').in('id', ids)
        : Promise.resolve({ data: [] as any[] } as any),
      sb.from('team_messages')
        .select('id, sender_id, recipient_id, body, attachment_id, read_at, created_at')
        .eq('workspace_id', workspaceId)
        .or(`sender_id.eq.${auth.userId},recipient_id.eq.${auth.userId}`)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    const profileById = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    const lastByPeer = new Map<string, any>();
    const unreadByPeer = new Map<string, number>();
    for (const m of msgs ?? []) {
      const peer = m.sender_id === auth.userId ? m.recipient_id : m.sender_id;
      if (!lastByPeer.has(peer)) lastByPeer.set(peer, m);
      if (m.recipient_id === auth.userId && !m.read_at) {
        unreadByPeer.set(peer, (unreadByPeer.get(peer) ?? 0) + 1);
      }
    }

    // Preview rows need to say "sent a photo/voice message" instead of an
    // empty line when the message carries only a file.
    const previewAttIds = Array.from(lastByPeer.values())
      .map((m: any) => m.attachment_id)
      .filter(Boolean) as string[];
    const previewAtts = await hydrateAttachments(sb, workspaceId, previewAttIds);
    const attachmentKindById = new Map<string, string>(
      Array.from(previewAtts.entries()).map(([id, a]: any) => [id, a.kind]),
    );

    const colleagues = (members ?? [])
      .filter((m: any) => m.user_id !== auth.userId)
      .map((m: any) => {
        const p: any = profileById.get(m.user_id) ?? {};
        const last = lastByPeer.get(m.user_id) ?? null;
        return {
          user_id: m.user_id,
          role: m.role,
          full_name: p.full_name ?? null,
          email: p.email ?? null,
          avatar_url: p.avatar_url ?? null,
          unread: unreadByPeer.get(m.user_id) ?? 0,
          last_message: last
            ? {
                body: String(last.body || '').slice(0, 160),
                created_at: last.created_at,
                outgoing: last.sender_id === auth.userId,
                attachment_kind: last.attachment_id
                  ? (attachmentKindById.get(String(last.attachment_id)) ?? 'file')
                  : null,
              }
            : null,
        };
      })
      .sort((a: any, b: any) => {
        if ((b.unread > 0 ? 1 : 0) !== (a.unread > 0 ? 1 : 0)) return (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0);
        const ta = a.last_message ? Date.parse(a.last_message.created_at) : 0;
        const tb = b.last_message ? Date.parse(b.last_message.created_at) : 0;
        if (ta !== tb) return tb - ta;
        return (a.full_name || a.email || '').localeCompare(b.full_name || b.email || '');
      });

    const totalUnread = colleagues.reduce((n: number, c: any) => n + c.unread, 0);
    return res.json({ ok: true, colleagues, total_unread: totalUnread, me: auth.userId });
  } catch (err: any) {
    console.error('[team-chat colleagues] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══ GET /api/team-chat/thread ═════════════════════════════════════
teamChatRouter.get('/thread', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = String(req.query.workspace_id || '');
    const peerId = String(req.query.peer_id || '');
    if (!workspaceId || !peerId) return res.status(400).json({ error: 'workspace_id and peer_id required' });
    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('team_messages')
      .select('id, sender_id, recipient_id, body, attachment_id, read_at, created_at')
      .eq('workspace_id', workspaceId)
      .or(
        `and(sender_id.eq.${auth.userId},recipient_id.eq.${peerId}),` +
        `and(sender_id.eq.${peerId},recipient_id.eq.${auth.userId})`,
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data ?? []).slice().reverse();
    const atts = await hydrateAttachments(
      sb, workspaceId, rows.map((m: any) => m.attachment_id).filter(Boolean),
    );
    const messages = rows.map((m: any) => ({
      ...m,
      attachment: m.attachment_id ? atts.get(String(m.attachment_id)) ?? null : null,
    }));
    return res.json({ ok: true, messages, me: auth.userId });
  } catch (err: any) {
    console.error('[team-chat thread] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══ POST /api/team-chat/messages ══════════════════════════════════
const sendSchema = z.object({
  workspace_id: z.string().uuid(),
  recipient_id: z.string().uuid(),
  body: z.string().trim().max(5000).default(''),
  attachment_id: z.string().uuid().nullable().optional(),
}).refine((v) => v.body.length > 0 || !!v.attachment_id, {
  message: 'body or attachment_id required',
});

teamChatRouter.post('/messages', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const { workspace_id, recipient_id, body } = parsed.data;
    const attachmentId = parsed.data.attachment_id ?? null;
    const auth = await authorizeMember(req, res, config, workspace_id);
    if (!auth) return;
    if (recipient_id === auth.userId) return res.status(400).json({ error: 'Cannot message yourself' });

    const sb = getServiceClient(config);
    const { data: peerIsMember, error: peerErr } = await sb.rpc('is_workspace_member', {
      _workspace_id: workspace_id,
      _user_id: recipient_id,
    });
    if (peerErr) return res.status(500).json({ error: 'Membership check failed' });
    if (!peerIsMember) return res.status(404).json({ error: 'Recipient is not a workspace member' });

    // The attachment must belong to this workspace, be uploaded by THIS
    // operator and not already be bound to a visitor conversation.
    let attachment: any = null;
    if (attachmentId) {
      const { data: attRow } = await sb
        .from('conversation_attachments')
        .select('id, workspace_id, conversation_id, uploaded_by_type, uploaded_by_id, status, file_name, mime_type, size_bytes')
        .eq('id', attachmentId)
        .maybeSingle();
      if (!attRow || attRow.workspace_id !== workspace_id) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      if (attRow.conversation_id) return res.status(409).json({ error: 'Attachment already bound' });
      if (attRow.uploaded_by_type !== 'agent' || attRow.uploaded_by_id !== auth.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (attRow.status !== 'uploaded' && attRow.status !== 'attached') {
        return res.status(409).json({ error: 'Attachment not uploaded' });
      }
      attachment = {
        id: attRow.id,
        file_name: attRow.file_name,
        mime_type: attRow.mime_type,
        size_bytes: attRow.size_bytes,
        kind: attachmentKind(String(attRow.mime_type || '')),
      };
    }

    const { data: inserted, error } = await sb
      .from('team_messages')
      .insert({ workspace_id, sender_id: auth.userId, recipient_id, body, attachment_id: attachmentId })
      .select('id, sender_id, recipient_id, body, attachment_id, read_at, created_at')
      .single();
    if (error || !inserted) return res.status(500).json({ error: error?.message || 'Insert failed' });

    if (attachmentId) {
      await sb.from('conversation_attachments')
        .update({ status: 'attached' })
        .eq('id', attachmentId);
    }

    return res.json({ ok: true, message: { ...inserted, attachment } });
  } catch (err: any) {
    console.error('[team-chat send] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══ POST /api/team-chat/read ══════════════════════════════════════
const readSchema = z.object({
  workspace_id: z.string().uuid(),
  peer_id: z.string().uuid(),
});

teamChatRouter.post('/read', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = readSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { error } = await sb
      .from('team_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('workspace_id', parsed.data.workspace_id)
      .eq('recipient_id', auth.userId)
      .eq('sender_id', parsed.data.peer_id)
      .is('read_at', null);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[team-chat read] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
