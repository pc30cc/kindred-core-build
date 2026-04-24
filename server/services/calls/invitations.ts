/**
 * Phase 9 — Call Invitations service.
 *
 * Invitation-first calling: the operator creates an invitation; the visitor
 * sees a join card in the conversation; only when the visitor clicks Join
 * do we mint tokens and start an actual call_session via the existing
 * provider stack. This module contains the database + cross-cutting logic;
 * HTTP routes live in routes/callInvitations.ts and the widget join path
 * lives in routes/widget.ts.
 *
 * Strict rules:
 *   - Never throws to the route layer for "expected" outcomes (expired,
 *     conflict, already joined). Returns a discriminated result instead.
 *   - Never mints tokens here — token minting is the provider layer's job
 *     and only happens when the visitor joins.
 *   - Best-effort realtime / system message; the DB row is the source
 *     of truth and a 5s widget poll covers any realtime gap.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  publishConversationEvent,
  publishOperatorEvent,
  buildMessageEnvelope,
} from '../realtime/publish.js';
import { recordConversationEvent } from '../conversationEvents.js';

export type InvitationChannel = 'audio' | 'video';
export type InvitationStatus =
  | 'pending'
  | 'joined'
  | 'expired'
  | 'cancelled'
  | 'declined';

export interface CallInvitationRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  contact_id: string | null;
  visitor_session_id: string | null;
  created_by_user_id: string;
  channel: InvitationChannel;
  status: InvitationStatus;
  expires_at: string;
  joined_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
  call_session_id: string | null;
  system_message_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Default invitation TTL: 5 minutes. Overridable via env. */
export function getInvitationTtlSeconds(): number {
  const raw = process.env.CALL_INVITATION_TTL_SECONDS;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 30 || n > 60 * 60) return 300;
  return n;
}

/** Card payload embedded in conversation_messages.metadata. */
export interface InvitationCardMeta {
  kind: 'call_invitation';
  invitation_id: string;
  channel: InvitationChannel;
  status: InvitationStatus;
  expires_at: string;
  operator_name?: string | null;
}

function bodyForCard(channel: InvitationChannel): string {
  return channel === 'video'
    ? 'You have been invited to a video call.'
    : 'You have been invited to an audio call.';
}

async function loadConversationContext(
  config: ServerConfig,
  conversationId: string,
): Promise<{
  workspace_id: string;
  contact_id: string | null;
  visitor_session_id: string | null;
} | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('conversations')
    .select('id, workspace_id, contact_id, visitor_session_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    workspace_id: data.workspace_id as string,
    contact_id: (data.contact_id as string | null) ?? null,
    visitor_session_id: (data.visitor_session_id as string | null) ?? null,
  };
}

async function loadOperatorName(
  config: ServerConfig,
  userId: string,
): Promise<string | null> {
  const sb = getServiceClient(config);
  try {
    const { data } = await sb
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (!data) return null;
    return ((data as any).full_name as string | null) || ((data as any).email as string | null) || null;
  } catch {
    return null;
  }
}

/**
 * Insert the invitation row, post a system message that renders as the
 * invitation card, and emit a realtime nudge so the widget renders the
 * card immediately. All side-effects are best-effort.
 */
export async function createInvitation(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    operatorUserId: string;
    channel: InvitationChannel;
  },
): Promise<
  | { ok: true; invitation: CallInvitationRow }
  | { ok: false; reason: string }
> {
  const sb = getServiceClient(config);

  const ctx = await loadConversationContext(config, input.conversationId);
  if (!ctx) return { ok: false, reason: 'conversation_not_found' };
  if (ctx.workspace_id !== input.workspaceId) {
    return { ok: false, reason: 'workspace_mismatch' };
  }

  // Cancel any other pending invitations on this conversation so the
  // visitor only ever sees one active card at a time.
  await sb
    .from('call_invitations')
    .update({
      status: 'cancelled',
      cancel_reason: 'superseded',
      ended_at: new Date().toISOString(),
    })
    .eq('conversation_id', input.conversationId)
    .eq('status', 'pending');

  const ttlSeconds = getInvitationTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const { data: inserted, error: insErr } = await sb
    .from('call_invitations')
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      contact_id: ctx.contact_id,
      visitor_session_id: ctx.visitor_session_id,
      created_by_user_id: input.operatorUserId,
      channel: input.channel,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('*')
    .single();

  if (insErr || !inserted) {
    console.warn('[invitations] insert failed:', insErr?.message || 'unknown');
    return { ok: false, reason: insErr?.message || 'insert_failed' };
  }

  const invitation = inserted as CallInvitationRow;

  const operatorName = await loadOperatorName(config, input.operatorUserId);

  // ── Persist invitation card as a system message ─────────────────────
  const cardMeta: InvitationCardMeta = {
    kind: 'call_invitation',
    invitation_id: invitation.id,
    channel: invitation.channel,
    status: invitation.status,
    expires_at: invitation.expires_at,
    operator_name: operatorName,
  };

  let systemMessageId: string | null = null;
  try {
    const { data: msg, error: msgErr } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: input.conversationId,
        sender_type: 'system',
        sender_id: input.operatorUserId,
        body: bodyForCard(invitation.channel),
        metadata: cardMeta,
      })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .single();
    if (msgErr) {
      console.warn('[invitations] system message insert failed:', msgErr.message);
    } else if (msg) {
      systemMessageId = msg.id as string;
      // Update invitation with the message link so we can patch it later.
      await sb
        .from('call_invitations')
        .update({ system_message_id: systemMessageId })
        .eq('id', invitation.id);
      invitation.system_message_id = systemMessageId;

      // Realtime push so the widget renders the card without polling.
      void publishConversationEvent(
        config,
        input.workspaceId,
        input.conversationId,
        buildMessageEnvelope({
          id: msg.id as string,
          conversation_id: msg.conversation_id as string,
          sender_type: 'system',
          body: msg.body as string,
          created_at: msg.created_at as string | null,
          metadata: ((msg.metadata as Record<string, unknown>) ?? (cardMeta as unknown as Record<string, unknown>)),
          seen_at: (msg as any).seen_at ?? null,
        }),
      );
    }
  } catch (err: any) {
    console.warn('[invitations] system message side-effect failed:', err?.message || err);
  }

  // ── Operator-side timeline + realtime echo ─────────────────────────
  void recordConversationEvent(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    eventType: 'call_invited',
    actorType: 'agent',
    actorId: input.operatorUserId,
    payload: {
      invitation_id: invitation.id,
      channel: invitation.channel,
      expires_at: invitation.expires_at,
    },
  });

  void publishOperatorEvent(config, {
    kind: 'call_invitation_changed',
    conversation_id: input.conversationId,
    workspace_id: input.workspaceId,
    actor_id: input.operatorUserId,
    invitation_id: invitation.id,
    status: invitation.status,
    channel: invitation.channel,
    expires_at: invitation.expires_at,
  } as any);

  return { ok: true, invitation };
}

/** Patch the invitation card system message in place when status changes. */
async function syncCardForStatus(
  config: ServerConfig,
  invitation: CallInvitationRow,
): Promise<void> {
  if (!invitation.system_message_id) return;
  const sb = getServiceClient(config);
  try {
    // Re-read the existing metadata so we don't drop unrelated fields.
    const { data: existing } = await sb
      .from('conversation_messages')
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .eq('id', invitation.system_message_id)
      .maybeSingle();
    if (!existing) return;
    const prevMeta = (existing.metadata as Record<string, unknown>) ?? {};
    const nextMeta: InvitationCardMeta = {
      ...(prevMeta as any),
      kind: 'call_invitation',
      invitation_id: invitation.id,
      channel: invitation.channel,
      status: invitation.status,
      expires_at: invitation.expires_at,
    };
    await sb
      .from('conversation_messages')
      .update({ metadata: nextMeta })
      .eq('id', invitation.system_message_id);

    void publishConversationEvent(
      config,
      invitation.workspace_id,
      invitation.conversation_id,
      buildMessageEnvelope({
        id: existing.id as string,
        conversation_id: existing.conversation_id as string,
        sender_type: 'system',
        body: existing.body as string,
        created_at: existing.created_at as string | null,
        metadata: nextMeta as unknown as Record<string, unknown>,
        seen_at: (existing as any).seen_at ?? null,
      }),
    );
  } catch (err: any) {
    console.warn('[invitations] card sync failed:', err?.message || err);
  }

  // Operator-side echo so the inbox status updates instantly.
  void publishOperatorEvent(config, {
    kind: 'call_invitation_changed',
    conversation_id: invitation.conversation_id,
    workspace_id: invitation.workspace_id,
    invitation_id: invitation.id,
    status: invitation.status,
    channel: invitation.channel,
    expires_at: invitation.expires_at,
  } as any);
}

export async function cancelInvitation(
  config: ServerConfig,
  invitationId: string,
  actorUserId: string,
  reason: string = 'operator_cancelled',
): Promise<{ ok: boolean; reason?: string; invitation?: CallInvitationRow }> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('call_invitations')
    .select('*')
    .eq('id', invitationId)
    .maybeSingle();
  if (!row) return { ok: false, reason: 'not_found' };
  const invitation = row as CallInvitationRow;
  if (invitation.status !== 'pending') {
    return { ok: true, invitation }; // already terminal
  }
  const { data: updated } = await sb
    .from('call_invitations')
    .update({
      status: 'cancelled',
      cancel_reason: reason,
      ended_at: new Date().toISOString(),
    })
    .eq('id', invitationId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  const next = (updated as CallInvitationRow | null) ?? { ...invitation, status: 'cancelled' };

  await syncCardForStatus(config, next);

  void recordConversationEvent(config, {
    workspaceId: next.workspace_id,
    conversationId: next.conversation_id,
    eventType: 'call_invitation_cancelled',
    actorType: 'agent',
    actorId: actorUserId,
    payload: { invitation_id: next.id, reason },
  });

  return { ok: true, invitation: next };
}

export async function declineInvitation(
  config: ServerConfig,
  invitationId: string,
): Promise<{ ok: boolean; reason?: string; invitation?: CallInvitationRow }> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('call_invitations')
    .select('*')
    .eq('id', invitationId)
    .maybeSingle();
  if (!row) return { ok: false, reason: 'not_found' };
  const invitation = row as CallInvitationRow;
  if (invitation.status !== 'pending') return { ok: true, invitation };

  const { data: updated } = await sb
    .from('call_invitations')
    .update({
      status: 'declined',
      ended_at: new Date().toISOString(),
    })
    .eq('id', invitationId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  const next = (updated as CallInvitationRow | null) ?? { ...invitation, status: 'declined' };

  await syncCardForStatus(config, next);

  void recordConversationEvent(config, {
    workspaceId: next.workspace_id,
    conversationId: next.conversation_id,
    eventType: 'call_invitation_declined',
    actorType: 'visitor',
    actorId: null,
    payload: { invitation_id: next.id },
  });

  return { ok: true, invitation: next };
}

export async function markInvitationJoined(
  config: ServerConfig,
  invitationId: string,
  callSessionId: string,
): Promise<{ ok: boolean; reason?: string; invitation?: CallInvitationRow }> {
  const sb = getServiceClient(config);
  const { data: updated, error } = await sb
    .from('call_invitations')
    .update({
      status: 'joined',
      joined_at: new Date().toISOString(),
      call_session_id: callSessionId,
    })
    .eq('id', invitationId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!updated) return { ok: false, reason: 'not_pending' };
  const next = updated as CallInvitationRow;

  await syncCardForStatus(config, next);

  void recordConversationEvent(config, {
    workspaceId: next.workspace_id,
    conversationId: next.conversation_id,
    eventType: 'call_invitation_joined',
    actorType: 'visitor',
    actorId: null,
    payload: { invitation_id: next.id, call_session_id: callSessionId },
  });

  return { ok: true, invitation: next };
}

/**
 * Sweeper: flips pending invitations whose TTL passed into 'expired' and
 * patches their card. Idempotent. Called by a background ticker.
 */
export async function sweepExpiredInvitations(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const sb = getServiceClient(config);
  const { data: rows } = await sb
    .from('call_invitations')
    .select('*')
    .eq('status', 'pending')
    .lt('expires_at', now.toISOString())
    .limit(100);
  if (!rows || rows.length === 0) return { expired: 0 };

  let count = 0;
  for (const r of rows) {
    const inv = r as CallInvitationRow;
    const { data: updated } = await sb
      .from('call_invitations')
      .update({ status: 'expired', ended_at: now.toISOString() })
      .eq('id', inv.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (!updated) continue;
    count++;
    const next = updated as CallInvitationRow;
    await syncCardForStatus(config, next);
    void recordConversationEvent(config, {
      workspaceId: next.workspace_id,
      conversationId: next.conversation_id,
      eventType: 'call_invitation_expired',
      actorType: 'system',
      actorId: null,
      payload: { invitation_id: next.id },
    });
  }
  return { expired: count };
}

/** Public reader for routes. */
export async function getInvitationById(
  config: ServerConfig,
  invitationId: string,
): Promise<CallInvitationRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_invitations')
    .select('*')
    .eq('id', invitationId)
    .maybeSingle();
  return (data as CallInvitationRow | null) ?? null;
}

/**
 * Validate that an invitation is currently joinable by the visitor.
 *
 * Returns a discriminated result:
 *   { ok: true, invitation }              ready to mint provider room/token
 *   { ok: false, reason: 'not_found' }    invitation row missing
 *   { ok: false, reason: 'expired' }      TTL passed (also flips DB row)
 *   { ok: false, reason: 'cancelled' }    operator cancelled
 *   { ok: false, reason: 'declined' }     visitor previously declined
 *   { ok: false, reason: 'already_joined' } a call_session is already linked
 */
export async function validateInvitationForJoin(
  config: ServerConfig,
  invitationId: string,
): Promise<
  | { ok: true; invitation: CallInvitationRow }
  | { ok: false; reason: 'not_found' | 'expired' | 'cancelled' | 'declined' | 'already_joined' }
> {
  const inv = await getInvitationById(config, invitationId);
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (inv.status === 'declined') return { ok: false, reason: 'declined' };
  if (inv.status === 'joined') return { ok: false, reason: 'already_joined' };
  if (inv.status === 'expired') return { ok: false, reason: 'expired' };
  // status === 'pending' — verify TTL hasn't elapsed.
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    // Flip the row + sync card so subsequent queries see the terminal state.
    const sb = getServiceClient(config);
    const { data: updated } = await sb
      .from('call_invitations')
      .update({ status: 'expired', ended_at: new Date().toISOString() })
      .eq('id', inv.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (updated) {
      await syncCardForStatus(config, updated as CallInvitationRow);
    }
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, invitation: inv };
}

export async function listInvitationsForConversation(
  config: ServerConfig,
  conversationId: string,
): Promise<CallInvitationRow[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_invitations')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20);
  return (data as CallInvitationRow[] | null) ?? [];
}

/**
 * Background TTL sweeper. Polls every 30s, flips pending invitations whose
 * expires_at is in the past to 'expired', patches their system card, and
 * records a timeline event. Best-effort: never throws to the caller.
 */
export function startInvitationExpirySweeper(config: ServerConfig): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await sweepExpiredInvitations(config);
      if (result.expired > 0) {
        console.log(`[invitations] expired ${result.expired} stale invitation(s)`);
      }
    } catch (err: any) {
      console.warn('[invitations] sweeper tick failed:', err?.message || err);
    } finally {
      if (!stopped) timer = setTimeout(tick, 30_000);
    }
  };
  // First tick after a small delay so we don't compete with startup work.
  timer = setTimeout(tick, 5_000);
  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}