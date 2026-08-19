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
        .select('id, sender_id, recipient_id, body, read_at, created_at')
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
                body: String(last.body).slice(0, 160),
                created_at: last.created_at,
                outgoing: last.sender_id === auth.userId,
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
      .select('id, sender_id, recipient_id, body, read_at, created_at')
      .eq('workspace_id', workspaceId)
      .or(
        `and(sender_id.eq.${auth.userId},recipient_id.eq.${peerId}),` +
        `and(sender_id.eq.${peerId},recipient_id.eq.${auth.userId})`,
      )
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    const messages = (data ?? []).slice().reverse();
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
  body: z.string().trim().min(1).max(5000),
});

teamChatRouter.post('/messages', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const { workspace_id, recipient_id, body } = parsed.data;
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

    const { data: inserted, error } = await sb
      .from('team_messages')
      .insert({ workspace_id, sender_id: auth.userId, recipient_id, body })
      .select('id, sender_id, recipient_id, body, read_at, created_at')
      .single();
    if (error || !inserted) return res.status(500).json({ error: error?.message || 'Insert failed' });

    return res.json({ ok: true, message: inserted });
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
