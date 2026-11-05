/**
 * Colleague calls (team calls): what a `team_call` row is, read without side
 * effects. The contract is docs/operations/TEAM_CALLS.md; the moves of a row
 * are teamCallLifecycle.ts, the routes server/routes/teamCalls.ts.
 *
 * A colleague call is an ordinary `call_sessions` row, no table of its own:
 *   - `entry_source = 'team_call'`, `context_type = 'internal'` and
 *     `context_id = NULL`, so endCallSession (and anything else written for
 *     a customer's conversation) has no thread to write a line into;
 *   - `initiated_by` is the caller; who it rings, the outcome and the phones
 *     involved live in `metadata.team_call` (TeamCallMeta below);
 *   - `connected_at` is stamped at the answer, which is what the billing
 *     trigger (tg_call_sessions_bill_minutes) counts minutes from, and its
 *     live states count towards `max_concurrent_calls` like any other call.
 *
 * Nothing here names a user in the provider room: members join as
 * `internal:<opaque ref>` under their profile name only (operatorIdentity.ts),
 * and the room's metadata carries the workspace and the call id, never who is
 * in it.
 */

/** `call_sessions.entry_source` of a colleague call. */
export const TEAM_CALL_ENTRY_SOURCE = 'team_call';

/** How long a colleague call rings before it is missed (the doc's TEAM_CALL_RING_SECONDS). */
export const TEAM_CALL_RING_SECONDS = 45;

export type TeamCallChannel = 'audio' | 'video';

/** The states the apps are told about; the row never takes another. */
export type TeamCallState = 'ringing' | 'connecting' | 'active' | 'ended' | 'missed' | 'cancelled';

export type TeamCallOutcome = 'completed' | 'declined' | 'cancelled' | 'missed' | 'failed';

/** Why an Android phone that was rung is told to stop (`team_call_cancel`). */
export type TeamCallCancelReason = 'answered_elsewhere' | 'declined' | 'cancelled' | 'missed' | 'ended';

/**
 * What stamped the ring: one of the callee's surfaces saying it rang
 * (`POST /:id/rang`: `ios`, `android`, `web`), or `push`, the server itself
 * when a ring push was accepted for a phone whose app cannot send `rang`
 * (server/services/push/teamCallRing.ts, teamCallDeviceSendsRang): a best
 * effort for old builds, so their callers are not left on a silent
 * "Calling…".
 */
export type TeamCallRangPlatform = 'ios' | 'android' | 'web' | 'push';

export const TEAM_CALL_RANG_PLATFORMS: readonly TeamCallRangPlatform[] = ['ios', 'android', 'web', 'push'];

/** The platforms a client may name in `POST /:id/rang`; `push` is the server's own. */
export const TEAM_CALL_CLIENT_RANG_PLATFORMS = ['ios', 'android', 'web'] as const;

/** The states in which a colleague call holds both of its members. */
export const TEAM_CALL_LIVE_STATES: readonly TeamCallState[] = ['ringing', 'connecting', 'active'];

/** A call that has ended in one way or another. */
export const TEAM_CALL_TERMINAL_STATES: readonly TeamCallState[] = ['ended', 'missed', 'cancelled'];

/** `metadata.team_call`. */
export interface TeamCallMeta {
  caller_user_id: string;
  callee_user_id: string;
  channel: TeamCallChannel;
  outcome: TeamCallOutcome | null;
  /** The callee's install that answered (`mobile_push_devices.device_id`), when it said. */
  answered_device_id: string | null;
  answered_at: string | null;
  /**
   * The callee's installs (`mobile_push_devices.device_id`, the id each app
   * registers with and sends back on accept) the ring went to. Android's are
   * the ones a `team_call_cancel` goes to; iOS's are kept for the record only,
   * since an iPhone is never sent a VoIP push that is not a ring.
   */
  rung_android_device_ids: string[];
  rung_ios_device_ids: string[];
  /**
   * When a phone or a tab of the callee first said it rang (`POST /:id/rang`,
   * server time), and which: null until one did. The caller shows "Calling…"
   * until then and "Ringing…" (with the ringback) after (owner, 2026-11-04).
   * Stamped once, while the call rings; nothing else ever writes it.
   */
  rang_at: string | null;
  rang_device_id: string | null;
  rang_platform: TeamCallRangPlatform | null;
}

/** The `call_sessions` columns a colleague call is read and moved by. */
export interface TeamCallRow {
  id: string;
  workspace_id: string;
  provider: string;
  provider_room_id: string | null;
  call_type: string;
  state: string;
  entry_source: string | null;
  initiated_by: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  connected_at: string | null;
  ended_at: string | null;
}

export const TEAM_CALL_COLUMNS =
  'id, workspace_id, provider, provider_room_id, call_type, state, entry_source, initiated_by, metadata, created_at, connected_at, ended_at';

/** The colleague on the other end, as the apps draw them. */
export interface TeamCallPeer {
  user_id: string;
  /** Their profile name; null without one (the apps then say "Colleague"). */
  name: string | null;
  /** Null without a photo: the apps draw the platform's silhouette, never a letter. */
  avatar_url: string | null;
}

/** `TeamCall`, every response of /api/team-calls. */
export interface TeamCallView {
  id: string;
  workspace_id: string;
  channel: TeamCallChannel;
  state: TeamCallState;
  outcome: TeamCallOutcome | null;
  role: 'caller' | 'callee';
  peer: TeamCallPeer;
  answered_device_id: string | null;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  expires_at: string;
  /** Null until some phone or tab of the callee has rung (`POST /:id/rang`). */
  rang_at: string | null;
}

export function isTeamCallRow(row: { entry_source?: string | null } | null | undefined): boolean {
  return !!row && row.entry_source === TEAM_CALL_ENTRY_SOURCE;
}

const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'declined', 'cancelled', 'missed', 'failed']);
const STATES: ReadonlySet<string> = new Set(['ringing', 'connecting', 'active', 'ended', 'missed', 'cancelled']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/**
 * The row's `metadata.team_call`, every field present. The caller falls back
 * to `initiated_by` and the channel to the row's `call_type`, so a row is
 * always readable as the call it is.
 */
export function readTeamCallMeta(row: Pick<TeamCallRow, 'metadata' | 'initiated_by' | 'call_type'>): TeamCallMeta {
  const raw = (row.metadata && typeof row.metadata.team_call === 'object' && row.metadata.team_call)
    ? row.metadata.team_call as Record<string, unknown>
    : {};
  const outcome = text(raw.outcome);
  const channel = raw.channel === 'video' || raw.channel === 'audio'
    ? raw.channel
    : row.call_type === 'video' ? 'video' : 'audio';
  return {
    caller_user_id: text(raw.caller_user_id) ?? row.initiated_by ?? '',
    callee_user_id: text(raw.callee_user_id) ?? '',
    channel,
    outcome: outcome && OUTCOMES.has(outcome) ? outcome as TeamCallOutcome : null,
    answered_device_id: text(raw.answered_device_id),
    answered_at: text(raw.answered_at),
    rung_android_device_ids: ids(raw.rung_android_device_ids),
    rung_ios_device_ids: ids(raw.rung_ios_device_ids),
    rang_at: text(raw.rang_at),
    rang_device_id: text(raw.rang_device_id),
    rang_platform: (TEAM_CALL_RANG_PLATFORMS as readonly unknown[]).includes(raw.rang_platform)
      ? raw.rang_platform as TeamCallRangPlatform
      : null,
  };
}

/** The row's state as the apps know it (a row never takes another; anything else reads as over). */
export function teamCallState(row: Pick<TeamCallRow, 'state'>): TeamCallState {
  return STATES.has(row.state) ? row.state as TeamCallState : 'ended';
}

/** When the ring runs out: TEAM_CALL_RING_SECONDS after the call was placed. */
export function teamCallExpiresAt(row: Pick<TeamCallRow, 'created_at'>): Date {
  return new Date(Date.parse(row.created_at) + TEAM_CALL_RING_SECONDS * 1000);
}

/** Calls placed before this instant have rung for their whole ring. */
export function teamCallRingCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TEAM_CALL_RING_SECONDS * 1000);
}

/** Still ringing, with ring left: the only call that can be answered. */
export function isRingingNow(row: Pick<TeamCallRow, 'state' | 'created_at'>, now: Date = new Date()): boolean {
  return row.state === 'ringing' && teamCallExpiresAt(row).getTime() > now.getTime();
}

/** Which side of the call a user is on, or null when they are on neither. */
export function teamCallRole(meta: TeamCallMeta, userId: string): 'caller' | 'callee' | null {
  if (userId && meta.caller_user_id === userId) return 'caller';
  if (userId && meta.callee_user_id === userId) return 'callee';
  return null;
}

/** The colleague on the other end of the call from [userId]. */
export function teamCallPeerId(meta: TeamCallMeta, userId: string): string {
  return meta.caller_user_id === userId ? meta.callee_user_id : meta.caller_user_id;
}

/** The `TeamCall` a participant is answered with. */
export function teamCallView(row: TeamCallRow, viewerId: string, peer: TeamCallPeer): TeamCallView {
  const meta = readTeamCallMeta(row);
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    channel: meta.channel,
    state: teamCallState(row),
    outcome: meta.outcome,
    role: meta.caller_user_id === viewerId ? 'caller' : 'callee',
    peer,
    answered_device_id: meta.answered_device_id,
    created_at: row.created_at,
    answered_at: meta.answered_at,
    ended_at: row.ended_at,
    expires_at: teamCallExpiresAt(row).toISOString(),
    rang_at: meta.rang_at,
  };
}
