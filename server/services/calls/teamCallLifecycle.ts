/**
 * Colleague calls (team calls): every move of a `team_call` row, and what
 * each move tells the phones. The contract is docs/operations/TEAM_CALLS.md;
 * the row is described in teamCall.ts.
 *
 *   ringing ──accept──▶ connecting ──both in the room──▶ active ──▶ ended (completed)
 *      │                    └──────── hang-up, a member leaving, the room closing ──┘
 *      ├─ decline (callee) ─▶ ended (declined)
 *      ├─ cancel (caller) ──▶ cancelled (cancelled) + missed-call alert
 *      └─ ring runs out ────▶ missed (missed) + missed-call alert
 *
 * Every move is a compare-and-set on the state it was read in (and, for an
 * answer and a timeout, on which side of the ring's end it falls): the first
 * answer of the callee's phones wins and the others are told so, a decline
 * racing an answer loses cleanly, and two replicas of the ring ticker never
 * miss a call twice. `metadata.team_call` only ever changes together with the
 * state, so the metadata a move writes is the one it read. The one move from
 * a live state to another live state is connecting → active, so an end that
 * lost to it (a hang-up at the moment the second member joined) tries again
 * from `active` rather than being dropped.
 *
 * Who ends an answered call: a member (hang-up), the LiveKit webhook (a
 * member leaving, the room closing) and, for a call whose webhook never
 * arrived, the room check (teamCallTicker.ts asks the provider who is in the
 * room).
 *
 * A move that took place then tells, best-effort and never failing it:
 *   - both members, on their own realtime channels (`kind: 'team_call'`);
 *   - the callee's rung Android phones to stop (`team_call_cancel`), never
 *     the one that answered, and never an iPhone (teamCallRing.ts);
 *   - the two members' team chat, once the call is over: its one line
 *     (teamCallChat.ts), with the `team_message` nudge a sent message gives;
 *   - the callee that a call rang out or was hung up on (`team_call_missed`),
 *     after that line, so the alert's badge counts it;
 *   - the provider, which closes the room of a call that is over.
 * Those effects come back as a promise that never rejects: a route answers
 * without waiting for them, the ticker and the webhook wait.
 *
 * None of this goes through endCallSession: its end is the call-centre's
 * (`end_reason`, the conversation line, the busy-lock), it would overwrite a
 * missed or cancelled row with `ended`, and a colleague call has no thread to
 * write to.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import type { CallProviderId } from './providers/types.js';
import { publishTeamEvent } from '../realtime/publish.js';
import { cancelTeamCallRing } from '../push/teamCallRing.js';
import { notifyTeamCallMissed } from '../push/dispatch.js';
import { writeTeamCallLine } from './teamCallChat.js';
import {
  TEAM_CALL_COLUMNS,
  TEAM_CALL_ENTRY_SOURCE,
  TEAM_CALL_LIVE_STATES,
  isTeamCallRow,
  readTeamCallMeta,
  teamCallRingCutoff,
  type TeamCallCancelReason,
  type TeamCallMeta,
  type TeamCallOutcome,
  type TeamCallRow,
  type TeamCallState,
} from './teamCall.js';

type Db = ReturnType<typeof getServiceClient>;

/** The outcome of a move: the row as it now is, and what the move set off. */
export interface TeamCallMove {
  row: TeamCallRow;
  /** False when the row was already past the move (an idempotent repeat, or a race lost). */
  moved: boolean;
  /** The move's notices (realtime, push, room). Never rejects. */
  effects: Promise<void>;
}

const NOTHING: Promise<void> = Promise.resolve();

/** A colleague call by id, or null (no such row, or another kind of call). Throws on a failed read. */
export async function loadTeamCall(config: ServerConfig, callId: string): Promise<TeamCallRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('call_sessions')
    .select(TEAM_CALL_COLUMNS)
    .eq('id', callId)
    .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
    .maybeSingle();
  if (error) throw new Error(`team_call_read_failed: ${error.message}`);
  const row = data as TeamCallRow | null;
  return row && isTeamCallRow(row) ? row : null;
}

/** The row as it is now, for a move that lost its race. */
async function reload(config: ServerConfig, row: TeamCallRow): Promise<TeamCallRow> {
  return (await loadTeamCall(config, row.id)) ?? row;
}

interface Transition {
  to: TeamCallState;
  outcome?: TeamCallOutcome;
  meta?: Partial<TeamCallMeta>;
  columns?: Record<string, unknown>;
  /** The ring must still be on (an answer) or must be over (a timeout). */
  ring?: 'on' | 'over';
}

/**
 * The compare-and-set every move is: from the state [row] was read in to
 * [t.to], with its metadata. Resolves with the row as written, or null when
 * the row had moved on in the meantime. Throws on a failed write.
 */
async function transition(config: ServerConfig, row: TeamCallRow, t: Transition): Promise<TeamCallRow | null> {
  const meta = readTeamCallMeta(row);
  const nextMeta: TeamCallMeta = { ...meta, ...(t.meta ?? {}), ...(t.outcome ? { outcome: t.outcome } : {}) };
  const metadata = { ...(row.metadata ?? {}), team_call: nextMeta };
  let query = getServiceClient(config)
    .from('call_sessions')
    .update({ state: t.to, metadata, ...(t.columns ?? {}) })
    .eq('id', row.id)
    .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
    .eq('state', row.state);
  const cutoff = teamCallRingCutoff().toISOString();
  if (t.ring === 'on') query = query.gt('created_at', cutoff);
  if (t.ring === 'over') query = query.lte('created_at', cutoff);
  const { data, error } = await query.select(TEAM_CALL_COLUMNS).maybeSingle();
  if (error) throw new Error(`team_call_write_failed: ${error.message}`);
  return (data as TeamCallRow | null) ?? null;
}

/** Who ended a call, in the columns the call-centre's ends use too. */
interface Ender {
  by: 'operator' | 'system';
  userId: string | null;
  reason: 'operator_ended' | 'system_ended' | 'failed';
}

/** The end columns: when, how long it was connected (0 when never), by whom. */
function endColumns(row: TeamCallRow, ender: Ender, at: Date = new Date()): Record<string, unknown> {
  const connected = row.connected_at ? Date.parse(row.connected_at) : NaN;
  return {
    ended_at: at.toISOString(),
    duration_seconds: Number.isFinite(connected) ? Math.max(0, Math.round((at.getTime() - connected) / 1000)) : 0,
    ended_by: ender.by,
    ended_by_user_id: ender.userId,
    end_reason: ender.reason,
  };
}

interface Effects {
  /** Stop the rung Android phones, for this reason. */
  cancel?: TeamCallCancelReason;
  /** The install that answered, left out of the cancel. */
  exceptDeviceId?: string | null;
  /** The callee gets the missed-call notification. */
  missedAlert?: boolean;
  /** The call is over: close its room. */
  closeRoom?: boolean;
  /** The member who made the move, for the call's event log; null for the system. */
  actorId: string | null;
}

/** A move's notices. Never rejects, and waits for none of them to succeed. */
export function announceTeamCall(config: ServerConfig, row: TeamCallRow, effects: Effects): Promise<void> {
  const meta = readTeamCallMeta(row);
  const tasks: Array<Promise<unknown>> = [
    publishTeamEvent(config, [meta.caller_user_id, meta.callee_user_id], {
      kind: 'team_call',
      workspace_id: row.workspace_id,
      call_id: row.id,
      state: row.state,
      outcome: meta.outcome,
    }),
    recordTeamCallEvent(getServiceClient(config), row, effects.actorId),
  ];
  if (effects.cancel && meta.rung_android_device_ids.length) {
    tasks.push(cancelTeamCallRing(config, {
      callId: row.id,
      calleeId: meta.callee_user_id,
      androidDeviceIds: meta.rung_android_device_ids,
      reason: effects.cancel,
      exceptDeviceId: effects.exceptDeviceId ?? null,
    }));
  }
  // The call's line in the team chat, once it is over (every end is a
  // compare-and-set from a live state, so this runs once per call; the line's
  // unique key makes a second run do nothing). Never rejects. The missed-call
  // alert waits for the write only, not for the line's realtime nudge.
  const over = !(TEAM_CALL_LIVE_STATES as readonly string[]).includes(row.state);
  const chatLine = over ? writeTeamCallLine(config, row) : Promise.resolve({ nudged: NOTHING });
  tasks.push(chatLine.then((line) => line.nudged));
  if (effects.missedAlert) {
    tasks.push(chatLine.then(() => notifyTeamCallMissed(config, {
      workspaceId: row.workspace_id,
      callerId: meta.caller_user_id,
      calleeId: meta.callee_user_id,
      callId: row.id,
      channel: meta.channel,
    })));
  }
  if (effects.closeRoom && row.provider_room_id) {
    const roomId = row.provider_room_id;
    tasks.push(Promise.resolve().then(() => resolveCallProvider(row.provider as CallProviderId).closeRoom(config, roomId)));
  }
  return Promise.allSettled(tasks).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn('[team-call] notice failed:', r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
  });
}

/** One line in the call's event log per move; best-effort (call_events is hosted-only on some installs). */
async function recordTeamCallEvent(sb: Db, row: TeamCallRow, actorId: string | null): Promise<void> {
  const meta = readTeamCallMeta(row);
  try {
    await sb.from('call_events').insert({
      call_session_id: row.id,
      event_type: `team_call.${row.state}`,
      actor_type: 'internal',
      actor_id: actorId,
      payload: { outcome: meta.outcome, channel: meta.channel },
    });
  } catch { /* the move stands without its log line */ }
}

/** A move that found the row already past it: the row as it is, nothing set off. */
function unmoved(row: TeamCallRow): TeamCallMove {
  return { row, moved: false, effects: NOTHING };
}

/**
 * The callee answers on [deviceId]: ringing → connecting, if the ring is
 * still on and no other phone of theirs got there first. `connected_at` is
 * stamped now — the call's billable minutes count from the answer — and the
 * callee's other Android phones are told it was answered elsewhere.
 *
 * A call whose ring ran out while nobody had marked it missed yet is marked
 * missed here, and is not answered.
 */
export async function acceptTeamCall(
  config: ServerConfig,
  row: TeamCallRow,
  input: { userId: string; deviceId: string | null },
): Promise<TeamCallMove> {
  if (row.state !== 'ringing') return unmoved(row);
  const now = new Date().toISOString();
  const updated = await transition(config, row, {
    to: 'connecting',
    ring: 'on',
    meta: { answered_device_id: input.deviceId, answered_at: now },
    columns: { connected_at: now, started_at: now },
  });
  if (updated) {
    return {
      row: updated,
      moved: true,
      effects: announceTeamCall(config, updated, {
        cancel: 'answered_elsewhere',
        exceptDeviceId: input.deviceId,
        actorId: input.userId,
      }),
    };
  }
  const latest = await reload(config, row);
  if (latest.state === 'ringing') {
    const expired = await expireTeamCall(config, latest);
    return { ...expired, moved: false };
  }
  return unmoved(latest);
}

/** The callee declines: ringing → ended (declined); the caller's call ends at once. */
export async function declineTeamCall(config: ServerConfig, row: TeamCallRow, userId: string): Promise<TeamCallMove> {
  if (row.state !== 'ringing') return unmoved(row);
  const updated = await transition(config, row, {
    to: 'ended',
    outcome: 'declined',
    columns: endColumns(row, { by: 'operator', userId, reason: 'operator_ended' }),
  });
  if (!updated) return unmoved(await reload(config, row));
  return {
    row: updated,
    moved: true,
    effects: announceTeamCall(config, updated, { cancel: 'declined', closeRoom: true, actorId: userId }),
  };
}

/**
 * The caller hangs up before an answer: ringing → cancelled. The callee's
 * phones stop and they are told they missed the call.
 */
export async function cancelTeamCall(config: ServerConfig, row: TeamCallRow, userId: string): Promise<TeamCallMove> {
  if (row.state !== 'ringing') return unmoved(row);
  const updated = await transition(config, row, {
    to: 'cancelled',
    outcome: 'cancelled',
    columns: endColumns(row, { by: 'operator', userId, reason: 'operator_ended' }),
  });
  if (!updated) return unmoved(await reload(config, row));
  return {
    row: updated,
    moved: true,
    effects: announceTeamCall(config, updated, {
      cancel: 'cancelled',
      missedAlert: true,
      closeRoom: true,
      actorId: userId,
    }),
  };
}

/**
 * The ring ran out with nobody answering: ringing → missed. Only a call
 * placed a whole ring ago; the callee's phones stop and they get the
 * missed-call notification. Used by the ticker, and by any read that finds a
 * call still ringing past its end.
 */
export async function expireTeamCall(config: ServerConfig, row: TeamCallRow): Promise<TeamCallMove> {
  if (row.state !== 'ringing') return unmoved(row);
  const updated = await transition(config, row, {
    to: 'missed',
    outcome: 'missed',
    ring: 'over',
    columns: endColumns(row, { by: 'system', userId: null, reason: 'system_ended' }),
  });
  if (!updated) return unmoved(await reload(config, row));
  return {
    row: updated,
    moved: true,
    effects: announceTeamCall(config, updated, {
      cancel: 'missed',
      missedAlert: true,
      closeRoom: true,
      actorId: null,
    }),
  };
}

/** Tries of an end that keeps losing its compare-and-set to a live row's move. */
const COMPLETE_ATTEMPTS = 3;

/**
 * An answered call is over (a member hung up, left the room, or the room
 * closed): connecting|active → ended (completed). The rung Android phones are
 * told once more, in case the answer's cancel never reached one of them.
 *
 * Lost to a move that left the call live (connecting → active, both members
 * in the room), it tries again from the row as it now is: the member's end
 * still stands. Only a row that is over by then is left as it is.
 */
async function completeTeamCall(config: ServerConfig, row: TeamCallRow, ender: Ender): Promise<TeamCallMove> {
  let current = row;
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
    if (current.state !== 'connecting' && current.state !== 'active') return unmoved(current);
    const updated = await transition(config, current, {
      to: 'ended',
      outcome: 'completed',
      columns: endColumns(current, ender),
    });
    if (updated) {
      return {
        row: updated,
        moved: true,
        effects: announceTeamCall(config, updated, {
          cancel: 'ended',
          exceptDeviceId: readTeamCallMeta(updated).answered_device_id,
          closeRoom: true,
          actorId: ender.userId,
        }),
      };
    }
    current = await reload(config, current);
  }
  return unmoved(current);
}

/**
 * Either member hangs up: before an answer it is the caller's cancel or the
 * callee's decline; after it, the call is completed for both. Idempotent: a
 * call already over is answered as it is.
 */
export async function hangUpTeamCall(config: ServerConfig, row: TeamCallRow, userId: string): Promise<TeamCallMove> {
  const meta = readTeamCallMeta(row);
  if (row.state === 'ringing') {
    return meta.caller_user_id === userId
      ? cancelTeamCall(config, row, userId)
      : declineTeamCall(config, row, userId);
  }
  return completeTeamCall(config, row, { by: 'operator', userId, reason: 'operator_ended' });
}

/**
 * The call's room could not be made: the row is closed as failed before
 * anything rang, so it neither holds its members nor counts as live.
 */
export async function failTeamCall(config: ServerConfig, row: TeamCallRow): Promise<TeamCallMove> {
  const updated = await transition(config, row, {
    to: 'ended',
    outcome: 'failed',
    columns: endColumns(row, { by: 'system', userId: null, reason: 'failed' }),
  });
  if (!updated) return unmoved(await reload(config, row));
  return { row: updated, moved: true, effects: announceTeamCall(config, updated, { actorId: null }) };
}

// ── The provider's word (LiveKit webhook) ─────────────────────────────────

/**
 * A room of a call that is over came back: LiveKit makes a room again when
 * someone joins it with a token that has not expired yet (`auto_create`), so
 * a member keeping a call's token could otherwise meet again in its room
 * after the end, with nothing counted (minutes, concurrency, busy) and past a
 * plan change. Its room is closed at once, which disconnects whoever is in
 * it; the shipped apps never rejoin an ended call. A call that is still live
 * (ringing, connecting, active) keeps its room. Best-effort: a close that
 * fails is logged, and the next join's webhook tries again. True when it
 * closed one.
 */
export async function closeRoomOfFinishedTeamCall(
  config: ServerConfig,
  callId: string,
  roomName: string | null | undefined,
): Promise<boolean> {
  const row = await loadTeamCall(config, callId);
  if (!row || !row.provider_room_id) return false;
  if ((TEAM_CALL_LIVE_STATES as readonly string[]).includes(row.state)) return false;
  if (roomName && roomName !== row.provider_room_id) return false;
  try {
    await resolveCallProvider(row.provider as CallProviderId).closeRoom(config, row.provider_room_id);
    return true;
  } catch (err) {
    console.warn('[team-call] closing the room of a finished call failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * A member joined the room: an answered call becomes active once both of its
 * members are in it (as the webhook has recorded them in call_participants,
 * identities resolved back to users). Throws on a failed read, so the webhook
 * answers non-2xx and LiveKit retries.
 */
export async function onTeamCallParticipantJoined(config: ServerConfig, callId: string): Promise<TeamCallMove | null> {
  const row = await loadTeamCall(config, callId);
  if (!row || row.state !== 'connecting') return row ? unmoved(row) : null;
  const meta = readTeamCallMeta(row);
  const { data, error } = await getServiceClient(config)
    .from('call_participants')
    .select('participant_id')
    .eq('call_session_id', row.id)
    .in('participant_id', [meta.caller_user_id, meta.callee_user_id])
    .is('left_at', null);
  if (error) throw new Error(`team_call_participants_read_failed: ${error.message}`);
  const inRoom = new Set(((data ?? []) as Array<{ participant_id: string | null }>).map((p) => p.participant_id));
  if (!inRoom.has(meta.caller_user_id) || !inRoom.has(meta.callee_user_id)) return unmoved(row);
  return activateTeamCall(config, row);
}

/** Both members are in the room: an answered call is active. */
async function activateTeamCall(config: ServerConfig, row: TeamCallRow): Promise<TeamCallMove> {
  if (row.state !== 'connecting') return unmoved(row);
  const updated = await transition(config, row, { to: 'active' });
  if (!updated) return unmoved(await reload(config, row));
  return { row: updated, moved: true, effects: announceTeamCall(config, updated, { actorId: null }) };
}

/**
 * A member left the room after the answer — hung up without telling the API,
 * or their app died: the call is over for both (completed). Before the answer
 * nobody is in the room, and an ended call stays as it ended. A connection
 * that a rejoin of the same member replaced is not a member leaving: the
 * webhook does not come here for it (livekitWebhook.ts).
 */
export async function onTeamCallParticipantLeft(config: ServerConfig, callId: string): Promise<TeamCallMove | null> {
  const row = await loadTeamCall(config, callId);
  if (!row) return null;
  return completeTeamCall(config, row, { by: 'system', userId: null, reason: 'system_ended' });
}

/**
 * The room closed (everyone gone, or nobody came within its empty timeout):
 * an answered call is completed. A call still ringing is the ticker's to
 * miss, and an ended row is never rewritten. The room check ends a call this
 * way too when it was answered long ago and nothing ever saw both members in
 * its room (teamCallTicker.ts, CONNECT_MAX_MS).
 */
export async function onTeamCallRoomFinished(config: ServerConfig, callId: string): Promise<TeamCallMove | null> {
  const row = await loadTeamCall(config, callId);
  if (!row) return null;
  return completeTeamCall(config, row, { by: 'system', userId: null, reason: 'system_ended' });
}

/**
 * Who the provider lists in an answered call's room, as the room check found
 * it (teamCallTicker.ts) — the webhook's word for a call whose webhook never
 * came: [membersInRoom] are the call's members (user ids) in the room now.
 *   - both are in: the call is on, and a call still `connecting` (its
 *     `participant_joined` lost) is `active`;
 *   - either is missing, or the room is gone: the call is over for both
 *     (completed), as a member leaving would have made it.
 */
export async function onTeamCallRoomListed(
  config: ServerConfig,
  row: TeamCallRow,
  membersInRoom: ReadonlySet<string>,
): Promise<TeamCallMove> {
  const meta = readTeamCallMeta(row);
  if (membersInRoom.has(meta.caller_user_id) && membersInRoom.has(meta.callee_user_id)) {
    return activateTeamCall(config, row);
  }
  return completeTeamCall(config, row, { by: 'system', userId: null, reason: 'system_ended' });
}

/**
 * A member's account is being deleted (DELETE /api/account): every colleague
 * call they are on — ringing, connecting or active, as caller or callee — is
 * hung up for them, with the move's usual effects (the rung phones stop,
 * the other member hears it, the call's line in the chat), before their
 * sessions go. Otherwise the colleague's phones ring on to the expiry, or
 * an answered call leaves them in an empty room. Covers every client (the
 * iPhone, Android and the web panel) alike. Resolves with the number of
 * calls ended; throws on a failed read.
 */
export async function endTeamCallsOfMember(config: ServerConfig, userId: string): Promise<number> {
  const sb = getServiceClient(config);
  const [asCaller, asCallee] = await Promise.all([
    sb.from('call_sessions').select(TEAM_CALL_COLUMNS)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .in('state', [...TEAM_CALL_LIVE_STATES])
      .eq('metadata->team_call->>caller_user_id', userId),
    sb.from('call_sessions').select(TEAM_CALL_COLUMNS)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .in('state', [...TEAM_CALL_LIVE_STATES])
      .eq('metadata->team_call->>callee_user_id', userId),
  ]);
  for (const read of [asCaller, asCallee]) {
    if (read.error) throw new Error(`team_call_read_failed: ${read.error.message}`);
  }
  const rows = new Map<string, TeamCallRow>();
  for (const row of [...(asCaller.data ?? []), ...(asCallee.data ?? [])] as unknown as TeamCallRow[]) {
    if (isTeamCallRow(row)) rows.set(row.id, row);
  }
  let ended = 0;
  for (const row of rows.values()) {
    const move = await hangUpTeamCall(config, row, userId);
    await move.effects;
    if (move.moved) ended += 1;
  }
  return ended;
}
