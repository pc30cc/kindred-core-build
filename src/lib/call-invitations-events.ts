/**
 * Phase 9 polish — lightweight event bus for invitation realtime nudges.
 *
 * The server already publishes `kind: 'call_invitation_changed'` events on
 * the per-conversation operator channel. InboxPage already subscribes to
 * that channel via useInboxRealtime; this bus simply forwards those
 * payloads to whichever invitation-aware component (OperatorCallPanel)
 * is mounted, without forcing it to maintain its own subscription.
 *
 * No new transport. No global mutable state beyond a single EventTarget.
 */
export interface InvitationChangedEvent {
  workspace_id: string;
  conversation_id: string;
  invitation_id: string;
  status: 'pending' | 'joined' | 'expired' | 'cancelled' | 'declined';
  channel: 'audio' | 'video';
  expires_at?: string | null;
}

const TARGET = new EventTarget();
const EVENT_NAME = 'call_invitation_changed';

export function emitInvitationChanged(payload: InvitationChangedEvent): void {
  try {
    TARGET.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
  } catch {
    /* noop */
  }
}

export function onInvitationChanged(
  handler: (payload: InvitationChangedEvent) => void,
): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<InvitationChangedEvent>).detail;
    if (detail) handler(detail);
  };
  TARGET.addEventListener(EVENT_NAME, listener);
  return () => TARGET.removeEventListener(EVENT_NAME, listener);
}