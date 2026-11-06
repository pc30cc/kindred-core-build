/**
 * MESSAGE REACTIONS (issue #340 g2; migration 276).
 *
 * Storage and live news of the reactions the visitor's widget (Template 2's
 * badge and heart) and the inbox (chips and picker) show. The rules — which
 * emojis, who reacts to what — are shared/messageReactions.ts; the routes
 * check them before calling setMessageReaction:
 *
 *   - visitor: GET / POST /api/widget/conversations/:id/reactions
 *     (routes/widget.ts), ❤️ only, on the team's messages;
 *   - operator: POST /api/conversations/:id/messages/:messageId/reactions and
 *     the `reactions` / `can_react` fields of GET /api/conversations/:id/messages
 *     (routes/conversations.ts), on the visitor's messages, only where the
 *     visitor sees them (workspaceShowsReactions).
 *
 * One row per (message, actor, emoji) in conversation_message_reactions: the
 * visitor side as actor_type 'visitor' with no id, an operator by their user
 * id. A change touches the message's updated_at (276's trigger), so the
 * inbox's `?since=` sync returns it again. A change is published once, as an
 * operator event of kind `message_reactions` (the inbox channel whole, the
 * visitor's channel cut to WIDGET_EVENT_FIELDS): the message's new counts and
 * the moment they were read, never who reacted.
 *
 * Reactions are cosmetic: a read that fails is "none" and never fails the
 * caller. Before 276 reads are empty (`ready: false`) and a write answers
 * 'missing' (the routes' 503 migration_required), never a 500.
 */

import type { ServerConfig } from '../config.js';
import type { ServiceClient } from '../supabase.js';
import { publishOperatorEvent } from './realtime/publish.js';
import { isRelationMissing } from './billing/entitlementParse.js';
import { workspaceChatTemplate } from './widget/configSnapshot.js';
import { keyPage, readRows as readRowsPaged, readRowsByKey } from '../lib/pagedRows.js';
import {
  eventReactionList,
  summarizeReactions,
  type MessageReactionSummary,
  type ReactionActorType,
  type ReactionRow,
  type ReactionViewer,
} from '../../shared/messageReactions.js';

export const REACTIONS_TABLE = 'conversation_message_reactions';

export const REACTIONS_MIGRATION_REQUIRED = {
  error: 'Message reactions need database migration 276 (conversation_message_reactions).',
  code: 'migration_required',
} as const;

/**
 * The widget's reactions read covers the thread's newest this many messages
 * (GET /api/widget/conversations/:id/reactions). The widget shows the newest
 * 200 (/history, /poll) plus what arrives while it is open, and its client
 * clears the badge of any message the answer leaves out
 * (public/widget/runtime-late.js), so the window is well above what one
 * widget holds.
 */
export const WIDGET_REACTIONS_WINDOW = 1000;

/** conversation_message_reactions does not exist: migration 276 is not applied. */
export function isReactionsTableMissing(error: unknown): boolean {
  return isRelationMissing(error as { code?: string; message?: string }, REACTIONS_TABLE);
}

export interface ConversationReactions {
  /** Summaries of the messages that have any, for the reader. */
  byMessage: Map<string, MessageReactionSummary[]>;
  /** The table exists (migration 276). */
  ready: boolean;
}

type ReactionRowWithId = ReactionRow & { id: string };

/** Which rows a read takes: these messages of one conversation, or one message. */
type ReactionsScope =
  | { conversationId: string; messageIds: string[] }
  | { messageId: string };

/**
 * Every reaction row the filter selects, page by page by id: the data layer
 * cuts any one read at DATABASE_MAX_ROWS (1000 by default) without a word,
 * so a single read, even one asking `.limit(5000)`, used to drop every row
 * past the first 1000 (audit 2026-11-06). Reactions are cosmetic: a read that
 * fails is "none" and never fails the caller; before 276 it is `ready: false`.
 */
async function readRows(
  sb: ServiceClient,
  scope: ReactionsScope,
  viewer: ReactionViewer,
): Promise<ConversationReactions> {
  try {
    const { data, error } = await readRowsByKey<ReactionRowWithId>('id', (after, size) => {
      const rows = sb.from(REACTIONS_TABLE).select('id, message_id, emoji, actor_type, actor_id');
      const scoped = 'messageId' in scope
        ? rows.eq('message_id', scope.messageId)
        : rows.eq('conversation_id', scope.conversationId).in('message_id', scope.messageIds);
      return keyPage(scoped, 'id', after, size);
    });
    if (error) {
      if (isReactionsTableMissing(error)) return { byMessage: new Map(), ready: false };
      console.warn('[message-reactions] read failed:', (error as { message?: string }).message || error);
      return { byMessage: new Map(), ready: true };
    }
    return { byMessage: summarizeReactions(data, viewer), ready: true };
  } catch (err) {
    console.warn('[message-reactions] read failed:', (err as Error | null)?.message || err);
    return { byMessage: new Map(), ready: true };
  }
}

/**
 * The reactions of these messages of one conversation, all of them,
 * summarized per message for the reader: the messages a thread read answers
 * with (its page, an older page or a `?since` delta), so a reader never pays
 * for the whole conversation's reactions and never misses a new one. The
 * conversation filter stays: no constraint ties a reaction's conversation to
 * its message's, the routes do (setMessageReaction), so a read never goes by
 * message ids alone.
 */
export async function readMessagesReactions(
  sb: ServiceClient,
  conversationId: string,
  messageIds: Iterable<string>,
  viewer: ReactionViewer,
): Promise<ConversationReactions> {
  const ids = [...new Set([...messageIds].filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return { byMessage: new Map(), ready: true };
  return readRows(sb, { conversationId, messageIds: ids }, viewer);
}

/**
 * The reactions of a thread's newest WIDGET_REACTIONS_WINDOW messages, for
 * the visitor's widget (which shows only the newest ones). Its message read
 * failing reads as "none", as every reactions read.
 */
export async function readWidgetThreadReactions(
  sb: ServiceClient,
  conversationId: string,
  viewer: ReactionViewer,
): Promise<ConversationReactions> {
  const { data, error } = await readRowsPaged<{ id: string }>((from, to) => sb
    .from('conversation_messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to), WIDGET_REACTIONS_WINDOW);
  if (error) {
    console.warn('[message-reactions] window read failed:', error.message || error);
    return { byMessage: new Map(), ready: true };
  }
  return readMessagesReactions(sb, conversationId, data.map((m) => m.id), viewer);
}

/** One message's reactions for the reader (an empty list when it has none). */
export async function readMessageReactions(
  sb: ServiceClient,
  messageId: string,
  viewer: ReactionViewer,
): Promise<MessageReactionSummary[]> {
  const { byMessage } = await readRows(sb, { messageId }, viewer);
  return byMessage.get(messageId) ?? [];
}

export interface SetReactionInput {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  actorType: ReactionActorType;
  /** The operator's user id; null for the visitor. */
  actorId: string | null;
  /** An allow-listed emoji (normalizeReactionEmoji). */
  emoji: string;
  /** Set (true) or take back (false). */
  on: boolean;
}

/**
 * Sets or takes back one actor's reaction: 'changed', or 'unchanged' when it
 * already was so (setting one that is there — the unique key's 23505, also
 * when two tabs race — or taking back one that is not), so a retry is
 * harmless. 'missing' before migration 276; any other database error throws.
 */
export async function setMessageReaction(
  sb: ServiceClient,
  input: SetReactionInput,
): Promise<'changed' | 'unchanged' | 'missing'> {
  const actorId = input.actorType === 'visitor' ? null : input.actorId;
  if (input.actorType === 'operator' && !actorId) throw new Error('an operator reaction needs the operator');
  if (input.on) {
    const { error } = await sb.from(REACTIONS_TABLE).insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      actor_type: input.actorType,
      actor_id: actorId,
      emoji: input.emoji,
    });
    if (!error) return 'changed';
    if (isReactionsTableMissing(error)) return 'missing';
    if ((error as { code?: string }).code === '23505') return 'unchanged';
    throw error;
  }
  let q = sb
    .from(REACTIONS_TABLE)
    .delete()
    .eq('message_id', input.messageId)
    .eq('conversation_id', input.conversationId)
    .eq('actor_type', input.actorType)
    .eq('emoji', input.emoji);
  q = actorId ? q.eq('actor_id', actorId) : q.is('actor_id', null);
  const { data, error } = await q.select('id');
  if (error) {
    if (isReactionsTableMissing(error)) return 'missing';
    throw error;
  }
  return Array.isArray(data) && data.length > 0 ? 'changed' : 'unchanged';
}

/**
 * Tells everyone who has the thread open that a message's reactions changed:
 * one operator event `message_reactions` with the new counts. The inbox
 * channel gets it whole (an open thread re-reads its messages), the visitor's
 * channel the fields the widget reads (WIDGET_EVENT_FIELDS). `at` is when the
 * summary was read (taken before the read), so a reader keeps the newest.
 * Never throws (as every publish).
 */
export async function publishMessageReactions(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; messageId: string; reactions: MessageReactionSummary[]; at: number },
): Promise<void> {
  try {
    await publishOperatorEvent(config, {
      kind: 'message_reactions',
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      message_id: input.messageId,
      reactions: eventReactionList(input.reactions),
      at: input.at,
    });
  } catch (err) {
    console.warn('[message-reactions] publish failed:', (err as Error | null)?.message || err);
  }
}

/**
 * Whether the workspace's visitors see reactions: its EFFECTIVE chat template
 * (configSnapshot.ts workspaceChatTemplate: the catalog, the plan, the
 * choice, as GET /config serves it) draws them (descriptor `reactions`,
 * Template 2 today). The inbox offers React only then, so an operator never
 * reacts where the visitor cannot see it. From the cached snapshots (no query
 * on a hit); any failure is false.
 */
export async function workspaceShowsReactions(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    return (await workspaceChatTemplate(config, workspaceId)).descriptor?.reactions === true;
  } catch {
    return false;
  }
}
