/**
 * RECIPIENT RESOLUTION — server-side, workspace-isolated, preference-aware.
 *
 * Everything here answers ONE question: which operators are allowed to be
 * told about this event, right now? It reuses the existing membership model
 * (`workspace_members`, including `suspended_at`) and the existing
 * `user_notification_prefs` row — push adds policy, it does not add a second
 * authorization system.
 *
 * Hard rules:
 *  • Only members of THE conversation's workspace are ever considered.
 *  • Suspended members are excluded.
 *  • The actor who caused the event is never notified about their own action.
 *  • Preferences are enforced HERE, before dispatch — never in the client UI.
 */
import type { ServerConfig } from '../../config.js';
import type { PushPlatformSettings } from './platformSettings.js';
import { getServiceClient } from '../../supabase.js';
import { getConnectedOperators } from '../widget/operatorPresenceSource.js';

/**
 * `team_message` is a colleague's direct message in team chat: addressed to
 * one operator, and about no conversation.
 */
export type PushEventType =
  | 'new_message'
  | 'internal_note'
  | 'mention'
  | 'team_message'
  /** A conversation handed to one operator — by a colleague, or by routing. */
  | 'assignment'
  /** A new email in the workspace's email inbox, which has no conversation. */
  | 'email_message'
  /** A visitor asked to be called back. */
  | 'callback_request'
  /**
   * The AI stopped and handed a conversation to people: to whoever already
   * holds it, or — when nobody does — to the operators following everything.
   */
  | 'handoff'
  /**
   * The platform's support team answered one of this operator's support
   * threads. Addressed to that one operator, like a colleague's message.
   */
  | 'support_reply';

export interface RecipientContext {
  workspaceId: string;
  /** The conversation the event is in; none for a team message. */
  conversationId?: string | null;
  assignedTo: string | null;
  eventType: PushEventType;
  /** Operator who authored the note/mention; never notified. */
  actorId?: string | null;
  mentionedUserIds?: string[];
  /**
   * Only these members are considered at all — the one operator a team
   * message is addressed to — so a direct message does not read the prefs,
   * profiles and presence of the whole workspace to notify one person.
   */
  userIds?: string[];
  /**
   * Platform-wide policy (Super Admin → Notifications). Supplies the defaults
   * for an operator who never opened their own notification preferences, and
   * decides whether a direct @mention may break quiet hours. Omitted in
   * tests, where the historical hardcoded defaults apply.
   */
  policy?: PushPlatformSettings | null;
}

export interface Recipient {
  userId: string;
  /** false → privacy mode: no message preview in the notification. */
  preview: boolean;
  sound: boolean;
  /** The operator's own UI language; picks the notification copy template. */
  locale: string;
}

/** The `workspace_members` columns the resolver reads. */
interface MemberRow {
  user_id: string;
  suspended_at: string | null;
}

interface PrefsRow {
  user_id: string;
  disable_all: boolean | null;
  play_sound: boolean | null;
  push_scope: string | null;
  push_preview: boolean | null;
  push_internal_notes: boolean | null;
  push_when_online: boolean | null;
  push_when_offline: boolean | null;
  quiet_hours_enabled: boolean | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string | null;
  push_team_chat?: boolean | null;
  push_assignments?: boolean | null;
  push_email?: boolean | null;
}

const DEFAULT_PREFS = {
  disable_all: false,
  play_sound: true,
  push_scope: 'all',
  push_preview: true,
  push_internal_notes: true,
  push_when_online: true,
  push_when_offline: true,
  quiet_hours_enabled: false,
  quiet_hours_start: null as string | null,
  quiet_hours_end: null as string | null,
  quiet_hours_timezone: null as string | null,
  // Migration 235: one switch per kind of event beyond a customer's message.
  push_team_chat: true,
  push_assignments: true,
  push_email: true,
};

/** The prefs columns every deployment has. */
const PREF_COLUMNS =
  'user_id, disable_all, play_sound, push_scope, push_preview, push_internal_notes, push_when_online, push_when_offline, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone';
/** Added by migration 235; read when present, defaulted on when not. */
const EVENT_PREF_COLUMNS = 'push_team_chat, push_assignments, push_email';

/**
 * Which row this resolver reads.
 *
 * Everything downstream of here sends to `mobile_push_devices` — a phone.
 * An operator's browser preferences live under 'web' and are read by the
 * browser itself; reading them here is what made silencing the phone silence
 * the desk too.
 */
const SURFACE = 'mobile';

/** Minutes since midnight for "HH:MM"; null when unusable. */
function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Local wall-clock minutes for an IANA timezone, at `now`. */
function localMinutes(timezone: string | null, now: Date): number | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return parseHhMm(fmt.format(now));
  } catch {
    return null; // invalid timezone → treat as "cannot evaluate", never mute
  }
}

/**
 * Quiet hours are enforced HERE (server-side), not in the client. Windows may
 * wrap past midnight (22:00 → 07:00). A direct @mention still gets through —
 * being personally addressed is the one case operators expect to break quiet
 * hours. If the window or timezone is unusable, we do NOT mute.
 */
export function isWithinQuietHours(
  prefs: { quiet_hours_enabled?: boolean | null; quiet_hours_start?: string | null; quiet_hours_end?: string | null; quiet_hours_timezone?: string | null },
  now: Date = new Date(),
): boolean {
  if (!prefs.quiet_hours_enabled) return false;
  const start = parseHhMm(prefs.quiet_hours_start ?? null);
  const end = parseHhMm(prefs.quiet_hours_end ?? null);
  if (start == null || end == null || start === end) return false;
  const current = localMinutes(prefs.quiet_hours_timezone ?? null, now);
  if (current == null) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end; // wraps past midnight
}

export async function resolveRecipients(
  config: ServerConfig,
  ctx: RecipientContext,
): Promise<Recipient[]> {
  const sb = getServiceClient(config);

  let memberQuery = sb
    .from('workspace_members')
    .select('user_id, suspended_at')
    .eq('workspace_id', ctx.workspaceId);
  if (ctx.userIds) memberQuery = memberQuery.in('user_id', ctx.userIds);
  const { data: members, error } = await memberQuery;
  if (error) {
    console.error('[push] member lookup failed', { code: error.code, message: error.message });
    return [];
  }

  const mentioned = new Set(ctx.mentionedUserIds ?? []);
  const eligible = (members as MemberRow[] | null ?? [])
    .filter((m) => !m.suspended_at)
    .map((m) => String(m.user_id))
    .filter((id) => id !== ctx.actorId);

  if (!eligible.length) return [];

  const prefRows = await readPrefs(sb, eligible);

  const prefsByUser = new Map<string, PrefsRow>();
  for (const row of (prefRows ?? []) as PrefsRow[]) prefsByUser.set(row.user_id, row);

  // The notification copy is rendered in the recipient's OWN language, not
  // the sender's: a Turkish operator must not get a Persian push because the
  // customer wrote in Persian.
  const localeByUser = new Map<string, string>();
  const { data: profileRows } = await sb
    .from('profiles')
    .select('id, preferred_locale')
    .in('id', eligible);
  for (const row of (profileRows ?? []) as { id: string; preferred_locale: string | null }[]) {
    if (row.preferred_locale) localeByUser.set(String(row.id), String(row.preferred_locale));
  }

  // Platform defaults apply ONLY where the operator has no explicit value of
  // their own — a saved preference always wins over an admin default.
  const platformDefaults = policyDefaults(ctx.policy);
  const mentionBypassesQuietHours = ctx.policy?.mention_bypasses_quiet_hours !== false;

  // "Only when I am away from my desk" and its opposite. Asked once, for
  // everyone eligible, and only when somebody has actually turned one of the
  // two off — a push path should not pay for a presence read nobody's
  // settings depend on.
  const connected = await connectedOperators(config, ctx.workspaceId, eligible, prefsByUser);

  const now = new Date();
  const out: Recipient[] = [];
  for (const userId of eligible) {
    const p = { ...DEFAULT_PREFS, ...platformDefaults, ...cleanPrefs(prefsByUser.get(userId)) };
    if (p.disable_all) continue;
    if (p.push_scope === 'none') continue;

    // Where the operator is right now. `connected` is null when presence
    // could not be read at all — degraded, or nobody asked for it — and a
    // notification is never dropped on a guess: not knowing means send.
    if (connected) {
      const atTheirDesk = connected.has(userId);
      if (atTheirDesk && !p.push_when_online) continue;
      if (!atTheirDesk && !p.push_when_offline) continue;
    }

    const isMentioned = mentioned.has(userId);
    const isAssignee = ctx.assignedTo === userId;

    // Quiet hours: silenced unless the operator was personally mentioned AND
    // the platform allows a mention to break the window. A colleague's
    // direct message is addressed to them just as personally, and is passed
    // in as a mention of its recipient for exactly this.
    if (!(isMentioned && mentionBypassesQuietHours) && isWithinQuietHours(p, now)) continue;

    if (ctx.eventType === 'mention' && !isMentioned) continue;
    // Addressed to one operator: the scope ("assigned to me", "mentions
    // only") is about customers' conversations, and a direct message is
    // theirs whatever it is set to — only 'none' and "disable all", above,
    // silence it.
    if (ctx.eventType === 'team_message' && !isMentioned) continue;
    if (ctx.eventType === 'support_reply' && !isMentioned) continue;
    if (ctx.eventType === 'internal_note') {
      if (!p.push_internal_notes && !isMentioned) continue;
      // A note is about the conversation, so it reaches whoever the
      // conversation's customer messages would: the assignee of an assigned
      // one, everyone who follows all conversations on an unassigned one.
      if (ctx.assignedTo) {
        if (!isAssignee && !isMentioned) continue;
      } else if (p.push_scope !== 'all' && !isMentioned) continue;
    }
    // Email and callbacks belong to no one yet: they reach those who follow
    // everything, as an unassigned customer message does.
    if ((ctx.eventType === 'email_message' || ctx.eventType === 'callback_request') && p.push_scope !== 'all') continue;
    // Each kind of event beyond a customer's message has its own switch.
    if (ctx.eventType === 'team_message' && p.push_team_chat === false) continue;
    if ((ctx.eventType === 'assignment' || ctx.eventType === 'handoff') && p.push_assignments === false) continue;
    if (ctx.eventType === 'email_message' && p.push_email === false) continue;
    if (ctx.eventType === 'handoff') {
      // Handed to somebody already: theirs alone. Handed to the queue: the
      // same people an unassigned customer message reaches.
      if (ctx.assignedTo ? !isAssignee : p.push_scope !== 'all') continue;
    }
    if (ctx.eventType === 'new_message') {
      if (p.push_scope === 'mentions' && !isMentioned) continue;
      // "only assigned to me": an unassigned thread still reaches everyone
      // whose scope is 'all', so a new customer never goes unanswered.
      if (p.push_scope === 'assigned' && !isAssignee && !isMentioned) continue;
      // An assigned thread is that operator's (plus anyone mentioned).
      if (ctx.assignedTo && !isAssignee && !isMentioned) continue;
    }

    out.push({
      userId,
      preview: p.push_preview !== false,
      sound: p.play_sound !== false,
      locale: localeByUser.get(userId) ?? 'en',
    });
  }
  return out;
}

/**
 * The phone preferences of these operators, with the per-event switches when
 * the deployment has them. A database that has not run migration 235 yet
 * answers the short read, and the switches it lacks default to on — which is
 * exactly how those events behaved before the switches existed.
 */
async function readPrefs(
  sb: ReturnType<typeof getServiceClient>,
  userIds: string[],
): Promise<PrefsRow[]> {
  const query = (columns: string) =>
    sb
      .from('user_notification_prefs')
      .select(columns)
      .in('user_id', userIds)
      .eq('platform', SURFACE)
      .is('workspace_id', null);
  const full = await query(`${PREF_COLUMNS}, ${EVENT_PREF_COLUMNS}`);
  if (!full.error) return (full.data ?? []) as unknown as PrefsRow[];
  const legacy = await query(PREF_COLUMNS);
  return (legacy.data ?? []) as unknown as PrefsRow[];
}

/**
 * Who is connected right now, or null when the answer cannot be trusted.
 *
 * Both presence switches default to on, so for nearly every workspace the
 * answer changes nothing and the read is skipped entirely — it is only
 * needed once somebody has turned one of them off.
 *
 * Null is "do not decide". A degraded presence read — Centrifugo unreachable,
 * the lease fallback in play — would otherwise report a whole workspace as
 * disconnected, and an operator who asked not to be pushed while offline
 * would be the one to lose the message. Silence is the expensive failure
 * here; a redundant banner is not.
 */
async function connectedOperators(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  prefsByUser: Map<string, PrefsRow>,
): Promise<Set<string> | null> {
  const anyoneCares = userIds.some((id) => {
    const row = prefsByUser.get(id);
    return row?.push_when_online === false || row?.push_when_offline === false;
  });
  if (!anyoneCares) return null;

  try {
    const snapshot = await getConnectedOperators(config, workspaceId, userIds);
    if (snapshot.degraded) return null;
    return snapshot.connected;
  } catch (err) {
    console.error('[push] presence lookup failed; sending anyway', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The platform-wide defaults, shaped like a prefs row so they can be merged
 * UNDER the operator's own saved values.
 */
function policyDefaults(policy: PushPlatformSettings | null | undefined): Partial<typeof DEFAULT_PREFS> {
  if (!policy) return {};
  return {
    play_sound: policy.default_sound,
    push_scope: policy.default_scope,
    push_preview: policy.default_preview,
    push_internal_notes: policy.default_internal_notes,
    quiet_hours_enabled: policy.default_quiet_hours_enabled,
    quiet_hours_start: policy.default_quiet_hours_start,
    quiet_hours_end: policy.default_quiet_hours_end,
    quiet_hours_timezone: policy.default_quiet_hours_timezone,
  };
}

function cleanPrefs(row: PrefsRow | undefined): Partial<typeof DEFAULT_PREFS> {
  if (!row) return {};
  const out: Record<string, unknown> = {};
  if (row.disable_all != null) out.disable_all = row.disable_all;
  if (row.play_sound != null) out.play_sound = row.play_sound;
  if (row.push_scope != null) out.push_scope = row.push_scope;
  if (row.push_preview != null) out.push_preview = row.push_preview;
  if (row.push_internal_notes != null) out.push_internal_notes = row.push_internal_notes;
  if (row.push_when_online != null) out.push_when_online = row.push_when_online;
  if (row.push_when_offline != null) out.push_when_offline = row.push_when_offline;
  if (row.quiet_hours_enabled != null) out.quiet_hours_enabled = row.quiet_hours_enabled;
  if (row.quiet_hours_start != null) out.quiet_hours_start = row.quiet_hours_start;
  if (row.quiet_hours_end != null) out.quiet_hours_end = row.quiet_hours_end;
  if (row.quiet_hours_timezone != null) out.quiet_hours_timezone = row.quiet_hours_timezone;
  if (row.push_team_chat != null) out.push_team_chat = row.push_team_chat;
  if (row.push_assignments != null) out.push_assignments = row.push_assignments;
  if (row.push_email != null) out.push_email = row.push_email;
  return out as Partial<typeof DEFAULT_PREFS>;
}

/**
 * Server-authoritative unread badge: what is waiting for this operator, in
 * CONVERSATIONS (not messages), which is what makes it reconcile on
 * read/resolve from any device instead of drifting from local increments.
 *
 * It counts what the app's Inbox badge counts, so the number on the icon and
 * the number on the tab agree: open conversations in the main queue — not
 * spam, not the AI's own queue — that are unassigned or the operator's, and
 * hold an unseen customer message; plus colleagues with an unread message for
 * them. It used to count every open or pending thread, spam and the AI queue
 * and other people's conversations included, so the icon said 40 over a tab
 * that said 3.
 */
export async function unreadBadgeCount(
  config: ServerConfig,
  userId: string,
  workspaceId?: string | null,
): Promise<number> {
  const sb = getServiceClient(config);
  // One statement (migration 236) in place of the four round trips below,
  // which stay as the path for a database that has not run it yet.
  try {
    const { data, error } = await sb.rpc('push_unread_badge', {
      p_user_id: userId,
      p_workspace_id: workspaceId ?? null,
    });
    if (!error && data != null && Number.isFinite(Number(data))) return Number(data);
  } catch {
    // No such function, or a client without rpc: count it the long way.
  }
  let workspaceIds: string[] = [];
  if (workspaceId) {
    const { data: member } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .is('suspended_at', null)
      .maybeSingle();
    if (!member) return 0;
    workspaceIds = [workspaceId];
  } else {
    const { data: rows } = await sb
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .is('suspended_at', null);
    workspaceIds = (rows as { workspace_id: string }[] | null ?? []).map((r) => String(r.workspace_id));
  }
  if (!workspaceIds.length) return 0;

  const { data: convs } = await sb
    .from('conversations')
    .select('id')
    .in('workspace_id', workspaceIds)
    .eq('status', 'open')
    .eq('is_spam', false)
    .or('ai_state.is.null,ai_state.neq.ai_managed')
    .or(`assigned_to.is.null,assigned_to.eq.${userId}`)
    .limit(500);
  const ids = (convs as { id: string }[] | null ?? []).map((c) => String(c.id));

  let conversations = 0;
  if (ids.length) {
    const { data: msgs } = await sb
      .from('conversation_messages')
      .select('conversation_id')
      .in('conversation_id', ids)
      .eq('sender_type', 'contact')
      .is('seen_at', null)
      .limit(2000);
    conversations = new Set(
      (msgs as { conversation_id: string }[] | null ?? []).map((m) => String(m.conversation_id)),
    ).size;
  }

  // Colleagues with something unread for this operator — one each, however
  // many lines they sent, as the Colleagues tab counts them.
  const { data: team } = await sb
    .from('team_messages')
    .select('sender_id')
    .in('workspace_id', workspaceIds)
    .eq('recipient_id', userId)
    .is('read_at', null)
    .limit(2000);
  const colleagues = new Set(
    (team as { sender_id: string }[] | null ?? []).map((m) => String(m.sender_id)),
  ).size;

  return conversations + colleagues;
}
