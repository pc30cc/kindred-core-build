/**
 * The Inbox's unread number (owner request of 2026-10-23, R4): how many
 * conversations wait with a visitor message nobody has read yet, for the
 * badge on Inbox in every web navigation (the classic sidebar, the Art shell,
 * the phone-width bottom bar) and the "(n) " in front of the tab's title.
 *
 * It counts CONVERSATIONS, not messages, and exactly the ones this operator's
 * Inbox shows by default: open, not spam, not handled by the AI on its own
 * (ai_state null or not ai_managed), assigned to nobody or to them. The scope
 * is always "mine", also for a supervisor who is watching "All": a badge
 * that counted colleagues' chats would never clear for them. A message is
 * unread while its `seen_at` is null (POST /:id/seen sets it when a member
 * opens the thread), so the number drops as soon as anyone reads the chat,
 * as the list's own unread counts do. Bot menu taps are navigation, not
 * messages (the list ignores them too), and a chat locked by the plan's
 * retention cannot be opened, so neither is counted. Colleagues' direct
 * messages keep their own badge (team chat).
 *
 * No migration: the messages are read through idx_conv_messages_unseen_visitor
 * (migration 239), a partial index on exactly `seen_at IS NULL AND
 * sender_type = 'contact'`. /inbox-counts is left alone: its RPC does far more
 * work, and the panel refreshes this number much more often.
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { coalesce } from '../lib/inflight.js';
import { selectInChunks } from '../lib/chunkedIn.js';
import { isConversationLocked, resolveContactChatLocks } from './contactChatLocks.js';
import { publishOperatorEvent } from './realtime/publish.js';

/** The most conversation ids an answer names (the panel drops one from it when that chat is read). */
export const UNREAD_IDS_CAP = 100;
/** The most open conversations examined, newest first: far more than an Inbox has open at once. */
const CONVERSATIONS_CAP = 1000;
/** Unread visitor messages read per chunk of conversations; one per conversation is enough. */
const MESSAGES_PER_CHUNK = 5000;

export interface InboxUnread {
  /** Conversations with at least one unread visitor message. */
  conversations: number;
  /** The first UNREAD_IDS_CAP of them, most recently active first. */
  ids: string[];
}

/**
 * A channel's menu or button tap, not something the visitor wrote. Older rows
 * may carry the flag as a boolean, and taps written before the flag existed
 * still carry `channel_menu_command`.
 */
export function isChannelMenuEvent(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta || {};
  return String(m.channel_menu_event ?? '') === 'true' || !!m.channel_menu_command;
}

/**
 * This operator's unread number in one workspace. Concurrent identical
 * requests (the sidebar, the shell and a realtime refresh at the same moment)
 * share one read. Throws when the conversations cannot be read; an unreadable
 * chunk of messages only counts nothing (selectInChunks logs it).
 */
export function loadInboxUnread(
  config: ServerConfig,
  a: { workspaceId: string; userId: string },
): Promise<InboxUnread> {
  return coalesce(`inbox_unread:${a.workspaceId}:${a.userId}`, async () => {
    const sb = getServiceClient(config);
    const [{ data, error }, locks] = await Promise.all([
      sb
        .from('conversations')
        .select('id, created_at, updated_at')
        .eq('workspace_id', a.workspaceId)
        .eq('status', 'open')
        .eq('is_spam', false)
        .or('ai_state.is.null,ai_state.neq.ai_managed')
        .or(`assigned_to.is.null,assigned_to.eq.${a.userId}`)
        .order('updated_at', { ascending: false })
        .limit(CONVERSATIONS_CAP),
      resolveContactChatLocks(config, a.workspaceId),
    ]);
    if (error) throw new Error(error.message);
    const open = ((data || []) as Array<{ id: string; created_at?: string | null; updated_at?: string | null }>)
      .filter((c) => c.id && !isConversationLocked(locks, c));
    if (open.length === 0) return { conversations: 0, ids: [] };

    const unseen = await selectInChunks<{ conversation_id: string; metadata: Record<string, unknown> | null }>(
      open.map((c) => c.id),
      (chunk) => sb
        .from('conversation_messages')
        .select('conversation_id, metadata')
        .in('conversation_id', chunk)
        .eq('sender_type', 'contact')
        .is('seen_at', null)
        .or('metadata->>channel_menu_event.is.null,metadata->>channel_menu_event.neq.true')
        .limit(MESSAGES_PER_CHUNK),
      'inbox unread',
    );
    const waiting = new Set<string>();
    for (const m of unseen) {
      if (m.conversation_id && !isChannelMenuEvent(m.metadata)) waiting.add(m.conversation_id);
    }
    // In the conversations' own order (most recently active first).
    const ids = open.map((c) => c.id).filter((id) => waiting.has(id));
    return { conversations: ids.length, ids: ids.slice(0, UNREAD_IDS_CAP) };
  });
}

/**
 * Someone read a conversation's visitor messages (POST /:id/seen marked at
 * least one): every operator's panel drops it from its unread number at once,
 * instead of at its next refetch. Operators only (the inbox channel, never
 * the conversation's, which the visitor's widget hears), with ids and a
 * moment, no names. Never throws: `seen_at` is the truth, and the next read
 * of the number shows it whatever happens here.
 */
export async function publishConversationSeen(
  config: ServerConfig,
  a: { workspaceId: string; conversationId: string; actorId: string; seenAt: string },
): Promise<void> {
  try {
    await publishOperatorEvent(
      config,
      {
        kind: 'conversation_seen',
        conversation_id: a.conversationId,
        workspace_id: a.workspaceId,
        actor_id: a.actorId,
        seen_at: a.seenAt,
      },
      { skipConversationChannel: true },
    );
  } catch (err) {
    console.warn('[inbox unread] conversation_seen publish failed:', (err as Error)?.message || err);
  }
}
