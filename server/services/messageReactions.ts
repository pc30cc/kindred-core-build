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

/** Rows one conversation's read takes at most (6 emojis × a long thread). */
const MAX_ROWS = 5000;

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

async function readRows(
  sb: ServiceClient,
  column: 'conversation_id' | 'message_id',
  id: string,
  viewer: ReactionViewer,
): Promise<ConversationReactions> {
  try {
    const { data, error } = await sb
      .from(REACTIONS_TABLE)
      .select('message_id, emoji, actor_type, actor_id')
      .eq(column, id)
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS);
    if (error) {
      if (isReactionsTableMissing(error)) return { byMessage: new Map(), ready: false };
      console.warn('[message-reactions] read failed:', (error as { message?: string }).message || error);
      return { byMessage: new Map(), ready: true };
    }
    return { byMessage: summarizeReactions((data || []) as ReactionRow[], viewer), ready: true };
  } catch (err) {
    console.warn('[message-reactions] read failed:', (err as Error | null)?.message || err);
    return { byMessage: new Map(), ready: true };
  }
}

/** Every reaction of a conversation, summarized per message for the reader. */
export function readConversationReactions(
  sb: ServiceClient,
  conversationId: string,
  viewer: ReactionViewer,
): Promise<ConversationReactions> {
  return readRows(sb, 'conversation_id', conversationId, viewer);
}

/** One message's reactions for the reader (an empty list when it has none). */
export async function readMessageReactions(
  sb: ServiceClient,
  messageId: string,
  viewer: ReactionViewer,
): Promise<MessageReactionSummary[]> {
  const { byMessage } = await readRows(sb, 'message_id', messageId, viewer);
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
