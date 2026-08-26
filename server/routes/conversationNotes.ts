/**
 * Phase 4b — Operator-only notes + timeline routes.
 *
 * Notes are PRIVATE to workspace members. They are NEVER read by the
 * widget, never published to realtime channels, and never enriched into
 * conversation_messages. They live in their own table (`conversation_notes`)
 * with their own RLS that requires `is_workspace_member`.
 *
 * Timeline reads the normalized `conversation_events` table only — never
 * audit_logs, never reconstructed from messages. Payload shapes are stable
 * per event_type (see TIMELINE EVENT CONTRACT below).
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   GET    /api/conversations/:id/notes
 *   POST   /api/conversations/:id/notes
 *   PATCH  /api/conversations/:id/notes/:noteId
 *   DELETE /api/conversations/:id/notes/:noteId
 *   GET    /api/conversations/:id/timeline
 *
 * ─── AUTH MODEL ────────────────────────────────────────────────────
 * Identity = first-party session cookie (server/lib/workspaceAuth.ts). We
 * resolve the user, verify workspace membership via `is_workspace_member`,
 * then perform DB operations through the service-role client. RLS on both
 * tables also enforces membership defensively, so a misrouted request from
 * a non-member would still be denied at the database layer.
 *
 * ─── TIMELINE EVENT CONTRACT ───────────────────────────────────────
 * Every event row returned has:
 *   { id, conversation_id, workspace_id, event_type, actor_type,
 *     actor_id, payload, created_at, actor?: { id, full_name, email,
 *     avatar_url } | null }
 *
 * Payload shape per event_type (always present, always these keys):
 *   created            { source?: 'widget' | 'inbox' | 'system' }
 *   identified         { contact_id, method, is_new_contact }
 *   assigned           { from: string|null, to: string }
 *   unassigned         { from: string, to: null }
 *   status_changed     { from, to }
 *   resolved           { from, to }            // to ∈ {resolved, closed}
 *   reopened           { from, to }            // from ∈ {resolved, closed}
 *   priority_changed   { from, to }
 *   tag_added          { tag }
 *   tag_removed        { tag }
 *   attachment_added   { message_id, attachment_id }
 *   ai_reply           { message_id, provider?, model? }
 *   note_added         { note_id, preview }    // preview = first 140 chars
 *   note_deleted       { note_id }
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { recordConversationEvent } from '../services/conversationEvents.js';
import { publishOperatorEvent } from '../services/realtime/publish.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const conversationNotesRouter = Router({ mergeParams: true });

// ─── Auth helper — delegates to the central first-party session helper ──
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
 * Verify that the conversation belongs to the workspace claimed in the
 * request body/query. Returns the conversation row on success, or null
 * after sending a 404 response.
 */
async function loadConversation(
  config: ServerConfig,
  res: any,
  conversationId: string,
  workspaceId: string,
) {
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('id, workspace_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.workspace_id !== workspaceId) {
    res.status(404).json({ error: 'Conversation not found in workspace' });
    return null;
  }
  return conv;
}

// ═══════════════════════════════════════════════════════════════════
// GET /api/conversations/:id/notes
// Lists all notes for a conversation (operator-only).
// Query: ?workspace_id=<uuid>
// ═══════════════════════════════════════════════════════════════════
conversationNotesRouter.get('/:id/notes', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const conversationId = req.params.id;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;
    const conv = await loadConversation(config, res, conversationId, workspaceId);
    if (!conv) return;

    const sb = getServiceClient(config);
    const { data: notes, error } = await sb
      .from('conversation_notes')
      .select('id, conversation_id, workspace_id, author_id, body, metadata, created_at, updated_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Hydrate author profile for UI rendering.
    const authorIds = Array.from(new Set((notes ?? []).map(n => n.author_id).filter(Boolean)));
    let profiles: Record<string, any> = {};
    if (authorIds.length) {
      const { data: rows } = await sb
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', authorIds);
      for (const p of rows ?? []) profiles[p.id] = p;
    }
    const enriched = (notes ?? []).map(n => ({
      ...n,
      author: profiles[n.author_id] ?? null,
    }));
    return res.json({ ok: true, notes: enriched });
  } catch (err: any) {
    console.error('[notes GET] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/conversations/:id/notes
// Body: { workspace_id, body, metadata? }
// Records a `note_added` timeline event with a stable payload.
// ═══════════════════════════════════════════════════════════════════
const createNoteSchema = z.object({
  workspace_id: z.string().uuid(),
  body: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional(),
});

conversationNotesRouter.post('/:id/notes', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const conversationId = req.params.id;
    const parsed = createNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;
    const conv = await loadConversation(config, res, conversationId, parsed.data.workspace_id);
    if (!conv) return;

    const sb = getServiceClient(config);
    const { data: inserted, error } = await sb
      .from('conversation_notes')
      .insert({
        conversation_id: conversationId,
        workspace_id: parsed.data.workspace_id,
        author_id: auth.userId,
        body: parsed.data.body,
        metadata: parsed.data.metadata ?? {},
      })
      .select('id, conversation_id, workspace_id, author_id, body, metadata, created_at, updated_at')
      .single();
    if (error || !inserted) return res.status(500).json({ error: error?.message || 'Insert failed' });

    // Hydrate author for the optimistic UI render.
    const { data: profile } = await sb
      .from('profiles')
      .select('id, full_name, email, avatar_url')
      .eq('id', auth.userId)
      .maybeSingle();

    // Timeline event — stable payload: { note_id, preview }
    // skipRealtimeEcho: the richer `note_added` operator event below
    // already triggers the same UI invalidations.
    void recordConversationEvent(config, {
      workspaceId: parsed.data.workspace_id,
      conversationId,
      eventType: 'note_added',
      actorType: 'agent',
      actorId: auth.userId,
      payload: {
        note_id: inserted.id,
        preview: parsed.data.body.slice(0, 140),
      },
      skipRealtimeEcho: true,
    });

    // Phase 5 — realtime push (operator-only). Per-conversation channel
    // only; the inbox list does not display notes so we skip that fan-out.
    void publishOperatorEvent(config, {
      kind: 'note_added',
      conversation_id: conversationId,
      workspace_id: parsed.data.workspace_id,
      actor_id: auth.userId,
      note_id: inserted.id,
      created_at: inserted.created_at,
      preview: parsed.data.body.slice(0, 140),
    }, { skipInboxChannel: true });

    return res.json({ ok: true, note: { ...inserted, author: profile ?? null } });
  } catch (err: any) {
    console.error('[notes POST] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/conversations/:id/notes/:noteId
// Body: { workspace_id, body }
// Authors can edit their own notes (RLS also enforces this).
// No timeline event for edits — only adds + deletes are recorded.
// ═══════════════════════════════════════════════════════════════════
const updateNoteSchema = z.object({
  workspace_id: z.string().uuid(),
  body: z.string().min(1).max(20_000),
});

conversationNotesRouter.patch('/:id/notes/:noteId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { id: conversationId, noteId } = req.params;
    const parsed = updateNoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const auth = await authorizeMember(req, res, config, parsed.data.workspace_id);
    if (!auth) return;

    const sb = getServiceClient(config);
    // Confirm the note exists, belongs to the conversation+workspace, and the
    // caller is the author. (RLS on conversation_notes enforces this too.)
    const { data: existing } = await sb
      .from('conversation_notes')
      .select('id, conversation_id, workspace_id, author_id')
      .eq('id', noteId)
      .maybeSingle();
    if (!existing
      || existing.conversation_id !== conversationId
      || existing.workspace_id !== parsed.data.workspace_id) {
      return res.status(404).json({ error: 'Note not found' });
    }
    if (existing.author_id !== auth.userId) {
      return res.status(403).json({ error: 'Only the author can edit this note' });
    }

    const { data: updated, error } = await sb
      .from('conversation_notes')
      .update({ body: parsed.data.body, updated_at: new Date().toISOString() })
      .eq('id', noteId)
      .select('id, conversation_id, workspace_id, author_id, body, metadata, created_at, updated_at')
      .single();
    if (error || !updated) return res.status(500).json({ error: error?.message || 'Update failed' });

    return res.json({ ok: true, note: updated });
  } catch (err: any) {
    console.error('[notes PATCH] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/conversations/:id/notes/:noteId?workspace_id=<uuid>
// Author OR workspace owner/admin can delete (matches RLS policy).
// Records a `note_deleted` timeline event.
// ═══════════════════════════════════════════════════════════════════
conversationNotesRouter.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const { id: conversationId, noteId } = req.params;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    const sb = getServiceClient(config);
    const { data: existing } = await sb
      .from('conversation_notes')
      .select('id, conversation_id, workspace_id, author_id')
      .eq('id', noteId)
      .maybeSingle();
    if (!existing
      || existing.conversation_id !== conversationId
      || existing.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'Note not found' });
    }

    // Mirror the RLS DELETE policy: author OR workspace owner/admin.
    const isAuthor = existing.author_id === auth.userId;
    let canDelete = isAuthor;
    if (!canDelete) {
      const { data: role } = await sb.rpc('get_workspace_role', {
        _workspace_id: workspaceId,
        _user_id: auth.userId,
      });
      canDelete = role === 'owner' || role === 'admin';
    }
    if (!canDelete) return res.status(403).json({ error: 'Not allowed to delete this note' });

    const { error } = await sb.from('conversation_notes').delete().eq('id', noteId);
    if (error) return res.status(500).json({ error: error.message });

    void recordConversationEvent(config, {
      workspaceId,
      conversationId,
      eventType: 'note_deleted',
      actorType: 'agent',
      actorId: auth.userId,
      payload: { note_id: noteId },
      skipRealtimeEcho: true,
    });

    // Phase 5 — realtime push (operator-only).
    void publishOperatorEvent(config, {
      kind: 'note_deleted',
      conversation_id: conversationId,
      workspace_id: workspaceId,
      actor_id: auth.userId,
      note_id: noteId,
      created_at: new Date().toISOString(),
    }, { skipInboxChannel: true });

    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[notes DELETE] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/conversations/:id/timeline?workspace_id=<uuid>&limit=<n>
// Reads from conversation_events directly. Hydrates actor profiles for
// 'agent' rows so the UI can render avatars/names without an extra fetch.
// Visitors and system actors render with localized labels client-side.
// ═══════════════════════════════════════════════════════════════════
conversationNotesRouter.get('/:id/timeline', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const conversationId = req.params.id;
    const workspaceId = String(req.query.workspace_id || '');
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '200'), 10) || 200, 1), 500);

    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;
    const conv = await loadConversation(config, res, conversationId, workspaceId);
    if (!conv) return;

    const sb = getServiceClient(config);
    const { data: events, error } = await sb
      .from('conversation_events')
      .select('id, conversation_id, workspace_id, event_type, actor_type, actor_id, payload, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    // Collect every actor_id we may want to render — both event actors
    // AND any uuid that appears in payload.from / payload.to for
    // assigned/unassigned events (so the UI gets names for both sides).
    const userIds = new Set<string>();
    for (const ev of events ?? []) {
      if (ev.actor_id && ev.actor_type === 'agent') userIds.add(ev.actor_id);
      if (ev.event_type === 'assigned' || ev.event_type === 'unassigned') {
        const p = ev.payload as any;
        if (typeof p?.from === 'string') userIds.add(p.from);
        if (typeof p?.to === 'string') userIds.add(p.to);
      }
    }
    let profiles: Record<string, any> = {};
    if (userIds.size) {
      const { data: rows } = await sb
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', Array.from(userIds));
      for (const p of rows ?? []) profiles[p.id] = p;
    }

    const enriched = (events ?? []).map(ev => ({
      ...ev,
      actor: ev.actor_id && ev.actor_type === 'agent' ? profiles[ev.actor_id] ?? null : null,
      // For assigned/unassigned, attach hydrated actor profiles for from/to
      // under payload._refs so the UI doesn't need a second lookup.
      payload:
        ev.event_type === 'assigned' || ev.event_type === 'unassigned'
          ? {
              ...(ev.payload as any),
              _refs: {
                from: profiles[(ev.payload as any)?.from] ?? null,
                to: profiles[(ev.payload as any)?.to] ?? null,
              },
            }
          : ev.payload,
    }));

    return res.json({ ok: true, events: enriched });
  } catch (err: any) {
    console.error('[timeline GET] error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
});
