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
import { isConversationLocked, resolveContactChatLocks } from './contactChatLocks.js';
import { publishOperatorEvent } from './realtime/publish.js';

/** The most conversation ids an answer names (the panel drops one from it when that chat is read). */
export const UNREAD_IDS_CAP = 100;
/** The most open conversations examined, newest first: far more than an Inbox has open at once. */
const CONVERSATIONS_CAP = 1000;
/** Conversations asked about per read (the ids go in an IN list). */
const CONVERSATIONS_PER_READ = 50;
/**
 * Rows per read of unread visitor messages. Below every row cap a read can
 * meet (DATABASE_MAX_ROWS, 1000 by default, and Supabase's), so a page that
 * comes back short really is the last one.
 */
const MESSAGES_PER_READ = 500;

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
 * This operator's unread number in one workspace. Every request reads afresh,
 * never sharing one already running (lib/inflight's coalesce): the panel asks
 * again right after a write (POST /:id/seen, a visitor's message), and an
 * answer read before that write would keep the chat just opened on the badge
 * until the next event. The panel's own requests are already one per tab and
 * throttled. Throws when the conversations cannot be read; an unreadable read
 * of messages counts what was found until then (and logs it).
 */
export async function loadInboxUnread(
  config: ServerConfig,
  a: { workspaceId: string; userId: string },
): Promise<InboxUnread> {
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

  const waiting = await withUnreadVisitorMessage(sb, open.map((c) => c.id));
  // In the conversations' own order (most recently active first).
  const ids = open.map((c) => c.id).filter((id) => waiting.has(id));
  return { conversations: ids.length, ids: ids.slice(0, UNREAD_IDS_CAP) };
}

/**
 * Which of `ids` hold at least one unread visitor message (not a menu tap).
 * An existence check over the partial index: a full page is followed by
 * another read of just the conversations not found yet, so a chat with a thousand unread messages cannot crowd the
 * others out of the answer. Each full page finds at least one more
 * conversation, so it ends. An unreadable page counts what was found so far.
 */
async function withUnreadVisitorMessage(sb: ReturnType<typeof getServiceClient>, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += CONVERSATIONS_PER_READ) {
    let pending = ids.slice(i, i + CONVERSATIONS_PER_READ);
    while (pending.length) {
      const { data, error } = await sb
        .from('conversation_messages')
        .select('conversation_id, metadata')
        .in('conversation_id', pending)
        .eq('sender_type', 'contact')
        .is('seen_at', null)
        .or('metadata->>channel_menu_event.is.null,metadata->>channel_menu_event.neq.true')
        .is('metadata->>channel_menu_command', null)
        .limit(MESSAGES_PER_READ);
      if (error) {
        console.warn('[inbox unread] unread messages unreadable:', error.message);
        return found;
      }
      const rows = (data || []) as Array<{ conversation_id?: string | null; metadata?: Record<string, unknown> | null }>;
      const before = found.size;
      for (const r of rows) if (r.conversation_id && !isChannelMenuEvent(r.metadata)) found.add(r.conversation_id);
      // A short page was the last; a full one that found nobody new (taps the
      // filters let through) would only repeat itself.
      if (rows.length < MESSAGES_PER_READ || found.size === before) break;
      pending = pending.filter((id) => !found.has(id));
    }
  }
  return found;
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
