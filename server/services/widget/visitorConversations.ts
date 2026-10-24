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
 */
import type { ServiceClient } from '../../supabase.js';

/** What a visitor may still write into (owner, 2026-10-24): closed alone has ended. */
export const LIVE_CONVERSATION_STATUSES = ['open', 'pending', 'resolved'] as const;

export function isLiveConversationStatus(status: unknown): boolean {
  return (LIVE_CONVERSATION_STATUSES as readonly string[]).includes(String(status ?? ''));
}

/** A widget conversation: no channel recorded, or the widget's own. */
export function isWidgetConversation(metadata: unknown): boolean {
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const channel = String(meta.channel ?? '').trim().toLowerCase();
  return !channel || channel === 'widget';
}

/** How many of the visitor's newest live conversations are looked through. */
const LIVE_SCAN = 5;

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

/**
 * The visitor's live widget conversation: the newest by updated_at whose
 * status is live (or one of `statuses`), skipping other channels' rows and,
 * unless asked, unanswered greetings. Null when there is none, when the
 * scope matches nothing, and when the read fails (a guard that cannot read
 * lets the request go on as before).
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
    let q = sb
      .from('conversations')
      .select('id, status, updated_at, assigned_to, source:metadata->>source, ai_state:metadata->>ai_state, channel:metadata->>channel')
      .eq('workspace_id', workspaceId)
      .or(or)
      .in('status', [...(opts.statuses || LIVE_CONVERSATION_STATUSES)]);
    if (opts.excludeId) q = q.neq('id', opts.excludeId);
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(LIVE_SCAN);
    if (error) throw error;
    type LiveRow = { id: string; status: string; updated_at: string | null; assigned_to: string | null; source: string | null; ai_state: string | null; channel: string | null };
    for (const row of (data || []) as LiveRow[]) {
      if (!row?.id || !isWidgetConversation({ channel: row.channel })) continue;
      let greetingOnly = false;
      // Only an intro-made row can be one; anything a person touched is not.
      if (row.source === 'ai_agent_intro' && !row.assigned_to && row.ai_state !== 'human_active') {
        const hasVisitorMessage = await hasMessageFrom(sb, row.id, 'contact');
        greetingOnly = !hasVisitorMessage && isUnansweredGreeting({
          source: row.source,
          assignedTo: row.assigned_to,
          aiState: row.ai_state,
          hasVisitorMessage,
          hasAgentMessage: await hasMessageFrom(sb, row.id, 'agent'),
        });
      }
      if (greetingOnly && opts.includeUnansweredGreeting !== true) continue;
      return { id: row.id, status: row.status, updatedAt: row.updated_at ?? null, assignedTo: row.assigned_to ?? null, greetingOnly };
    }
    return null;
  } catch (err) {
    console.warn('[visitor-conversations] live conversation lookup failed:', (err as { message?: string } | null)?.message || err);
    return null;
  }
}

/**
 * Where a visitor's message goes when it may not continue the conversation it
 * names (closed, or not theirs) or the widget asked for a new thread
 * (force_new_conversation): their live conversation, which the widget then
 * loads (`continued`), else none, and a new one is created. Never an older
 * ended conversation.
 *
 * TODO(auto-close PR, migration 284): a message racing an inactivity close
 * (the ticker's `closed_reason`, written a moment before the message arrived)
 * should reopen that conversation instead of starting a new one; the check
 * belongs here, with the closed row passed in.
 */
export function liveConversationForNextMessage(
  sb: ServiceClient,
  workspaceId: string,
  scope: VisitorConversationScope | null,
): Promise<LiveVisitorConversation | null> {
  return findLiveVisitorConversation(sb, workspaceId, scope);
}
