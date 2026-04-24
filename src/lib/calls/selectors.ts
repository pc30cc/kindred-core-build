/**
 * Phase — Final Inbox Call Hardening · Pass D-E
 *
 * Derived operator-call selectors. UI components import these instead
 * of re-deriving from engine.phase ad hoc. Reusable from Inbox today
 * and from a future Call Center surface.
 */
import type { CallSessionState, CallPhase } from './CallSessionEngine';

export function isOperatorIdle(s: CallSessionState): boolean {
  return s.phase === 'idle';
}

/**
 * Friendly, operator-facing message for a terminal failure code. Returns
 * a concise sentence — never a raw SDK payload. Keep the set small and
 * deterministic; unknown codes fall back to a generic line.
 */
export function operatorCallErrorMessage(code: string | null, fallback?: string | null): string {
  switch (code) {
    case 'rtc_path_not_found':
      return 'Call server is incompatible with the current client.';
    case 'ws_connection_refused':
      return 'Could not reach the call server.';
    case 'connect_timeout':
      return 'Call connection timed out.';
    case 'peer_connection_closed':
      return 'Could not establish media connection.';
    case 'media_denied':
      return 'Microphone or camera access was denied.';
    case 'token_failed':
      return 'Could not authorize the call.';
    case 'config_missing':
      return 'Call provider is not configured.';
    case 'connect_failed':
      return 'Could not connect to the call.';
    case 'cancelled':
      return 'Call was cancelled.';
    case 'remote_hangup':
      return 'The other side ended the call.';
    case 'no_answer':
      return 'No answer.';
    default:
      return fallback || 'The call could not be completed.';
  }
}

export function isOperatorRinging(s: CallSessionState): boolean {
  return s.phase === 'incoming_ringing';
}

export function isOperatorPlacingCall(s: CallSessionState): boolean {
  return s.phase === 'preparing' || s.phase === 'outgoing_ringing';
}

export function isOperatorConnecting(s: CallSessionState): boolean {
  return s.phase === 'connecting';
}

export function isOperatorInActiveCall(s: CallSessionState): boolean {
  return s.phase === 'connected' || s.phase === 'reconnecting';
}

export function isOperatorInActiveAudioCall(s: CallSessionState): boolean {
  return isOperatorInActiveCall(s) && s.callType === 'audio';
}

export function isOperatorInActiveVideoCall(s: CallSessionState): boolean {
  return isOperatorInActiveCall(s) && s.callType === 'video';
}

export function isOperatorReconnecting(s: CallSessionState): boolean {
  return s.phase === 'reconnecting';
}

export function isOperatorEnding(s: CallSessionState): boolean {
  return s.phase === 'ending';
}

export function isOperatorBusy(s: CallSessionState): boolean {
  return s.busy || (s.phase !== 'idle' && !isTerminal(s.phase));
}

function isTerminal(p: CallPhase): boolean {
  return p === 'ended' || p === 'failed' || p === 'declined' || p === 'missed' || p === 'expired';
}

/**
 * Localized-friendly status label per phase + callType. UI may still
 * translate; this returns deterministic English keys so labels never
 * fall back to a generic look that loses audio/video distinction.
 */
export function operatorCallStatusLabel(s: CallSessionState): string {
  const isVideo = s.callType === 'video';
  switch (s.phase) {
    case 'idle': return '';
    case 'preparing': return isVideo ? 'Starting video call…' : 'Starting call…';
    case 'outgoing_ringing': return isVideo ? 'Ringing (video)…' : 'Ringing…';
    case 'incoming_ringing': return isVideo ? 'Incoming video call' : 'Incoming audio call';
    case 'connecting': return isVideo ? 'Connecting video…' : 'Connecting audio…';
    case 'connected': return isVideo ? 'In video call' : 'In audio call';
    case 'reconnecting': return isVideo ? 'Reconnecting video…' : 'Reconnecting audio…';
    case 'ending': return 'Ending…';
    case 'ended': return 'Call ended';
    case 'failed': return s.errorMessage || 'Call failed';
    case 'declined': return 'Call declined';
    case 'missed': return 'No answer';
    case 'expired': return 'Call expired';
  }
}