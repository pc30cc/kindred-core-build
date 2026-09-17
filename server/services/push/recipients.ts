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

export type PushEventType = 'new_message' | 'internal_note' | 'mention';

export interface RecipientContext {
  workspaceId: string;
  conversationId: string;
  assignedTo: string | null;
  eventType: PushEventType;
  /** Operator who authored the note/mention; never notified. */
  actorId?: string | null;
  mentionedUserIds?: string[];
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
  quiet_hours_enabled: boolean | null;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string | null;
}

const DEFAULT_PREFS = {
  disable_all: false,
  play_sound: true,
  push_scope: 'all',
  push_preview: true,
  push_internal_notes: true,
  quiet_hours_enabled: false,
  quiet_hours_start: null as string | null,
  quiet_hours_end: null as string | null,
  quiet_hours_timezone: null as string | null,
};

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

  const { data: members, error } = await sb
    .from('workspace_members')
    .select('user_id, suspended_at')
    .eq('workspace_id', ctx.workspaceId);
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

  const { data: prefRows } = await sb
    .from('user_notification_prefs')
    .select(
      'user_id, disable_all, play_sound, push_scope, push_preview, push_internal_notes, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone',
    )
    .in('user_id', eligible)
    .is('workspace_id', null);

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

  const now = new Date();
  const out: Recipient[] = [];
  for (const userId of eligible) {
    const p = { ...DEFAULT_PREFS, ...platformDefaults, ...cleanPrefs(prefsByUser.get(userId)) };
    if (p.disable_all) continue;
    if (p.push_scope === 'none') continue;

    const isMentioned = mentioned.has(userId);
    const isAssignee = ctx.assignedTo === userId;

    // Quiet hours: silenced unless the operator was personally mentioned AND
    // the platform allows a mention to break the window.
    if (!(isMentioned && mentionBypassesQuietHours) && isWithinQuietHours(p, now)) continue;


    if (ctx.eventType === 'mention' && !isMentioned) continue;
    if (ctx.eventType === 'internal_note') {
      if (!p.push_internal_notes && !isMentioned) continue;
      if (!isAssignee && !isMentioned && p.push_scope !== 'all') continue;
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
  if (row.quiet_hours_enabled != null) out.quiet_hours_enabled = row.quiet_hours_enabled;
  if (row.quiet_hours_start != null) out.quiet_hours_start = row.quiet_hours_start;
  if (row.quiet_hours_end != null) out.quiet_hours_end = row.quiet_hours_end;
  if (row.quiet_hours_timezone != null) out.quiet_hours_timezone = row.quiet_hours_timezone;
  return out as Partial<typeof DEFAULT_PREFS>;
}

/**
 * Server-authoritative unread badge: conversations in the operator's
 * workspaces that still hold an unseen inbound customer message. Counting
 * CONVERSATIONS (not messages) is what makes the badge match the inbox list
 * the operator actually sees, and is what lets it reconcile on read/resolve
 * from any device instead of drifting from local increments.
 */
export async function unreadBadgeCount(
  config: ServerConfig,
  userId: string,
  workspaceId?: string | null,
): Promise<number> {
  const sb = getServiceClient(config);
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
    .in('status', ['open', 'pending'])
    .limit(500);
  const ids = (convs as { id: string }[] | null ?? []).map((c) => String(c.id));
  if (!ids.length) return 0;

  const { data: msgs } = await sb
    .from('conversation_messages')
    .select('conversation_id')
    .in('conversation_id', ids)
    .eq('sender_type', 'contact')
    .is('seen_at', null)
    .limit(2000);

  return new Set(
    (msgs as { conversation_id: string }[] | null ?? []).map((m) => String(m.conversation_id)),
  ).size;
}
