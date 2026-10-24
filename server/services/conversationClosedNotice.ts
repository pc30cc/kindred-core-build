/**
 * THE VISITOR-VISIBLE "CLOSED" LINE (issue #340, g1).
 *
 * When an operator closes a widget conversation (the inbox PATCH to
 * `closed`), the thread gets ONE system message the visitor sees: «Sara
 * closed the conversation», and under it, in a template that draws one, the
 * rating card (conversationRatings.ts). It is an ordinary
 * conversation_messages row, published live like the join notice:
 *
 *   sender_type 'system', body '<name> closed the conversation' (frozen
 *   English, for clients without a case for the kind, like join notices),
 *   metadata { kind: 'conversation_closed', by: 'agent', agent_id,
 *              agent_name, operator_id, operator_name, status }
 *
 * `agent_*` is who closed it, `operator_*` the operator assigned at the close
 * (else the closer): the one a rating is about.
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
 *     its rating card), see latestClosedRow. Two closes of one conversation
 *     at once are written one after the other in this process (`writing`),
 *     so they too leave one line.
 *
 * Never throws and is never awaited by the operator's request: the status
 * change is already saved, this is its echo.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient, type ServiceClient } from '../supabase.js';
import { buildMessageEnvelope, publishConversationEvent } from './realtime/publish.js';
import { resolveOperatorIdentities } from './widget/senderIdentity.js';
import { workspaceChatTemplate } from './widget/configSnapshot.js';
import { isWidgetConversation } from './widget/visitorConversations.js';

export const CONVERSATION_CLOSED_KIND = 'conversation_closed';

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
 * The widget applies the same rule before it draws a rating card.
 */
export function latestClosedRow<T extends ConversationRow>(rowsNewestFirst: T[]): T | null {
  for (const row of rowsNewestFirst) {
    const meta = metaOf(row);
    if (meta.internal === true) continue;
    if (row.sender_type !== 'system') return null;
    if (meta.kind === CONVERSATION_CLOSED_KIND) return row;
  }
  return null;
}

/** latestClosedRow over the conversation's newest rows (a failed read is none). */
export async function readLatestClosedRow(sb: ServiceClient, conversationId: string): Promise<ConversationRow | null> {
  const { data, error } = await sb
    .from('conversation_messages')
    .select('id, sender_type, body, created_at, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(RECENT_ROWS);
  if (error) throw error;
  return latestClosedRow((data || []) as ConversationRow[]);
}

// A widget conversation: no channel recorded, or the widget's own.
export { isWidgetConversation };

export interface ConversationClosedInput {
  workspaceId: string;
  conversationId: string;
  /** Who closed it (profiles.id). */
  actorId: string | null;
  by?: 'agent';
  /** Only a close draws the line (see above); anything else writes nothing. */
  status: 'closed';
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
    const sb = getServiceClient(config);
    const { data: conv, error: convErr } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to, metadata')
      .eq('id', input.conversationId)
      .maybeSingle();
    if (convErr || !conv || conv.workspace_id !== input.workspaceId) return null;
    if (!isWidgetConversation(conv.metadata)) return null;

    const template = await workspaceChatTemplate(config, input.workspaceId);
    if (!template.descriptor?.closedNotice) return null;

    if (await readLatestClosedRow(sb, input.conversationId)) return null;

    const operatorId = (conv.assigned_to as string | null) || input.actorId || null;
    const people = await resolveOperatorIdentities(config, sb, [input.actorId, operatorId]);
    const agentName = (input.actorId && people.get(input.actorId)?.name) || null;
    const operatorName = (operatorId && people.get(operatorId)?.name) || null;
    const metadata = {
      kind: CONVERSATION_CLOSED_KIND,
      by: input.by ?? 'agent',
      agent_id: input.actorId,
      agent_name: agentName,
      operator_id: operatorId,
      operator_name: operatorName,
      status: input.status,
    };
    const { data: row, error } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: input.conversationId,
        sender_type: 'system',
        body: `${agentName || 'An operator'} closed the conversation`,
        metadata,
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
        metadata: (row.metadata as Record<string, unknown>) ?? metadata,
        seen_at: (row as { seen_at?: string | null }).seen_at ?? null,
      }),
    );
    return { id: row.id as string };
  } catch (err) {
    console.warn('[conversationClosed] skipped:', (err as { message?: string } | null)?.message || err);
    return null;
  }
}
