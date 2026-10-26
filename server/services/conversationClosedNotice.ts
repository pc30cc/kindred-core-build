/**
 * THE VISITOR-VISIBLE "CLOSED" LINE (issue #340, g1; the inactivity close,
 * migration 284).
 *
 * When a widget conversation is closed, the thread gets ONE system message
 * the visitor sees, and under it, in a template that draws one, the rating
 * card (conversationRatings.ts). It is an ordinary conversation_messages row,
 * published live like the join notice. Two kinds of close write it:
 *
 *   an operator's (the inbox PATCH to `closed`): «Sara closed the conversation»
 *     sender_type 'system', body '<name> closed the conversation' (frozen
 *     English, for clients without a case for the kind, like join notices),
 *     metadata { kind: 'conversation_closed', by: 'agent', agent_id,
 *                agent_name, operator_id, operator_name, status };
 *   the system's, after the quiet period (conversationIdleCloseTicker.ts):
 *     the widget's «گفتگو به پایان رسید», with no name
 *     body 'The conversation was closed', metadata { kind:
 *     'conversation_closed', by: 'system', closed_reason: 'inactivity',
 *     agent_id: null, agent_name: null, operator_id, operator_name, status }.
 *     prepareClosedLine only prepares it: the row is inserted by the SQL
 *     close (conversation_close_if_idle, migration 284) in the transaction
 *     that closes the conversation, and the ticker publishes it. The widget
 *     draws the nameless sentence because agent_name is empty
 *     (presentation-default.js, presentation-t1-x.js and presentation-t2-x.js
 *     read `metadata.agent_name`), and every native localizer prints its
 *     nameless one.
 *
 * `agent_*` is who closed it (nobody, for the system), `operator_*` the one a
 * rating is about (ratedOperatorOf, the same for both kinds): the assignee if
 * they wrote in the conversation, else the newest person who wrote, else (an
 * operator's close only) the closer, else nobody (an AI-only conversation:
 * its card asks about the conversation, with the workspace mark). The
 * visitor's copy never carries the ids (realtime/publish.ts
 * visitorMessageMetadata strips agent_id and operator_id).
 *
 * Written only when:
 *   - the new status is `closed` (owner, 2026-10-24). "Resolve" and "Send &
 *     resolve" take the conversation out of the operator's Inbox only: the
 *     visitor sees nothing, and their next message reopens the same
 *     conversation (services/widget/visitorConversations.ts: open, pending
 *     and resolved are live for the visitor, closed alone has ended). So a
 *     resolve writes no line and no rating card;
 *   - the conversation is a widget one (no `metadata.channel`, or 'widget'):
 *     never Telegram, Bale, WhatsApp, Instagram, email or platform support;
 *   - the workspace's EFFECTIVE chat template (configSnapshot.ts
 *     workspaceChatTemplate: the catalog, the plan, the choice) draws it
 *     (descriptor `closedNotice`, shared/widgetTemplates.ts). A workspace
 *     whose template does not gets no new row at all, so its visitors'
 *     threads, lists and unread counts are exactly what they were;
 *   - the thread has moved on since the last such line: a close right after a
 *     reopen with nothing said in between reuses the line already there (and
 *     its rating card), see latestClosedRow. A line an older server wrote on
 *     a resolve is not one: the close writes its own. When the visitor
 *     already rated that resolve line and nothing was said since, it was
 *     this same closure for them: the new line carries that rating
 *     (`rated_line_id`, conversationRatings.ts), so no second card asks and
 *     CSAT counts one rating. Two operator closes of one conversation at
 *     once are written one after the other in this process (`writing`), so
 *     they too leave one line.
 *
 * Never throws and is never awaited by the operator's request: the status
 * change is already saved, this is its echo.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient, type ServiceClient } from '../supabase.js';
import { buildMessageEnvelope, publishConversationEvent } from './realtime/publish.js';
import { resolveOperatorIdentities } from './widget/senderIdentity.js';
import { workspaceChatTemplate } from './widget/configSnapshot.js';
import { isResolveClosedLine, isWidgetConversation } from './widget/visitorConversations.js';
import { isRelationMissing } from './billing/entitlementParse.js';

export const CONVERSATION_CLOSED_KIND = 'conversation_closed';

/** The system close's frozen English body (shared/systemMessageText.ts's nameless sentence). */
export const SYSTEM_CLOSED_BODY = 'The conversation was closed';

/** How many of the newest rows latestClosedRow looks through. */
const RECENT_ROWS = 20;

export interface ConversationRow {
  id: string;
  sender_type: string | null;
  body?: string | null;
  created_at: string;
  metadata?: unknown;
}

function metaOf(row: { metadata?: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
}

/**
 * The closed line the thread ends with, from rows newest first: the newest
 * `conversation_closed` row with no visitor, operator or AI message after it.
 * Other system rows (a join notice, a call note) and inbox-only rows do not
 * move the thread on; anything somebody said does, and then there is none.
 * The widget applies the same rule before it draws a rating card. A line an
 * older server wrote on "Resolve" is none (isResolveClosedLine): the visitor
 * no longer sees it, so neither a rating nor a later close goes by it.
 */
export function latestClosedRow<T extends ConversationRow>(rowsNewestFirst: T[]): T | null {
  for (const row of rowsNewestFirst) {
    const meta = metaOf(row);
    if (meta.internal === true) continue;
    if (row.sender_type !== 'system') return null;
    if (meta.kind === CONVERSATION_CLOSED_KIND && !isResolveClosedLine(meta)) return row;
  }
  return null;
}

/**
 * The line an older server wrote on "Resolve" (isResolveClosedLine) that the
 * thread still ends with, by the same rule as latestClosedRow, or null.
 */
export function latestResolveLine<T extends ConversationRow>(rowsNewestFirst: T[]): T | null {
  for (const row of rowsNewestFirst) {
    const meta = metaOf(row);
    if (meta.internal === true) continue;
    if (row.sender_type !== 'system') return null;
    if (isResolveClosedLine(meta)) return row;
  }
  return null;
}

/** The conversation's newest rows, newest first (the ones latestClosedRow reads). */
async function readRecentRows(sb: ServiceClient, conversationId: string): Promise<ConversationRow[]> {
  const { data, error } = await sb
    .from('conversation_messages')
    .select('id, sender_type, body, created_at, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(RECENT_ROWS);
  if (error) throw error;
  return (data || []) as ConversationRow[];
}

/** latestClosedRow over the conversation's newest rows (a failed read throws). */
export async function readLatestClosedRow(sb: ServiceClient, conversationId: string): Promise<ConversationRow | null> {
  return latestClosedRow(await readRecentRows(sb, conversationId));
}

/** Whether the visitor rated this closed line (before migration 276: no; a failed read throws). */
async function lineWasRated(sb: ServiceClient, conversationId: string, closedId: string): Promise<boolean> {
  const { data, error } = await sb
    .from('conversation_ratings')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('closed_message_id', closedId)
    .maybeSingle();
  if (error) {
    if (isRelationMissing(error, 'conversation_ratings')) return false;
    throw error;
  }
  return !!data;
}

/**
 * Who a closure's rating is about (decision 15, every kind of close): the
 * assignee if they wrote in the conversation (an agent row of theirs), else
 * the newest person who wrote, else the closer (`closerId`: an operator's
 * close only), else nobody. An assignee who never wrote gets no credit for
 * someone else's answers. Two indexed reads at most.
 */
export async function ratedOperatorOf(
  sb: ServiceClient,
  conv: { id: string; assigned_to?: string | null },
  closerId?: string | null,
): Promise<string | null> {
  const assignee = conv.assigned_to || null;
  if (assignee) {
    const { data, error } = await sb
      .from('conversation_messages')
      .select('id')
      .eq('conversation_id', conv.id)
      .eq('sender_type', 'agent')
      .eq('sender_id', assignee)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return assignee;
  }
  const { data: newest, error } = await sb
    .from('conversation_messages')
    .select('sender_id')
    .eq('conversation_id', conv.id)
    .eq('sender_type', 'agent')
    .not('sender_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const writer = (newest as { sender_id?: string | null } | null)?.sender_id || null;
  return writer || closerId || null;
}

// A widget conversation: no channel recorded, or the widget's own.
export { isWidgetConversation };

export interface ConversationClosedInput {
  workspaceId: string;
  conversationId: string;
  /** Who closed it (profiles.id); null for the system. */
  actorId: string | null;
  /** 'agent': an operator's close (the default); 'system': the inactivity close. */
  by?: 'agent' | 'system';
  /** Only a close draws the line (see above); anything else writes nothing. */
  status: 'closed';
}

/** A closed line ready to insert: its body and metadata. */
export interface PreparedClosedLine {
  body: string;
  metadata: Record<string, unknown>;
}

/**
 * The closed line a close would write now, or null when none is due (not a
 * widget conversation of this workspace, a template without the line, or the
 * thread already ends with one: latestClosedRow). Reads only. A failed read
 * THROWS, never reads as "none due": the system's close would otherwise go
 * ahead without its line, and a closed conversation never gets one later, so
 * the ticker leaves that conversation for its next pass
 * (conversationIdleCloseTicker.ts). The operator's close inserts the line
 * below (writeClosedLine logs a failure and writes none); the system's hands
 * it to conversation_close_if_idle.
 */
export async function prepareClosedLine(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; actorId?: string | null; by: 'agent' | 'system' },
): Promise<PreparedClosedLine | null> {
  const sb = getServiceClient(config);
  const { data: conv, error: convErr } = await sb
    .from('conversations')
    .select('id, workspace_id, assigned_to, metadata')
    .eq('id', input.conversationId)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv || conv.workspace_id !== input.workspaceId) return null;
  if (!isWidgetConversation(conv.metadata)) return null;

  const template = await workspaceChatTemplate(config, input.workspaceId);
  if (!template.descriptor?.closedNotice) return null;

  const recent = await readRecentRows(sb, input.conversationId);
  if (latestClosedRow(recent)) return null;
  // The closure the visitor rated under an older server's resolve line,
  // nothing said since: this line keeps that rating.
  const resolveLine = latestResolveLine(recent);
  const ratedLineId = resolveLine && await lineWasRated(sb, input.conversationId, resolveLine.id) ? resolveLine.id : null;

  const system = input.by === 'system';
  const actorId = system ? null : input.actorId ?? null;
  const operatorId = await ratedOperatorOf(sb, conv as { id: string; assigned_to?: string | null }, actorId);
  const people = await resolveOperatorIdentities(config, sb, [actorId, operatorId]);
  const agentName = (actorId && people.get(actorId)?.name) || null;
  const operatorName = (operatorId && people.get(operatorId)?.name) || null;
  const carried = ratedLineId ? { rated_line_id: ratedLineId } : {};
  if (system) {
    return {
      body: SYSTEM_CLOSED_BODY,
      metadata: {
        kind: CONVERSATION_CLOSED_KIND,
        by: 'system',
        closed_reason: 'inactivity',
        agent_id: null,
        agent_name: null,
        operator_id: operatorId,
        operator_name: operatorName,
        status: 'closed',
        ...carried,
      },
    };
  }
  return {
    body: `${agentName || 'An operator'} closed the conversation`,
    metadata: {
      kind: CONVERSATION_CLOSED_KIND,
      by: 'agent',
      agent_id: actorId,
      agent_name: agentName,
      operator_id: operatorId,
      operator_name: operatorName,
      status: 'closed',
      ...carried,
    },
  };
}

/**
 * The close of each conversation being written in this process. A second
 * close of the same conversation (two operators' PATCHes landing together, a
 * PATCH next to a "Send & resolve") waits for the first, so its "is the line
 * already there" read sees the row the first one wrote: never two lines.
 */
const writing = new Map<string, Promise<{ id: string } | null>>();

/**
 * Writes and publishes the closed line when the rules above allow it.
 * Returns the new row's id, or null when none was written (not a close, not a
 * widget conversation, a template without the line, the line already there,
 * or any failure).
 */
export function recordConversationClosed(
  config: ServerConfig,
  input: ConversationClosedInput,
): Promise<{ id: string } | null> {
  if ((input.status as string) !== 'closed') return Promise.resolve(null);
  const key = input.conversationId;
  const before = writing.get(key);
  // writeClosedLine never rejects, so neither does the chain.
  const run = (before ? before.then(() => writeClosedLine(config, input)) : writeClosedLine(config, input));
  writing.set(key, run);
  void run.then(() => { if (writing.get(key) === run) writing.delete(key); });
  return run;
}

async function writeClosedLine(
  config: ServerConfig,
  input: ConversationClosedInput,
): Promise<{ id: string } | null> {
  try {
    const line = await prepareClosedLine(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      actorId: input.actorId,
      by: input.by ?? 'agent',
    });
    if (!line) return null;
    const sb = getServiceClient(config);
    const { data: row, error } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: input.conversationId,
        sender_type: 'system',
        body: line.body,
        metadata: line.metadata,
      })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .single();
    if (error || !row) {
      if (error) console.warn('[conversationClosed] insert failed:', error.message);
      return null;
    }
    void publishConversationEvent(
      config, input.workspaceId, input.conversationId,
      buildMessageEnvelope({
        id: row.id as string,
        conversation_id: row.conversation_id as string,
        sender_type: 'system',
        body: row.body as string,
        created_at: row.created_at as string | null,
        metadata: (row.metadata as Record<string, unknown>) ?? line.metadata,
        seen_at: (row as { seen_at?: string | null }).seen_at ?? null,
      }),
    );
    return { id: row.id as string };
  } catch (err) {
    console.warn('[conversationClosed] skipped:', (err as { message?: string } | null)?.message || err);
    return null;
  }
}
