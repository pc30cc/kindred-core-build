/**
 * One place that turns a system message into text the reader can understand.
 *
 * The server writes system message bodies in English and freezes them into
 * the row at insert time (`server/services/chatRouting.ts`,
 * `server/services/calls/invitations.ts`, the conversations PATCH route), so
 * the stored body can never follow the reader's language. Every surface that
 * shows one therefore has to rebuild the sentence from `metadata`.
 *
 * Four surfaces did that independently — the inbox thread, the inbox list
 * preview, the contact page and the overview page — and each knew about a
 * different subset of kinds. That is why an operator could read a localized
 * "X transferred this conversation" in the thread and a raw English
 * "Call ended · Duration 01:12" in the list beside it.
 */

/** Whatever the server put in `conversation_messages.metadata`. */
export interface SystemMessageMeta {
  kind?: string | null;
  // conversation_transferred / conversation_unassigned
  actor_name?: string | null;
  to_name?: string | null;
  // routing_agent_joined
  agent_name?: string | null;
  // call_invitation
  channel?: string | null;
  operator_name?: string | null;
  status?: string | null;
  // call_ended
  ended_by?: string | null;
  end_reason?: string | null;
  duration_seconds?: number | null;
}

/** The app's translate function. Returns the key itself when unresolved. */
export type Translate = (key: string) => string;

/** i18n lookup that falls back when a key is missing rather than echoing it. */
function line(t: Translate, key: string, fallback: string): string {
  const raw = t(key);
  return raw && raw !== key && !raw.startsWith('inbox.') ? raw : fallback;
}

export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(s % 60)}` : `${pad(mm)}:${pad(s % 60)}`;
}

/** The status word shown beside a call invitation. */
export function invitationStatusText(t: Translate, status: string): string {
  const key = status === 'joined' ? 'inbox.callInvite.statusJoined'
    : status === 'expired' ? 'inbox.callInvite.statusExpired'
    : status === 'cancelled' ? 'inbox.callInvite.statusCancelled'
    : status === 'declined' ? 'inbox.callInvite.statusDeclined'
    : 'inbox.callInvite.statusPending';
  const raw = t(key);
  return raw && !raw.startsWith('inbox.') ? raw : status;
}

/**
 * Localized text for a system message, or `null` when the kind is unknown —
 * in which case the caller should fall back to the stored body rather than
 * showing nothing.
 */
export function systemMessageText(
  meta: SystemMessageMeta | null | undefined,
  t: Translate,
): string | null {
  const kind = meta?.kind;
  if (!kind) return null;

  switch (kind) {
    case 'conversation_transferred': {
      const actor = String(meta?.actor_name || '').trim();
      const to = String(meta?.to_name || '').trim();
      return line(t, 'inbox.system.transferred', `${actor} transferred this conversation to ${to}`)
        .replace('{actor}', actor).replace('{to}', to);
    }
    case 'conversation_unassigned': {
      const actor = String(meta?.actor_name || '').trim();
      return line(t, 'inbox.system.unassigned', `${actor} unassigned this conversation`)
        .replace('{actor}', actor);
    }
    case 'routing_agent_joined': {
      const name = String(meta?.agent_name || '').trim();
      return name
        ? line(t, 'inbox.system.agentJoined', `${name} joined the conversation`).replace('{name}', name)
        : line(t, 'inbox.system.agentJoinedGeneric', 'A colleague joined the conversation');
    }
    case 'routing_no_agent_available':
      return line(
        t, 'inbox.system.noAgentAvailable',
        "All our colleagues are currently busy. Your message was recorded and we'll respond as soon as we can.",
      );
    case 'routing_in_queue':
      return line(t, 'inbox.system.inQueue', 'You are in the queue — someone will be with you shortly.');
    case 'call_invitation': {
      const isVideo = meta?.channel === 'video';
      const op = String(meta?.operator_name || '').trim();
      const text = op
        ? line(
          t,
          isVideo ? 'inbox.system.callInviteVideoFrom' : 'inbox.system.callInviteAudioFrom',
          `${op} invited the user to ${isVideo ? 'a video' : 'an audio'} call`,
        ).replace('{op}', op)
        : line(
          t,
          isVideo ? 'inbox.system.callInviteVideo' : 'inbox.system.callInviteAudio',
          `User invited to ${isVideo ? 'a video' : 'an audio'} call`,
        );
      const status = String(meta?.status || 'pending');
      return `${text} · ${invitationStatusText(t, status)}`;
    }
    case 'call_ended': {
      const endedBy = String(meta?.ended_by || 'system');
      const seconds = Number(meta?.duration_seconds || 0);
      const endReason = String(meta?.end_reason || '');
      // A call that never connected has no duration worth reporting.
      if (endReason === 'failed' || seconds <= 0) {
        return line(t, 'inbox.callEnded.summary.notConnected', 'Call did not connect');
      }
      const duration = formatCallDuration(seconds);
      const key = endedBy === 'operator' ? 'inbox.callEnded.summary.byOperator'
        : endedBy === 'visitor' ? 'inbox.callEnded.summary.byVisitor'
        : 'inbox.callEnded.summary.bySystem';
      const fallback = endedBy === 'operator' ? `Call ended by operator · Duration ${duration}`
        : endedBy === 'visitor' ? `Call ended by visitor · Duration ${duration}`
        : `Call ended · Duration ${duration}`;
      return line(t, key, fallback).replace('{duration}', duration);
    }
    default:
      return null;
  }
}
