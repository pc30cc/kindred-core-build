/**
 * The Inbox list's per-row summary: each listed conversation's last message,
 * last visitor message, unread count, the members who wrote in it
 * (handled_by), needs_reply and waiting_since (GET /api/conversations and
 * GET /:id, routes/conversations.ts listConversationRows).
 *
 * Read with conversation_list_summaries() (migration 303): every row from
 * its own conversation, complete. Before 303, or when that read fails, the
 * old way: ONE window of the newest LIST_MESSAGE_WINDOW messages of all the
 * listed conversations together, in which a busy conversation pushes the
 * others out (their summary then reads empty). Both give the same shapes.
 *
 * needs_reply / waiting_since follow services/needsReply.ts
 * (computeNeedsReply, computeWaitingSince); 303 does it with
 * conversation_message_turn(), its SQL twin (migration 286).
 */

import type { ServiceClient } from '../supabase.js';
import { readRows } from '../lib/pagedRows.js';
import { isChannelMenuEvent } from './inboxUnread.js';
import { isActionableCustomerTurn, isQualifiedCustomerFacingAnswer, type NeedsReplyMessage } from './needsReply.js';
import { operatorSystemText, withoutPlaceholderNames } from './operatorSystemText.js';

/** Newest messages the fallback window reads for its previews, unread and needs-reply. */
export const LIST_MESSAGE_WINDOW = 2000;

export interface ListPreview {
  body: string;
  created_at: string;
  sender_type: string;
  sender_id?: string | null;
  sender_name?: string | null;
  attachment_id?: string | null;
  attachment_kind?: 'image' | 'audio' | 'video' | 'file' | null;
  system_kind?: string | null;
  system_meta?: Record<string, unknown> | null;
}

export interface ListVisitorMessage {
  body: string;
  created_at: string;
  seen_at: string | null;
}

export interface ListSummaries {
  /** How they were read: 'rpc' (303, complete) or 'window' (the fallback). */
  source: 'rpc' | 'window';
  lastByConv: Record<string, ListPreview>;
  byConv: Record<string, ListVisitorMessage>;
  unreadByConv: Record<string, number>;
  handledBy: Record<string, string[]>;
  needsReplyByConv: Record<string, boolean>;
  waitingSinceByConv: Record<string, string | null>;
}

type Locale = Parameters<typeof operatorSystemText>[1];

/**
 * The list preview of a message. A system notice's body is written in the
 * requesting operator's language (services/operatorSystemText.ts): an
 * installed native app that does not know the kind prints the body.
 */
function previewOf(
  m: { body?: string | null; created_at: string; sender_type: string; sender_id?: string | null },
  meta: Record<string, unknown>,
  readerLocale: Locale,
): ListPreview {
  const isSystem = m.sender_type === 'system';
  return {
    body: (isSystem ? operatorSystemText(meta, readerLocale) : null) ?? m.body ?? '',
    created_at: m.created_at,
    sender_type: m.sender_type,
    sender_id: m.sender_id ?? null,
    sender_name: null,
    // A file-only message has an empty body: the list preview must
    // describe the media instead of claiming "no messages yet".
    attachment_id: meta?.attachment_id ? String(meta.attachment_id) : null,
    attachment_kind: null,
    // Every system notice is stored in English and frozen at insert
    // time, so the preview has to rebuild the sentence from metadata
    // (see shared/systemMessageText.ts). Shipping the whole object
    // rather than a field per kind is why the list no longer falls
    // behind the thread every time a new kind is added. The English
    // stand-ins once stored as a name ('a colleague') go out as null.
    system_kind: meta?.kind ? String(meta.kind) : null,
    system_meta: meta?.kind ? (isSystem ? withoutPlaceholderNames(meta) : meta) : null,
  };
}

interface SummaryRow {
  conversation_id: string;
  last_id: string | null;
  last_body: string | null;
  last_created_at: string | null;
  last_sender_type: string | null;
  last_sender_id: string | null;
  last_metadata: Record<string, unknown> | null;
  contact_body: string | null;
  contact_created_at: string | null;
  contact_seen_at: string | null;
  unread_count: number | string | null;
  handled_by: string[] | null;
  needs_reply: boolean | null;
  waiting_since: string | null;
}

/** "Function does not exist" (before 303): Postgres 42883, the data layer's PGRST202. */
function isFunctionMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code ?? '';
  return code === '42883' || code === 'PGRST202';
}

/** The summaries of these conversations from 303, or null when it cannot be read (then the window). */
async function readFromRpc(
  sb: ServiceClient,
  workspaceId: string,
  ids: string[],
  localeP: Promise<Locale>,
): Promise<ListSummaries | null> {
  // One row per conversation; a read is cut at DATABASE_MAX_ROWS like any
  // other, so it is paged, and stops once every listed id has its row.
  let read: Awaited<ReturnType<typeof readRows<SummaryRow>>>;
  try {
    read = await readRows<SummaryRow>((from, to) => sb
      .rpc('conversation_list_summaries', { p_workspace_id: workspaceId, p_conversation_ids: ids })
      .order('conversation_id', { ascending: true })
      .range(from, to), ids.length);
  } catch (err) {
    console.warn('[conversations] list summaries failed, using the message window:', (err as Error | null)?.message || err);
    return null;
  }
  const { data, error } = read;
  if (error) {
    if (!isFunctionMissing(error)) {
      console.warn('[conversations] list summaries failed, using the message window:', error.message);
    }
    return null;
  }
  // The function answers a row for every listed conversation of the
  // workspace; none at all for listed ids is no answer (a stand-in that
  // knows no such function), never "they are all empty".
  if (data.length === 0) return null;
  const readerLocale = await localeP;
  const out: ListSummaries = {
    source: 'rpc', lastByConv: {}, byConv: {}, unreadByConv: {}, handledBy: {}, needsReplyByConv: {}, waitingSinceByConv: {},
  };
  for (const r of data) {
    const cid = r.conversation_id;
    if (!cid) continue;
    if (r.last_id && r.last_created_at && r.last_sender_type) {
      out.lastByConv[cid] = previewOf({
        body: r.last_body, created_at: r.last_created_at, sender_type: r.last_sender_type, sender_id: r.last_sender_id,
      }, (r.last_metadata || {}) as Record<string, unknown>, readerLocale);
    }
    if (r.contact_created_at) {
      out.byConv[cid] = { body: r.contact_body ?? '', created_at: r.contact_created_at, seen_at: r.contact_seen_at ?? null };
    }
    const unread = Number(r.unread_count ?? 0) || 0;
    if (unread > 0) out.unreadByConv[cid] = unread;
    out.handledBy[cid] = Array.isArray(r.handled_by) ? r.handled_by.map(String) : [];
    out.needsReplyByConv[cid] = r.needs_reply === true;
    out.waitingSinceByConv[cid] = r.needs_reply === true ? (r.waiting_since ?? null) : null;
  }
  return out;
}

interface WindowRow extends NeedsReplyMessage {
  id: string;
  conversation_id: string;
  body: string | null;
  created_at: string;
  sender_type: string;
  sender_id: string | null;
  seen_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** The fallback: one window of the newest messages of all these conversations together. */
async function readFromWindow(
  sb: ServiceClient,
  ids: string[],
  localeP: Promise<Locale>,
): Promise<ListSummaries> {
  // The window's LIST_MESSAGE_WINDOW newest rows, paged: one read stops
  // at DATABASE_MAX_ROWS (1000), which silently halved the window.
  const { data: msgs } = await readRows<WindowRow>((from, to) => sb
    .from('conversation_messages')
    .select('id, conversation_id, body, created_at, sender_type, sender_id, seen_at, metadata')
    .in('conversation_id', ids)
    // Bot menu/button taps are navigation, not chat content — keep them
    // out of the fetch window entirely so a visitor browsing the bot menu
    // can never push the real last message out of the preview.
    .or('metadata->>channel_menu_event.is.null,metadata->>channel_menu_event.neq.true')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to), LIST_MESSAGE_WINDOW);
  const readerLocale = await localeP;

  const out: ListSummaries = {
    source: 'window', lastByConv: {}, byConv: {}, unreadByConv: {}, handledBy: {}, needsReplyByConv: {}, waitingSinceByConv: {},
  };
  const agents: Record<string, Set<string>> = {};
  // Rows arrive newest-first: the first conversational turn decides the
  // obligation (computeNeedsReply); while it is owed, the customer turns
  // before it, back to the team's last answer, are the wait
  // (computeWaitingSince: an answer resets the wait).
  const decided = new Set<string>();
  const streakEnded = new Set<string>();
  for (const m of (msgs || [])) {
    const cid = m.conversation_id;
    if (!cid) continue;
    // Channel menu/button taps are navigation, not conversation content:
    // they must never drive the list preview or the unread badge (the
    // Inbox's unread number skips them by the same rule).
    const meta = (m.metadata || {}) as Record<string, unknown>;
    if (isChannelMenuEvent(meta)) continue;

    if (!out.lastByConv[cid]) out.lastByConv[cid] = previewOf(m, meta, readerLocale);
    if (m.sender_type === 'agent' && m.sender_id) (agents[cid] ||= new Set<string>()).add(String(m.sender_id));

    if (isQualifiedCustomerFacingAnswer(m)) {
      if (!decided.has(cid)) out.needsReplyByConv[cid] = false;
      decided.add(cid);
      streakEnded.add(cid);
    } else if (isActionableCustomerTurn(m)) {
      if (!decided.has(cid)) {
        out.needsReplyByConv[cid] = true;
        out.waitingSinceByConv[cid] = m.created_at ?? null;
        decided.add(cid);
      } else if (out.needsReplyByConv[cid] && !streakEnded.has(cid)) {
        // Still inside the unanswered streak → the wait began earlier.
        out.waitingSinceByConv[cid] = m.created_at ?? null;
      }
    }

    if (m.sender_type !== 'contact') continue;
    if (!out.byConv[cid]) out.byConv[cid] = { body: m.body ?? '', created_at: m.created_at, seen_at: m.seen_at ?? null };
    if (!m.seen_at) out.unreadByConv[cid] = (out.unreadByConv[cid] ?? 0) + 1;
  }
  for (const [cid, set] of Object.entries(agents)) out.handledBy[cid] = Array.from(set);
  return out;
}

/**
 * The summaries of the listed conversations (all of one workspace).
 * `readerLocale` is the operator's language (a system preview's body is
 * written in it), read alongside.
 */
export async function readListSummaries(
  sb: ServiceClient,
  workspaceId: string,
  ids: string[],
  readerLocale: Locale | Promise<Locale>,
): Promise<ListSummaries> {
  const localeP = Promise.resolve(readerLocale);
  if (ids.length === 0) {
    return { source: 'rpc', lastByConv: {}, byConv: {}, unreadByConv: {}, handledBy: {}, needsReplyByConv: {}, waitingSinceByConv: {} };
  }
  return (await readFromRpc(sb, workspaceId, ids, localeP)) ?? readFromWindow(sb, ids, localeP);
}
