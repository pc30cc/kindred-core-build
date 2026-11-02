/**
 * The call in the chat (docs/operations/TEAM_CALLS.md, "The call in the
 * chat"): every colleague call leaves one line in the two members' team
 * chat, written by the server when the call ends. These are the rules the
 * thread's call bubble and the colleagues list's preview draw it by:
 *
 *  | outcome   | caller sees              | callee sees                |
 *  |-----------|--------------------------|----------------------------|
 *  | completed | voice/video (+ duration) | the same                   |
 *  | missed    | noAnswer                 | missedVoice/missedVideo    |
 *  | cancelled | cancelled                | missedVoice/missedVideo    |
 *  | declined  | declined                 | declined                   |
 *  | failed    | failed                   | failed                     |
 *
 * Missed (and cancelled, for the callee) is drawn in the danger colour.
 */
import type { TranslationKey } from '@/i18n';
import type { TeamCallOutcome, TeamChatCall } from '@/lib/team-calls-api';

const OUTCOMES: ReadonlySet<string> = new Set<TeamCallOutcome>(['completed', 'missed', 'declined', 'cancelled', 'failed']);

/**
 * The line's call as the API sent it, or null when the line is not a call's
 * (or its `call` is not one this panel understands: the line then reads as
 * an ordinary message, its body the language-neutral fallback).
 */
export function teamChatCallOf(value: unknown): TeamChatCall | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id) return null;
  if (v.channel !== 'audio' && v.channel !== 'video') return null;
  if (typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome)) return null;
  if (typeof v.caller_id !== 'string' || !v.caller_id) return null;
  const duration = typeof v.duration_seconds === 'number' && Number.isFinite(v.duration_seconds) && v.duration_seconds >= 0
    ? v.duration_seconds
    : null;
  return {
    id: v.id,
    channel: v.channel,
    outcome: v.outcome as TeamCallOutcome,
    duration_seconds: duration,
    caller_id: v.caller_id,
  };
}

/** The line's title for the member looking at it (the table above). */
export function teamCallLogTitleKey(call: Pick<TeamChatCall, 'channel' | 'outcome'>, viewerIsCaller: boolean): TranslationKey {
  const video = call.channel === 'video';
  switch (call.outcome) {
    case 'completed':
      return video ? 'teamCalls.log.video' : 'teamCalls.log.voice';
    case 'missed':
      if (viewerIsCaller) return 'teamCalls.log.noAnswer';
      return video ? 'teamCalls.log.missedVideo' : 'teamCalls.log.missedVoice';
    case 'cancelled':
      if (viewerIsCaller) return 'teamCalls.log.cancelled';
      return video ? 'teamCalls.log.missedVideo' : 'teamCalls.log.missedVoice';
    case 'declined':
      return 'teamCalls.log.declined';
    case 'failed':
    default:
      return 'teamCalls.log.failed';
  }
}

/** Drawn in the danger colour: a missed call, and a cancelled one for the callee. */
export function teamCallLogIsMissed(call: Pick<TeamChatCall, 'outcome'>, viewerIsCaller: boolean): boolean {
  return call.outcome === 'missed' || (call.outcome === 'cancelled' && !viewerIsCaller);
}

/** `m:ss`, or `h:mm:ss` from an hour on (the server's body fallback writes the same). */
export function formatTeamCallDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The completed call's duration as the line shows it, or null (any other outcome, or none known). */
export function teamCallLogDuration(call: Pick<TeamChatCall, 'outcome' | 'duration_seconds'>): string | null {
  if (call.outcome !== 'completed') return null;
  if (typeof call.duration_seconds !== 'number' || !Number.isFinite(call.duration_seconds)) return null;
  return formatTeamCallDuration(call.duration_seconds);
}
