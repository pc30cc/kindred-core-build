/**
 * Pass A — Lightweight event bus for call:ended realtime nudges.
 *
 * Mirrors the call_invitations bus: InboxPage already subscribes to the
 * per-conversation channel via useInboxRealtime; this bus forwards the
 * `kind: 'call:ended'` envelopes the server publishes from
 * services/calls/endSession.ts to whoever is listening (currently the
 * OperatorCallProvider).
 */
export interface CallEndedEvent {
  workspace_id: string;
  conversation_id: string;
  call_session_id: string;
  ended_by: 'operator' | 'visitor' | 'system';
  reason: 'operator_ended' | 'visitor_ended' | 'system_ended' | 'failed';
  duration_seconds: number;
  ended_at: string;
}

const TARGET = new EventTarget();
const EVENT_NAME = 'call_ended';

export function emitCallEnded(payload: CallEndedEvent): void {
  try {
    TARGET.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
  } catch {
    /* noop */
  }
}

export function onCallEnded(handler: (payload: CallEndedEvent) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<CallEndedEvent>).detail;
    if (detail) handler(detail);
  };
  TARGET.addEventListener(EVENT_NAME, listener);
  return () => TARGET.removeEventListener(EVENT_NAME, listener);
}