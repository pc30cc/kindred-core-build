/**
 * "X joined the conversation", written right before X's first message
 * (owner, 2026-10-23): when a chat goes from the AI to an operator, the
 * visitor reads who joined first, then what they wrote.
 *
 * Only the operator's reply writes it (POST /api/conversations/send-message).
 * Assignments write nothing the visitor sees: routing, a claim or a transfer
 * named people who had not written yet, and an assignment that came after
 * the operator's first message put the line under it.
 *
 * It is owed once per human stretch: from the newest AI message to now (a
 * smart rule's `bot` opening does not end it). An operator is introduced in
 * the stretch by their own message, or by a visitor-visible join or transfer
 * naming them (rows written before this, which keep their line). A thread
 * the visitor has not written in yet (Visitors → Start chat) gets no line:
 * the operator opens it.
 *
 * The check, the line and the reply run under one lock per conversation, and
 * the line is its own INSERT before the reply's, so it is strictly earlier
 * (/poll and /history sort by created_at), and its publish is awaited before
 * the reply's (the widget appends in arrival order).
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { buildMessageEnvelope, publishConversationEvent } from './realtime/publish.js';
import { onSupportConversationChanged } from './platformSupport/changes.js';
import { agentJoinedBody, resolveAgentDisplayName } from './chatRouting.js';

/** How many of the newest messages the check reads. */
export const JOIN_WINDOW = 200;

/** A message as the check reads it. */
export interface JoinWindowRow {
  id?: string | null;
  sender_type?: string | null;
  sender_id?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The join row written, as the realtime envelope needs it. */
export interface ReplyJoinRow {
  id: string;
  conversation_id: string;
  sender_type: 'system';
  body: string;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
  seen_at: string | null;
}

/**
 * A row's time in microseconds: the database keeps them, and the AI's
 * message and an operator's can fall in the same millisecond. -Infinity when
 * unreadable (it sorts last).
 */
function microsOf(value: unknown): number {
  if (value instanceof Date) return value.getTime() * 1000;
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return Number.NEGATIVE_INFINITY;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return ms * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

function newestFirst(a: JoinWindowRow, b: JoinWindowRow): number {
  const byTime = microsOf(b.created_at) - microsOf(a.created_at);
  if (byTime) return byTime;
  const ida = String(a.id ?? '');
  const idb = String(b.id ?? '');
  return ida < idb ? 1 : ida > idb ? -1 : 0;
}

/** A visitor-visible join or transfer naming `userId`. */
function introduces(metadata: unknown, userId: string): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as Record<string, unknown>;
  if (meta.internal === true) return false;
  return (meta.kind === 'routing_agent_joined' && meta.agent_id === userId)
    || (meta.kind === 'conversation_transferred' && meta.to_id === userId);
}

/**
 * Whether `userId`'s reply owes the visitor a join line first, from the
 * conversation's newest messages (any order). `windowFull`: the window may
 * not reach back to the visitor's first message, so they are taken to have
 * written.
 */
export function joinOwed(rows: readonly JoinWindowRow[], userId: string, windowFull: boolean): boolean {
  let sawContact = false;
  let inStretch = true;
  for (const row of rows.slice().sort(newestFirst)) {
    if (row.sender_type === 'contact') sawContact = true;
    if (!inStretch) continue;
    if (row.sender_type === 'ai') inStretch = false;
    else if (row.sender_type === 'agent' && row.sender_id === userId) return false;
    else if (row.sender_type === 'system' && introduces(row.metadata, userId)) return false;
  }
  return sawContact || windowFull;
}

/**
 * The tail of each conversation's queue of replies. The backend (WebYar's
 * app 25, RESPOK's 32) is one Node process, and routing and every reply run
 * in it, so an in-process lock is enough: two different messages from the
 * same operator sent at once write one line between them.
 */
const replyTails = new Map<string, Promise<void>>();

/**
 * Waits for the conversation's earlier replies to pass the check and their
 * insert (first come, first served), or `maxWaitMs`, whichever comes first:
 * a stalled database call holds a conversation's replies no longer than
 * that. Returns the release, which is safe to call more than once.
 */
export async function lockConversationReplies(conversationId: string, maxWaitMs = 5000): Promise<() => void> {
  const previous = replyTails.get(conversationId);
  let open: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => { open = resolve; });
  replyTails.set(conversationId, mine);
  if (previous) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([previous, new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); })]);
    clearTimeout(timer);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    if (replyTails.get(conversationId) === mine) replyTails.delete(conversationId);
  };
}

/**
 * Writes "X joined" when X's reply owes one (joinOwed), named as routing
 * names people (resolveAgentDisplayName: the full name, or none and each
 * reader's generic sentence). Returns the row, or null when none is owed or
 * it could not be written. Never throws: the reply goes out either way.
 */
export async function introduceOperatorBeforeReply(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; userId: string },
): Promise<ReplyJoinRow | null> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('conversation_messages')
      .select('id, sender_type, sender_id, created_at, metadata')
      .eq('conversation_id', a.conversationId)
      .order('created_at', { ascending: false })
      .limit(JOIN_WINDOW);
    if (error) throw new Error(error.message);
    const rows = (data || []) as JoinWindowRow[];
    if (!joinOwed(rows, a.userId, rows.length >= JOIN_WINDOW)) return null;
    const name = await resolveAgentDisplayName(config, a.userId);
    const { data: row, error: insertError } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: a.conversationId,
        sender_type: 'system',
        body: agentJoinedBody(name),
        metadata: { kind: 'routing_agent_joined', agent_id: a.userId, agent_name: name },
      })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .single();
    if (insertError || !row) throw new Error(insertError?.message || 'insert returned no row');
    return row as unknown as ReplyJoinRow;
  } catch (err) {
    console.warn('[operator-reply-join] no join line for', a.workspaceId, a.conversationId, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The line reaches the visitor (and the inboxes) live. Awaited by the caller
 * before the reply's own publish, so it arrives first. A platform-support
 * thread's operator sees who joined too. Never throws.
 */
export async function publishReplyJoin(config: ServerConfig, workspaceId: string, row: ReplyJoinRow): Promise<void> {
  try {
    await publishConversationEvent(config, workspaceId, row.conversation_id, buildMessageEnvelope({ ...row, sender_type: 'system' }));
  } catch (err) {
    console.warn('[operator-reply-join] publish failed:', err instanceof Error ? err.message : err);
  }
  void onSupportConversationChanged(config, { workspaceId, conversationId: row.conversation_id });
}

/** Takes back a line whose reply was not written by this request. Never throws. */
export async function dropReplyJoin(config: ServerConfig, id: string): Promise<void> {
  try {
    const { error } = await getServiceClient(config).from('conversation_messages').delete().eq('id', id);
    if (error) console.warn('[operator-reply-join] could not take back', id, error.message);
  } catch (err) {
    console.warn('[operator-reply-join] could not take back', id, err instanceof Error ? err.message : err);
  }
}
