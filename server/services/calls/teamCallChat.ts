/**
 * The call in the chat (owner, 2026-11-02; docs/operations/TEAM_CALLS.md,
 * "The call in the chat"): every colleague call leaves one line in the two
 * members' team chat, as WhatsApp does.
 *
 *   - Written once, by the server, when the call reaches its end (its state
 *     is no longer one of TEAM_CALL_LIVE_STATES), from announceTeamCall
 *     (teamCallLifecycle.ts), whichever path ended it. Each end is a
 *     compare-and-set from a live state, so only one move per call gets here;
 *     the unique key on `team_messages.call_session_id` (migration 294) makes
 *     a second attempt do nothing all the same.
 *   - Best-effort: it never throws, and a database without migration 294
 *     (the column missing) only logs.
 *   - The line: from the caller to the callee, placed where the call rang
 *     (`created_at` the call's), with a language-neutral body for apps that
 *     predate it (`📞`/`📹`, and the duration of a completed call). A missed
 *     or cancelled call is unread for the callee (their badge counts it);
 *     every other outcome is read when written.
 *   - Then the same realtime nudge a sent message gives (`team_message`, ids
 *     only) to both members. No team-message push: a missed call has its own.
 *
 * The team-chat reads (server/routes/teamChat.ts) add `call` to each line
 * (teamCallChatViews below): the call's id, channel, outcome, duration and
 * caller, and nothing else of its row.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isMissingColumnError } from '../../lib/missingColumn.js';
import { publishTeamEvent } from '../realtime/publish.js';
import {
  TEAM_CALL_ENTRY_SOURCE,
  TEAM_CALL_LIVE_STATES,
  readTeamCallMeta,
  type TeamCallChannel,
  type TeamCallOutcome,
  type TeamCallRow,
} from './teamCall.js';

type Db = ReturnType<typeof getServiceClient>;

/** `call` on a team-chat message: the call a line stands for, as the apps draw it. */
export interface TeamCallChatView {
  id: string;
  channel: TeamCallChannel;
  outcome: TeamCallOutcome;
  /** ended_at − connected_at, in seconds, for a completed call; null otherwise. */
  duration_seconds: number | null;
  /** Who placed the call (the line's sender). */
  caller_id: string;
}

/** The columns of a call row the chat line and its `call` are made from. */
export type TeamCallChatRow = Pick<
  TeamCallRow,
  'id' | 'workspace_id' | 'call_type' | 'state' | 'initiated_by' | 'metadata' | 'created_at' | 'connected_at' | 'ended_at'
>;

const CALL_ROW_COLUMNS = 'id, workspace_id, call_type, state, entry_source, initiated_by, metadata, created_at, connected_at, ended_at';

/** The voice and video marks of the body, as the contract names them (U+1F4DE, U+1F4F9). */
const VOICE_MARK = '\u{1F4DE}';
const VIDEO_MARK = '\u{1F4F9}';

function isLive(state: string): boolean {
  return (TEAM_CALL_LIVE_STATES as readonly string[]).includes(state);
}

/**
 * How the call ended. The row's own `metadata.team_call.outcome`, which every
 * end writes with its state; for a row without one, what its state says.
 */
export function teamCallChatOutcome(row: Pick<TeamCallChatRow, 'state' | 'connected_at' | 'metadata' | 'initiated_by' | 'call_type'>): TeamCallOutcome {
  const outcome = readTeamCallMeta(row).outcome;
  if (outcome) return outcome;
  if (row.state === 'missed') return 'missed';
  if (row.state === 'cancelled') return 'cancelled';
  return row.connected_at ? 'completed' : 'failed';
}

/** How long a completed call was connected, in whole seconds; null for any other outcome. */
export function teamCallChatDuration(
  row: Pick<TeamCallChatRow, 'connected_at' | 'ended_at'>,
  outcome: TeamCallOutcome,
): number | null {
  if (outcome !== 'completed') return null;
  const from = Date.parse(row.connected_at ?? '');
  const to = Date.parse(row.ended_at ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 1000));
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTeamCallDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The line's body, for apps that predate `call`: the mark, and the duration of a completed call. */
export function teamCallChatBody(channel: TeamCallChannel, durationSeconds: number | null): string {
  const mark = channel === 'video' ? VIDEO_MARK : VOICE_MARK;
  return durationSeconds === null ? mark : `${mark} ${formatTeamCallDuration(durationSeconds)}`;
}

/** `call` for a line of [row]. */
export function teamCallChatView(row: TeamCallChatRow): TeamCallChatView {
  const meta = readTeamCallMeta(row);
  const outcome = teamCallChatOutcome(row);
  return {
    id: row.id,
    channel: meta.channel,
    outcome,
    duration_seconds: teamCallChatDuration(row, outcome),
    caller_id: meta.caller_user_id,
  };
}

/**
 * The team_messages row a call that is over leaves, or null for a call that
 * is still live or has no two members to write between.
 */
export function teamCallChatLine(row: TeamCallChatRow, now: Date = new Date()): Record<string, unknown> | null {
  if (isLive(row.state)) return null;
  const meta = readTeamCallMeta(row);
  if (!meta.caller_user_id || !meta.callee_user_id || meta.caller_user_id === meta.callee_user_id) return null;
  const view = teamCallChatView(row);
  const unread = view.outcome === 'missed' || view.outcome === 'cancelled';
  return {
    workspace_id: row.workspace_id,
    sender_id: meta.caller_user_id,
    recipient_id: meta.callee_user_id,
    body: teamCallChatBody(view.channel, view.duration_seconds),
    attachment_id: null,
    reply_to_id: null,
    read_at: unread ? null : now.toISOString(),
    created_at: row.created_at,
    call_session_id: row.id,
  };
}

/** What writing a call's line came to: its realtime nudge, under way (settled at once when nothing was written). */
export interface TeamCallLineWrite {
  nudged: Promise<void>;
}

const NOT_WRITTEN: TeamCallLineWrite = { nudged: Promise.resolve() };

/**
 * Writes the line of a call that is over, once, and starts telling both
 * members. Resolves as soon as the write is done — the missed-call alert
 * waits for that much (its badge counts the line), never for the realtime
 * nudge — and never rejects: a failure (the column missing included) only
 * logs, and a line already there (a second attempt) does nothing, not even
 * the nudge.
 */
export async function writeTeamCallLine(config: ServerConfig, row: TeamCallChatRow): Promise<TeamCallLineWrite> {
  try {
    const line = teamCallChatLine(row);
    if (!line) return NOT_WRITTEN;
    const { data, error } = await getServiceClient(config)
      .from('team_messages')
      .upsert(line, { onConflict: 'call_session_id', ignoreDuplicates: true })
      .select('id');
    if (error) {
      if (isMissingColumnError(error, ['call_session_id'])) {
        console.warn('[team-call] chat line not written: team_messages.call_session_id is missing (migration 294 not applied)');
      } else {
        console.warn('[team-call] chat line not written:', (error as { message?: string }).message ?? String(error));
      }
      return NOT_WRITTEN;
    }
    const written = (Array.isArray(data) ? data[0] : data) as { id?: string } | null | undefined;
    if (!written?.id) return NOT_WRITTEN; // the call's line was already there
    // publishTeamEvent never rejects.
    const nudged = publishTeamEvent(config, [String(line.recipient_id), String(line.sender_id)], {
      kind: 'team_message',
      workspace_id: row.workspace_id,
      message_id: written.id,
      sender_id: String(line.sender_id),
      recipient_id: String(line.recipient_id),
    });
    return { nudged };
  } catch (err) {
    console.warn('[team-call] chat line failed:', err instanceof Error ? err.message : String(err));
    return NOT_WRITTEN;
  }
}

/** writeTeamCallLine, and its nudge sent. Never rejects. */
export async function recordTeamCallInChat(config: ServerConfig, row: TeamCallChatRow): Promise<void> {
  const { nudged } = await writeTeamCallLine(config, row);
  await nudged;
}

/** A team-chat message as far as its `call` goes. */
interface MessageWithCall {
  id: string;
  sender_id: string;
  recipient_id: string;
  call_session_id?: string | null;
}

/**
 * `call` for each of [messages] that stands for a colleague call, by message
 * id, in one read of their calls. Only a call of this workspace, over, whose
 * caller sent the line to its callee, is shown; a message whose call is gone
 * or does not match is left without one. A failed read leaves them all
 * without one (the body still reads).
 */
export async function teamCallChatViews(
  sb: Db,
  workspaceId: string,
  messages: readonly MessageWithCall[],
): Promise<Map<string, TeamCallChatView>> {
  const out = new Map<string, TeamCallChatView>();
  const callIds = Array.from(new Set(
    messages.map((m) => m.call_session_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));
  if (!callIds.length) return out;
  const { data, error } = await sb
    .from('call_sessions')
    .select(CALL_ROW_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
    .in('id', callIds);
  if (error) {
    console.warn('[team-chat] call lines read failed:', (error as { message?: string }).message ?? String(error));
    return out;
  }
  const byId = new Map<string, TeamCallChatRow>();
  for (const row of (data ?? []) as Array<TeamCallChatRow & { entry_source?: string | null }>) {
    if (row.workspace_id === workspaceId && row.entry_source === TEAM_CALL_ENTRY_SOURCE && !isLive(row.state)) {
      byId.set(row.id, row);
    }
  }
  for (const m of messages) {
    const row = m.call_session_id ? byId.get(m.call_session_id) : undefined;
    if (!row) continue;
    const meta = readTeamCallMeta(row);
    if (m.sender_id !== meta.caller_user_id || m.recipient_id !== meta.callee_user_id) continue;
    out.set(m.id, teamCallChatView(row));
  }
  return out;
}
