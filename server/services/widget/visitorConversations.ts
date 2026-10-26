/**
 * ONE CURRENT CONVERSATION PER VISITOR (2026-10-24): which of a widget
 * visitor's conversations are theirs, and which one is live.
 *
 * The widget shows a visitor one conversation at a time, the current one, and
 * the others under «گفتگوهای قبلی» (Core's currentConversation, runtime.js).
 * The owner's rule (2026-10-24): a conversation is LIVE for the visitor while
 * it is open, pending or resolved — the operator's "Resolve" takes it out of
 * the Inbox only, and the visitor's next message reopens it
 * (conversationLifecycle.ts) — and it ENDS for them only once it is closed.
 *
 * The server keeps the same rule wherever a request could start a second
 * conversation beside a live one (POST /message's force_new_conversation or a
 * closed conversation id, the away thread's POST /offline-messages, the AI
 * intro of older widgets), and wherever it hands the widget a conversation of
 * its own accord (GET /poll without an id, GET /identity/history).
 *
 * "This visitor" is the signed visitor id (the dvsid cookie or the credential
 * header, never a body field) and exactly the scope GET /conversations lists:
 * every visitor_sessions row of that id, and the contact whose metadata
 * carries it. So the live conversation here is the one the widget's list
 * makes current: the newest live row by updated_at.
 *
 * Two kinds of row are never live for this purpose:
 *   - another channel's conversation of the same contact (Telegram, WhatsApp,
 *     email…: a verified contact's thread there must not absorb widget
 *     messages);
 *   - an unanswered greeting: a conversation the AI intro of an older widget
 *     created on chat open, holding only its greeting (isUnansweredGreeting).
 *     The list hides them; the intro's legacy branch alone reuses them.
 *
 * A conversation the inactivity close ended a moment before the visitor's
 * message (migration 284) is the one exception to "closed has ended": the
 * message raced the close, so it goes back to what it was
 * (reopenAfterIdleCloseRace, within INACTIVITY_CLOSE_RACE_GRACE_SECONDS).
 */
import type { ServerConfig } from '../../config.js';
import type { ServiceClient } from '../../supabase.js';
import { justClosedForInactivity, reopenAfterIdleCloseRace } from '../idleCloseRace.js';

/** What a visitor may still write into (owner, 2026-10-24): closed alone has ended. */
export const LIVE_CONVERSATION_STATUSES = ['open', 'pending', 'resolved'] as const;

export function isLiveConversationStatus(status: unknown): boolean {
  return (LIVE_CONVERSATION_STATUSES as readonly string[]).includes(String(status ?? ''));
}

/**
 * A closed line an older server wrote on "Resolve" (`conversation_closed`,
 * status 'resolved'; Template 2 workspaces, before 2026-10-24). A resolved
 * conversation is live for the visitor, so that line, and the rating card a
 * template draws under it, is never handed to the widget again (routes/
 * widgetAttachments.ts isVisitorVisibleMessageMeta), and it is not the line a
 * later close reuses (conversationClosedNotice.ts latestClosedRow): that
 * close writes its own. The Inbox still shows it.
 */
export function isResolveClosedLine(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
  return !!meta && meta.kind === 'conversation_closed' && meta.status === 'resolved';
}

/** A widget conversation: no channel recorded, or the widget's own. */
export function isWidgetConversation(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const channel = String(meta.channel ?? '').trim().toLowerCase();
  return !channel || channel === 'widget';
}

/**
 * isWidgetConversation in SQL, a PostgREST `.or()` filter on conversations,
 * so another channel's rows (a verified contact's Telegram, email… threads)
 * never take a place in a window the LIMIT counts. The server writes the
 * channel as the provider's id or 'widget', lower case; the JS test stays
 * behind it.
 */
export const WIDGET_CHANNEL_FILTER = 'metadata->>channel.is.null,metadata->>channel.eq.widget';

/**
 * How many of the visitor's newest live widget conversations are read at a
 * time, and in how many windows at most: unanswered greetings are passed over
 * in JS, so while a window held nothing else the next one is read, as far as
 * GET /conversations reaches (VISITOR_LIST_PAGE × VISITOR_LIST_PAGES), so the
 * server and the widget's list agree on which one is live.
 */
const LIVE_SCAN = 10;
const LIVE_SCAN_PAGES = 9;

/** GET /conversations: the rows read at a time, and in how many windows at most (routes/widget.ts). */
export const VISITOR_LIST_PAGE = 30;
export const VISITOR_LIST_PAGES = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VisitorConversationScope {
  visitorId: string;
  /** Every visitor_sessions row of the visitor in this workspace (at most 50). */
  sessionIds: string[];
  /** The contact whose metadata carries the visitor id, if any. */
  contactId: string | null;
}

/**
 * The visitor's sessions and contact (two reads, the ones GET /conversations
 * always made). A failed read is an empty part: the scope only narrows.
 */
export async function resolveVisitorConversationScope(
  sb: ServiceClient,
  workspaceId: string,
  visitorId: string,
): Promise<VisitorConversationScope> {
  const [{ data: sessions }, { data: contact }] = await Promise.all([
    sb.from('visitor_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .limit(50),
    sb.from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .contains('metadata', { visitor_id: visitorId })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    visitorId,
    sessionIds: ((sessions || []) as Array<{ id?: unknown }>).map((s) => String(s.id || '')).filter(Boolean),
    contactId: (contact as { id?: string } | null)?.id || null,
  };
}

/**
 * The scope as a PostgREST `.or()` filter on conversations, or null when it
 * matches nothing. Only UUIDs reach the filter string: an id is interpolated,
 * so anything else (a comma, a parenthesis) is dropped rather than parsed.
 */
export function scopeOrFilter(scope: VisitorConversationScope | null | undefined): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  const sessions = scope.sessionIds.filter((id) => UUID_RE.test(id));
  if (sessions.length > 0) parts.push(`visitor_session_id.in.(${sessions.join(',')})`);
  if (scope.contactId && UUID_RE.test(scope.contactId)) parts.push(`contact_id.eq.${scope.contactId}`);
  return parts.length > 0 ? parts.join(',') : null;
}

/**
 * A conversation the AI intro created holding only its greeting: the visitor
 * never wrote and no person ever touched it. The Inbox keeps the same rows
 * out of Main (routes/conversations.ts, the intro-only filter).
 */
export function isUnansweredGreeting(row: {
  source?: string | null;
  assignedTo?: string | null;
  aiState?: string | null;
  hasVisitorMessage: boolean;
  hasAgentMessage: boolean;
}): boolean {
  return row.source === 'ai_agent_intro'
    && !row.hasVisitorMessage
    && !(row.assignedTo || row.aiState === 'human_active' || row.hasAgentMessage);
}

export interface LiveVisitorConversation {
  id: string;
  status: string;
  updatedAt: string | null;
  assignedTo: string | null;
  aiState: string | null;
  /** An unanswered greeting (only with includeUnansweredGreeting). */
  greetingOnly: boolean;
}

/** Whether the conversation holds a message from this sender (one indexed read). */
async function hasMessageFrom(sb: ServiceClient, conversationId: string, senderType: 'contact' | 'agent'): Promise<boolean> {
  const { data } = await sb
    .from('conversation_messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', senderType)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** Only an intro-made row nobody took can be an unanswered greeting; anything a person touched is not. */
function mayBeUnansweredGreeting(row: { source?: string | null; assigned_to?: string | null; ai_state?: string | null }): boolean {
  return row.source === 'ai_agent_intro' && !row.assigned_to && row.ai_state !== 'human_active';
}

type GreetingCandidate = { id: string; source?: string | null; assigned_to?: string | null; ai_state?: string | null };

/** Whether this row is an unanswered greeting (isUnansweredGreeting): two indexed reads at most, none for most rows. */
async function isUnansweredGreetingRow(sb: ServiceClient, row: GreetingCandidate): Promise<boolean> {
  if (!mayBeUnansweredGreeting(row)) return false;
  const hasVisitorMessage = await hasMessageFrom(sb, row.id, 'contact');
  return !hasVisitorMessage && isUnansweredGreeting({
    source: row.source,
    assignedTo: row.assigned_to,
    aiState: row.ai_state,
    hasVisitorMessage,
    hasAgentMessage: await hasMessageFrom(sb, row.id, 'agent'),
  });
}

/**
 * The visitor's live widget conversation: the newest by updated_at whose
 * status is live (or one of `statuses`), skipping other channels' rows (in
 * SQL) and, unless asked, unanswered greetings (window after window while a
 * window held nothing but those, LIVE_SCAN_PAGES at most). Null when there
 * is none, when the scope matches nothing, and when the read fails (a guard
 * that cannot read lets the request go on as before).
 */
export async function findLiveVisitorConversation(
  sb: ServiceClient,
  workspaceId: string,
  scope: VisitorConversationScope | null | undefined,
  opts: {
    excludeId?: string | null;
    statuses?: readonly string[];
    /** The intro's legacy branch: a greeting-only row is reused, not doubled. */
    includeUnansweredGreeting?: boolean;
  } = {},
): Promise<LiveVisitorConversation | null> {
  const or = scopeOrFilter(scope);
  if (!or) return null;
  try {
    type LiveRow = { id: string; status: string; updated_at: string | null; assigned_to: string | null; source: string | null; ai_state: string | null; channel: string | null };
    for (let page = 0; page < LIVE_SCAN_PAGES; page++) {
      let q = sb
        .from('conversations')
        .select('id, status, updated_at, assigned_to, source:metadata->>source, ai_state:metadata->>ai_state, channel:metadata->>channel')
        .eq('workspace_id', workspaceId)
        .or(or)
        .or(WIDGET_CHANNEL_FILTER)
        .in('status', [...(opts.statuses || LIVE_CONVERSATION_STATUSES)]);
      if (opts.excludeId) q = q.neq('id', opts.excludeId);
      const { data, error } = await q.order('updated_at', { ascending: false }).range(page * LIVE_SCAN, (page + 1) * LIVE_SCAN - 1);
      if (error) throw error;
      for (const row of (data || []) as LiveRow[]) {
        if (!row?.id || !isWidgetConversation({ channel: row.channel })) continue;
        const greetingOnly = await isUnansweredGreetingRow(sb, row);
        if (greetingOnly && opts.includeUnansweredGreeting !== true) continue;
        return {
          id: row.id, status: row.status, updatedAt: row.updated_at ?? null, assignedTo: row.assigned_to ?? null, aiState: row.ai_state ?? null, greetingOnly,
        };
      }
      if ((data || []).length < LIVE_SCAN) break;
    }
    return null;
  } catch (err) {
    console.warn('[visitor-conversations] live conversation lookup failed:', (err as { message?: string } | null)?.message || err);
    return null;
  }
}

/**
 * The race with an inactivity close, shared by every channel since migration
 * 286 (services/idleCloseRace.ts): re-exported here for the widget's routes
 * and tests, with the widget's grace (INACTIVITY_CLOSE_RACE_GRACE_SECONDS) as
 * their default.
 */
export { justClosedForInactivity, reopenAfterIdleCloseRace };

/**
 * Where a visitor's message goes when it may not continue the conversation it
 * names (closed, or not theirs) or the widget asked for a new thread
 * (force_new_conversation): their live conversation, which the widget then
 * loads (`continued`); else, when the conversation it names (`opts.closed`)
 * was closed by the inactivity close within the grace (justClosedForInactivity:
 * the message raced the close), that one, put back as it was
 * (reopenAfterIdleCloseRace, `reopened`: the same thread, so not
 * `continued`); else none, and a new one is created. Never an older ended
 * conversation: one closed by an operator, or by the timer longer ago,
 * stays ended. While another live conversation exists it wins, and nothing
 * is reopened (no RPC).
 */
export async function liveConversationForNextMessage(
  config: ServerConfig,
  sb: ServiceClient,
  workspaceId: string,
  scope: VisitorConversationScope | null,
  opts: { closed?: { id: string; status?: unknown; metadata?: unknown } | null } = {},
): Promise<(LiveVisitorConversation & { reopened?: boolean }) | null> {
  const live = await findLiveVisitorConversation(sb, workspaceId, scope);
  if (live) return live;
  const closed = opts.closed;
  if (!closed?.id || !justClosedForInactivity(closed)) return null;
  const restored = await reopenAfterIdleCloseRace(config, sb, { workspaceId, conversationId: closed.id });
  if (!restored) return null;
  const meta = closed.metadata && typeof closed.metadata === 'object' ? closed.metadata as Record<string, unknown> : {};
  return {
    id: closed.id,
    status: restored,
    updatedAt: null,
    assignedTo: null,
    aiState: typeof meta.ai_state === 'string' ? meta.ai_state : null,
    greetingOnly: false,
    reopened: true,
  };
}
