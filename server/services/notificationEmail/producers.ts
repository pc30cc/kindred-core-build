/**
 * WHAT DECIDES THERE IS SOMETHING TO SAY.
 *
 * Five producers, two shapes. The digest, the weekly summary and the
 * announcement's fan-out are run by the ticker; the transcript and the
 * payment notice are raised by something that happened. All of them do the
 * same thing in the end: work out who should hear about it, resolve
 * everything the template needs, and write a queued job with a key that
 * makes a second copy impossible.
 *
 * None of them send. `dispatcher.ts` does that, asks both switches again on
 * the way, and is the one place a payload value becomes HTML: every value
 * here is plain text, whoever typed it.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveWorkspaceAppUrl } from '../auth-email.js';
import { enqueueNotificationEmail, isMissingColumn, windowKey } from './queue.js';
import { isTypeEnabled, loadNotificationEmailSettings } from './settings.js';
import { NOTIFICATION_EMAILS, type NotificationEmailType } from './types.js';
import { canUseInbox } from '../../../shared/chatRoles.js';
import { resolveLockState } from '../billing/locks/state.js';
import { isMemberLocked } from '../billing/locks/predicates.js';
import { billingRecipient, formatBillingMoney } from '../billing/account/notify.js';
import { operatorLocales, type OperatorLocale } from '../operatorLocale.js';
import { operatorSystemText } from '../operatorSystemText.js';
import { getPlatformEditionOrNull } from '../platformRegion.js';
import { ANON_CONTACT_NAME } from '../widget/anonymousContact.js';
import { isPlaceholderSubject } from '../../../shared/conversationSubject.js';

function sb(config: ServerConfig) {
  return getServiceClient(config);
}

/** Id lists in bounded slices (a long `in.(…)` filter stays a short request). */
function slices<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every operator who may hear about this workspace, honouring the audience
 * (the unread digest only to roles with an Inbox). Suspended members and
 * members whose seat the plan has paused (simple billing phase 4) hear
 * nothing.
 */
export async function audienceFor(
  config: ServerConfig,
  workspaceId: string,
  type: NotificationEmailType,
  exclude: string[] = [],
): Promise<string[]> {
  const { data, error } = await sb(config)
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .is('suspended_at', null);
  if (error) {
    console.error('[notification-email] audience lookup failed', { message: error.message });
    return [];
  }

  const rows = (data ?? []) as Array<{ user_id: string; role: string | null }>;
  const audience = NOTIFICATION_EMAILS[type].audience;
  const skip = new Set(exclude);
  const locks = await resolveLockState(config, workspaceId, ['member']);

  return rows
    .filter((r) => !skip.has(String(r.user_id)))
    .filter((r) => !isMemberLocked(locks, String(r.user_id)))
    .filter((r) => audience !== 'admins' || ['owner', 'admin'].includes(String(r.role ?? '')))
    .filter((r) => audience !== 'inbox' || canUseInbox(r.role))
    .map((r) => String(r.user_id));
}

/**
 * The console link an email points at.
 *
 * The same resolver the billing mail uses, so a workspace with its own
 * domain gets its own domain here too rather than the platform's.
 */
async function appUrl(config: ServerConfig, workspaceId: string | null, path: string): Promise<string> {
  try {
    return await resolveWorkspaceAppUrl(config, workspaceId, path);
  } catch {
    return path;
  }
}

// ───────────────────────── the unread digest ─────────────────────────

export interface SweepResult {
  workspaces: number;
  queued: number;
}

/** Conversations read per page while looking for what waits. */
const DIGEST_PAGE = 500;
/**
 * More open conversations than this and the sweep reads no further this
 * pass. The inactivity close ends quiet ones, so a platform holds a few
 * hundred at most; the bound is for the day it does not.
 */
const DIGEST_MAX_CONVERSATIONS = 20_000;

interface WaitingConversation {
  id: string;
  workspaceId: string;
  subject: string | null;
  assignedTo: string | null;
  /** The newest customer message nobody has seen that is older than the cutoff. */
  latest: string;
}

let warnedDigestMemory = false;

/**
 * Conversations still waiting, per workspace, to whoever is on the hook.
 *
 * One mail per operator, never one per conversation: the point of a digest
 * is that it is the thing you get INSTEAD of twelve notifications. "Waiting"
 * is the unread badge's (push/recipients.ts): an open or pending
 * conversation, not spam, not held by the AI, with a customer message nobody
 * has seen, older than the cutoff; and an operator hears about the ones
 * nobody holds and their own, not a colleague's.
 *
 * Each operator has at most one open digest per workspace (an index,
 * migration 289c): while one waits (its time has not come, or quiet hours
 * hold it), each sweep gives it the current list instead of queuing another,
 * so a night of quiet hours ends with one digest, not ten. A new one is
 * queued only when something new is waiting since the last one SENT (a
 * conversation it did not list, or a newer message in one it did) and at
 * least `digest_every_minutes` after it. A waiting digest whose operator has
 * nothing waiting any more is dropped.
 *
 * The scan starts from the conversations that can be waiting, never from
 * the messages: every message an operator never opened (an AI chat, one
 * closed for quiet) stays unseen for good, and the oldest of those once
 * filled the whole read, so the digest found nothing and went silent.
 */
export async function sweepUnreadDigest(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<SweepResult> {
  const out: SweepResult = { workspaces: 0, queued: 0 };
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'unread_messages')) return out;

  const cutoff = new Date(now.getTime() - settings.unread_after_minutes * 60_000).toISOString();

  // 1. What can be waiting, page by page (only an empty page is the end:
  //    the data layer may return fewer rows than asked for).
  const candidates: Array<{ id: string; workspace_id: string; subject: string | null; assigned_to: string | null }> = [];
  let complete = true;
  for (let after: string | null = null; ; ) {
    let query = sb(config)
      .from('conversations')
      .select('id, workspace_id, subject, assigned_to')
      .in('status', ['open', 'pending'])
      .or('is_spam.is.null,is_spam.eq.false')
      .or('ai_state.is.null,ai_state.neq.ai_managed');
    if (after) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(DIGEST_PAGE);
    if (error) {
      console.error('[notification-email] digest sweep failed', { message: error.message });
      return out;
    }
    const page = (data ?? []) as typeof candidates;
    if (!page.length) break;
    candidates.push(...page);
    after = String(page[page.length - 1].id);
    if (candidates.length >= DIGEST_MAX_CONVERSATIONS) {
      complete = false;
      break;
    }
  }

  // 2. Which of them have a customer message waiting, and its newest. Each
  //    read is newest first and leaves out the conversations already found,
  //    so its first row for a conversation is that conversation's newest,
  //    and every read finds at least one more or ends the slice.
  const latest = new Map<string, string>();
  for (const slice of slices(candidates.map((c) => String(c.id)), 50)) {
    let remaining = slice;
    while (remaining.length) {
      const { data, error } = await sb(config)
        .from('conversation_messages')
        .select('conversation_id, created_at')
        .in('conversation_id', remaining)
        .eq('sender_type', 'contact')
        .is('seen_at', null)
        .lt('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) {
        console.error('[notification-email] digest sweep failed', { message: error.message });
        return out;
      }
      const rows = (data ?? []) as Array<{ conversation_id: string; created_at: string }>;
      if (!rows.length) break;
      for (const row of rows) {
        const id = String(row.conversation_id);
        // One spelling of the time (to the millisecond), so times compare as text.
        if (!latest.has(id)) latest.set(id, new Date(row.created_at).toISOString());
      }
      remaining = remaining.filter((id) => !latest.has(id));
    }
  }

  const byWorkspace = new Map<string, WaitingConversation[]>();
  for (const c of candidates) {
    const at = latest.get(String(c.id));
    if (!at) continue;
    const list = byWorkspace.get(String(c.workspace_id)) ?? [];
    list.push({
      id: String(c.id),
      workspaceId: String(c.workspace_id),
      subject: c.subject,
      assignedTo: c.assigned_to ? String(c.assigned_to) : null,
      latest: at,
    });
    byWorkspace.set(String(c.workspace_id), list);
  }

  const window = windowKey(now, settings.digest_every_minutes);
  const rateMs = settings.digest_every_minutes * 60_000;
  /** "user:workspace" of every digest that is open after this sweep. */
  const live = new Set<string>();
  /** Workspaces whose audience could not be told: their waiting digests are left as they are. */
  const unknown = new Set<string>();

  for (const [workspaceId, conversations] of byWorkspace) {
    const recipients = await audienceFor(config, workspaceId, 'unread_messages');
    if (!recipients.length) {
      unknown.add(workspaceId);
      continue;
    }
    const memory = await digestMemory(config, workspaceId, now);
    if (!memory) return out;

    const name = await workspaceName(config, workspaceId);
    const url = await appUrl(config, workspaceId, '/inbox');
    let counted = false;

    for (const userId of recipients) {
      const mine = conversations
        .filter((c) => !c.assignedTo || c.assignedTo === userId)
        .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
      if (!mine.length) continue;
      const coveredThrough = mine[0].latest;
      const payload = {
        count: mine.length,
        minutes: settings.unread_after_minutes,
        workspace: name,
        // A subject the server wrote when nobody typed one ('New
        // conversation', 'Offline message') is English: no subject.
        list: mine
          .slice(0, 10)
          .map((c) => (isPlaceholderSubject(c.subject) ? '—' : String(c.subject)))
          .join(' · '),
        action_url: url,
      };
      const conversationIds = mine.map((c) => c.id);

      const open = memory.open.get(userId);
      if (open) {
        live.add(`${userId}:${workspaceId}`);
        // Being sent right now: the next sweep sees what it said.
        if (open.status !== 'pending') continue;
        await sb(config)
          .from('notification_email_jobs')
          .update({ payload, conversation_ids: conversationIds, covered_through: coveredThrough })
          .eq('id', open.id)
          .eq('status', 'pending');
        continue;
      }

      const last = memory.sent.get(userId);
      if (last) {
        if (now.getTime() - Date.parse(last.sentAt) < rateMs) continue;
        const told = new Set(last.conversationIds);
        const nothingNew = mine.every((c) => told.has(c.id) && (!last.coveredThrough || c.latest <= last.coveredThrough));
        if (nothingNew) continue;
      }

      const queued = await enqueueNotificationEmail(config, {
        userId,
        workspaceId,
        type: 'unread_messages',
        // The window still names the key, so two sweeps of the same minute
        // produce the same key and the second is refused by the index.
        dedupeKey: `unread:${userId}:${workspaceId}:${window}`,
        payload,
        conversationIds,
        coveredThrough: new Date(coveredThrough),
      });
      if (queued.queued || queued.reason === 'duplicate') live.add(`${userId}:${workspaceId}`);
      if (queued.queued) {
        out.queued += 1;
        if (!counted) {
          out.workspaces += 1;
          counted = true;
        }
      }
    }
  }

  // A waiting digest whose operator has nothing waiting any more says
  // nothing true: it goes. Only after a whole scan, or a cut-short one would
  // drop the digests of what it did not reach.
  if (complete) await dropStaleDigests(config, live, unknown);

  return out;
}

/** The digests of a workspace that are open, and the last one each operator was sent. */
async function digestMemory(
  config: ServerConfig,
  workspaceId: string,
  now: Date,
): Promise<{
  open: Map<string, { id: string; status: string }>;
  sent: Map<string, { sentAt: string; conversationIds: string[]; coveredThrough: string | null }>;
} | null> {
  const [openRead, sentRead] = await Promise.all([
    sb(config)
      .from('notification_email_jobs')
      .select('id, user_id, status')
      .eq('workspace_id', workspaceId)
      .eq('type', 'unread_messages')
      .in('status', ['pending', 'sending']),
    sb(config)
      .from('notification_email_jobs')
      .select('user_id, sent_at, conversation_ids, covered_through')
      .eq('workspace_id', workspaceId)
      .eq('type', 'unread_messages')
      .eq('status', 'sent')
      .gte('sent_at', new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString())
      .order('sent_at', { ascending: false })
      .limit(1000),
  ]);
  const error = openRead.error ?? sentRead.error;
  if (error) {
    if (isMissingColumn(error)) {
      if (!warnedDigestMemory) {
        warnedDigestMemory = true;
        console.warn('[notification-email] the digest waits for migration 289c');
      }
    } else {
      console.error('[notification-email] digest sweep failed', { message: error.message });
    }
    return null;
  }

  const open = new Map<string, { id: string; status: string }>();
  for (const row of (openRead.data ?? []) as Array<{ id: string; user_id: string; status: string }>) {
    open.set(String(row.user_id), { id: String(row.id), status: String(row.status) });
  }
  const sent = new Map<string, { sentAt: string; conversationIds: string[]; coveredThrough: string | null }>();
  for (const row of (sentRead.data ?? []) as Array<{
    user_id: string; sent_at: string; conversation_ids: string[] | null; covered_through: string | null;
  }>) {
    const userId = String(row.user_id);
    if (sent.has(userId) || !row.sent_at) continue;
    sent.set(userId, {
      sentAt: String(row.sent_at),
      conversationIds: (row.conversation_ids ?? []).map(String),
      coveredThrough: row.covered_through ? new Date(row.covered_through).toISOString() : null,
    });
  }
  return { open, sent };
}

async function dropStaleDigests(config: ServerConfig, live: Set<string>, unknown: Set<string>): Promise<void> {
  const { data, error } = await sb(config)
    .from('notification_email_jobs')
    .select('id, user_id, workspace_id')
    .eq('type', 'unread_messages')
    .eq('status', 'pending')
    .limit(1000);
  if (error) return;
  for (const row of (data ?? []) as Array<{ id: string; user_id: string; workspace_id: string | null }>) {
    if (live.has(`${row.user_id}:${row.workspace_id}`) || unknown.has(String(row.workspace_id))) continue;
    await sb(config)
      .from('notification_email_jobs')
      .update({ status: 'skipped', last_error: 'nothing is waiting any more', payload: {} })
      .eq('id', row.id)
      .eq('status', 'pending');
  }
}

// ───────────────────────── the weekly summary ─────────────────────────

/** Workspaces counted per pass at most; the rest are counted on the next passes of the hour. */
const WEEKLY_WORKSPACES_PER_PASS = 100;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The weekly keys (operator, workspace, local date) this process has dealt
 * with: queued, found empty, or declined. So a workspace is counted once a
 * week for each operator, not on every pass of their hour.
 */
const handledWeeks = new Set<string>();

/** The weekday (0 = Sunday), hour and date at `now` in `zone`, or null for a zone Intl does not know. */
export function localWeekSlot(zone: string, now: Date): { dow: number; hour: number; date: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const dow = WEEKDAYS.indexOf(get('weekday'));
    const hour = Number(get('hour')) % 24;
    if (dow < 0 || !Number.isFinite(hour)) return null;
    return { dow, hour, date: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return null;
  }
}

/**
 * The zone an operator's week is read in when they never gave one: Tehran's
 * on the Iranian edition, else UTC.
 */
async function defaultSummaryZone(config: ServerConfig): Promise<string> {
  return (await getPlatformEditionOrNull(config).catch(() => null)) === 'iran' ? 'Asia/Tehran' : 'UTC';
}

/**
 * The operators who gave a zone: the one their browser recorded with their
 * quiet hours (user_notification_prefs, the web row), which is where this
 * product learns a person's time of day.
 */
async function operatorZones(config: ServerConfig): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  for (let after: string | null = null; zones.size < 100_000; ) {
    let query = sb(config)
      .from('user_notification_prefs')
      .select('user_id, quiet_hours_timezone')
      .eq('platform', 'web')
      .is('workspace_id', null);
    if (after) query = query.gt('user_id', after);
    const { data, error } = await query.order('user_id', { ascending: true }).limit(1000);
    if (error) break;
    const rows = (data ?? []) as Array<{ user_id: string; quiet_hours_timezone: string | null }>;
    if (!rows.length) break;
    for (const row of rows) {
      const zone = typeof row.quiet_hours_timezone === 'string' ? row.quiet_hours_timezone.trim() : '';
      if (zone && localWeekSlot(zone, new Date())) zones.set(String(row.user_id), zone);
    }
    after = String(rows[rows.length - 1].user_id);
  }
  return zones;
}

/**
 * Last week, counted once, in each operator's own week.
 *
 * It goes on the day and at the hour the admin chose, read in the operator's
 * own time zone (the one their browser recorded with their quiet hours),
 * else the platform's (Tehran on the Iranian edition, else UTC): so it
 * reaches each person at the same time of their morning rather than all at
 * one UTC instant, and the week is spread over a day rather than burst at
 * once. One mail per operator per workspace per local date (its key), to the
 * members with an Inbox (its link is the Inbox), and nothing for a
 * workspace where nothing happened.
 *
 * Every workspace is reached, page by page; a pass counts at most
 * WEEKLY_WORKSPACES_PER_PASS of them and the next passes of the hour take
 * the rest, skipping what is queued already.
 */
export async function sweepWeeklySummary(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<SweepResult> {
  const out: SweepResult = { workspaces: 0, queued: 0 };
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'weekly_summary')) return out;

  const dueIn = (zone: string): string | null => {
    const slot = localWeekSlot(zone, now);
    return slot && slot.dow === settings.weekly_summary_dow && slot.hour === settings.weekly_summary_hour ? slot.date : null;
  };
  const fallbackDate = dueIn(await defaultSummaryZone(config));
  const zones = await operatorZones(config);
  const zoneDates = new Map<string, string | null>();
  const dateInZone = (zone: string): string | null => {
    if (!zoneDates.has(zone)) zoneDates.set(zone, dueIn(zone));
    return zoneDates.get(zone) ?? null;
  };
  const dateFor = (userId: string): string | null => {
    const zone = zones.get(userId);
    return zone ? dateInZone(zone) : fallbackDate;
  };
  // Nobody's hour anywhere: nothing to read.
  if (!fallbackDate && ![...new Set(zones.values())].some((zone) => dateInZone(zone) !== null)) return out;
  if (handledWeeks.size > 50_000) handledWeeks.clear();

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  let counted = 0;

  for (let after: string | null = null; ; ) {
    let query = sb(config).from('workspaces').select('id, name');
    if (after) query = query.gt('id', after);
    const { data, error } = await query.order('id', { ascending: true }).limit(200);
    if (error) {
      console.error('[notification-email] weekly sweep failed', { message: error.message });
      return out;
    }
    const page = (data ?? []) as Array<{ id: string; name: string | null }>;
    if (!page.length) break;
    after = String(page[page.length - 1].id);

    for (const row of page) {
      const workspaceId = String(row.id);
      const due = (await audienceFor(config, workspaceId, 'weekly_summary'))
        .map((userId) => ({ userId, date: dateFor(userId) }))
        .filter((d): d is { userId: string; date: string } => d.date !== null)
        .map((d) => ({ ...d, key: `weekly:${d.userId}:${workspaceId}:${d.date}` }))
        .filter((d) => !handledWeeks.has(d.key));
      if (!due.length) continue;

      const { data: existing } = await sb(config)
        .from('notification_email_jobs')
        .select('dedupe_key')
        .in('dedupe_key', due.map((d) => d.key));
      const done = new Set(((existing ?? []) as Array<{ dedupe_key: string }>).map((r) => String(r.dedupe_key)));
      const todo = due.filter((d) => !done.has(d.key));
      if (!todo.length) continue;

      if (counted >= WEEKLY_WORKSPACES_PER_PASS) return out;
      counted += 1;
      const counts = await weekCounts(config, workspaceId, since, now);
      for (const d of todo) handledWeeks.add(d.key);
      // Nothing happened; say nothing.
      if (!counts.conversations && !counts.messages) continue;

      const url = await appUrl(config, workspaceId, '/inbox');
      out.workspaces += 1;
      for (const d of todo) {
        const queued = await enqueueNotificationEmail(config, {
          userId: d.userId,
          workspaceId,
          type: 'weekly_summary',
          dedupeKey: d.key,
          payload: {
            workspace: row.name ?? '—',
            conversations: counts.conversations,
            resolved: counts.resolved,
            messages: counts.messages,
            action_url: url,
          },
        });
        if (queued.queued) out.queued += 1;
      }
    }
  }

  return out;
}

/**
 * The week, counted.
 *
 * "Resolved" is the team's resolves (shared/inactivityClose.ts
 * conversationEndOf, as operatorActivity.ts counts them): resolved, closed by
 * an operator, or resolved and then closed by the timer (which never moves
 * updated_at, so the resolve stays in its week). A conversation the timer
 * closed from open or pending is nobody's resolve and is left out.
 *
 * `conversation_messages` carries no workspace of its own — it belongs to a
 * conversation, which belongs to a workspace — so the message count goes
 * through the conversations touched in the window. Bounded at a thousand,
 * which is a busy week for one workspace and cheap for a job that runs once.
 */
export async function weekCounts(
  config: ServerConfig,
  workspaceId: string,
  since: Date,
  until: Date,
): Promise<{ conversations: number; resolved: number; messages: number }> {
  const client = sb(config);
  const iso = (d: Date) => d.toISOString();

  const [opened, ended, autoClosed, touched] = await Promise.all([
    client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', iso(since))
      .lt('created_at', iso(until)),
    client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .in('status', ['resolved', 'closed'])
      .gte('updated_at', iso(since))
      .lt('updated_at', iso(until)),
    // conversationEndOf's closed_inactive: closed by the timer, not from resolved.
    client
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'closed')
      .eq('metadata->>closed_reason', 'inactivity')
      .or('metadata->>closed_from.is.null,metadata->>closed_from.neq.resolved')
      .gte('updated_at', iso(since))
      .lt('updated_at', iso(until)),
    client
      .from('conversations')
      .select('id')
      .eq('workspace_id', workspaceId)
      .gte('updated_at', iso(since))
      .limit(1000),
  ]);

  const ids = ((touched.data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  let messages = 0;
  if (ids.length) {
    const { count } = await client
      .from('conversation_messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', ids)
      .gte('created_at', iso(since))
      .lt('created_at', iso(until));
    messages = count ?? 0;
  }

  return {
    conversations: opened.count ?? 0,
    resolved: Math.max(0, (ended.count ?? 0) - (autoClosed.count ?? 0)),
    messages,
  };
}

async function workspaceName(config: ServerConfig, workspaceId: string): Promise<string> {
  const { data } = await sb(config).from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
  return String((data as { name?: string } | null)?.name ?? '—');
}

// ───────────────────────── the transcript ─────────────────────────

/**
 * The conversation that was just closed, to whoever handled it.
 *
 * Not to the whole workspace: a transcript is a record of work somebody did,
 * and everybody else's inbox does not need a copy of every conversation the
 * team closes. The assignee if there is one, and the operator who resolved
 * it either way, each only while an active member of the workspace whose
 * seat the plan has not paused.
 */
export async function queueTranscript(
  config: ServerConfig,
  args: { conversationId: string; workspaceId: string; actorId: string | null },
): Promise<number> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'transcripts')) return 0;

  const { data: conversation } = await sb(config)
    .from('conversations')
    .select('id, subject, assigned_to, contact_id, updated_at')
    .eq('id', args.conversationId)
    .maybeSingle();
  if (!conversation) return 0;

  const row = conversation as {
    subject: string | null;
    assigned_to: string | null;
    contact_id: string | null;
    updated_at: string | null;
  };

  const members = new Set(await audienceFor(config, args.workspaceId, 'transcripts'));
  const recipients = new Set<string>();
  for (const id of [row.assigned_to, args.actorId]) {
    if (id && members.has(String(id))) recipients.add(String(id));
  }
  if (!recipients.size) return 0;

  const [locales, contact, workspace, url] = await Promise.all([
    operatorLocales(config, [...recipients]),
    contactName(config, row.contact_id),
    workspaceName(config, args.workspaceId),
    appUrl(config, args.workspaceId, `/inbox?c=${encodeURIComponent(args.conversationId)}`),
  ]);

  // Each recipient reads the transcript (its system lines) and the mail in
  // their own language: rendered once per language among them.
  const transcripts = new Map<OperatorLocale, Promise<string[]>>();
  const transcriptIn = (locale: OperatorLocale) => {
    let pending = transcripts.get(locale);
    if (!pending) {
      pending = renderTranscript(config, args.conversationId, locale);
      transcripts.set(locale, pending);
    }
    return pending;
  };

  let queued = 0;
  for (const userId of recipients) {
    const locale = locales.get(userId) ?? 'en';
    const result = await enqueueNotificationEmail(config, {
      userId,
      workspaceId: args.workspaceId,
      type: 'transcripts',
      // One per operator per conversation: reopening and resolving again
      // does not send a second copy, which is the right answer — the
      // transcript they have is of the same conversation.
      dedupeKey: `transcript:${userId}:${args.conversationId}`,
      locale,
      conversationIds: [args.conversationId],
      payload: {
        subject: isPlaceholderSubject(row.subject) ? '—' : String(row.subject),
        contact,
        workspace,
        resolved_at: row.updated_at ?? '',
        transcript_lines: await transcriptIn(locale),
        action_url: url,
      },
    });
    if (result.queued) queued += 1;
  }
  return queued;
}

/**
 * The last of the conversation (its newest 200 messages, oldest first), as
 * plain lines: "← …" from the customer, "→ …" from the team, "· …" a system
 * line. The dispatcher makes the HTML from them, escaped, one chat row each,
 * and keeps the newest that fit the mail (transcriptEmailRows.ts).
 *
 * A system row's stored body is English (`body` = fallback, readers write
 * the sentence from `metadata.kind`), so it is written in the reader's
 * language with the inbox's own sentence; one the localizer cannot write is
 * left out rather than mailed in English. Internal notices stay: the reader
 * is an operator.
 */
async function renderTranscript(config: ServerConfig, conversationId: string, locale: OperatorLocale): Promise<string[]> {
  const { data } = await sb(config)
    .from('conversation_messages')
    .select('sender_type, body, created_at, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = ((data ?? []) as Array<{ sender_type: string; body: string | null; created_at: string | null; metadata?: unknown }>).reverse();
  const lines: string[] = [];
  for (const m of rows) {
    const text = m.sender_type === 'system' ? operatorSystemText(m.metadata, locale) : String(m.body ?? '');
    if (text === null) continue;
    const mark = m.sender_type === 'contact' ? '←' : m.sender_type === 'system' ? '·' : '→';
    lines.push(`${mark} ${text.slice(0, 2000)}`);
  }
  return lines;
}

async function contactName(config: ServerConfig, contactId: string | null): Promise<string> {
  if (!contactId) return '—';
  const { data } = await sb(config).from('contacts').select('name, email').eq('id', contactId).maybeSingle();
  const row = (data ?? {}) as { name?: string | null; email?: string | null };
  // Older anonymous contacts carry the literal 'Visitor' as a name: no name.
  const name = (row.name ?? '').trim();
  return String((name && name.toLowerCase() !== ANON_CONTACT_NAME.toLowerCase() ? name : '') || row.email || '—');
}

// ───────────────────────── the payment notice ─────────────────────────

/**
 * Money arrived, to the people whose money it is.
 *
 * Raised by every settled payment (billing/account/effects.ts,
 * afterAccountSettlement: a checkout, a card charge or renewal, a card
 * transfer), once per payment (its key). Owners and workspace admins only:
 * an operator who answers chats has no business being told what the company
 * paid, and the audience rule in `types.ts` is what enforces it. The
 * workspace's billing recipient is left out: the receipt (or the card
 * renewal mail) already told that address, and one payment is one mail. The
 * amount is written in each recipient's language, as the billing mail
 * writes it.
 */
export async function queueInvoicePaid(
  config: ServerConfig,
  args: {
    workspaceId: string;
    amountMinor: number;
    currency: string;
    /** What names the payment (its ledger row, else the payment): the mail's key. */
    paymentKey: string;
    receiptNumber?: string | null;
  },
): Promise<number> {
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'paid_invoices')) return 0;
  if (!args.paymentKey || !Number.isFinite(args.amountMinor)) return 0;

  const audience = await audienceFor(config, args.workspaceId, 'paid_invoices');
  if (!audience.length) return 0;

  const [workspace, url, edition, billing, profiles] = await Promise.all([
    workspaceName(config, args.workspaceId),
    appUrl(config, args.workspaceId, '/billing'),
    getPlatformEditionOrNull(config).catch(() => null),
    billingRecipient(config, args.workspaceId).catch(() => null),
    sb(config).from('profiles').select('id, email').in('id', audience),
  ]);
  const emailOf = new Map(
    ((profiles.data ?? []) as Array<{ id: string; email: string | null }>).map((p) => [String(p.id), String(p.email ?? '').trim().toLowerCase()]),
  );
  const billingAddress = billing?.email.trim().toLowerCase() ?? '';
  const recipients = audience.filter((userId) => !billingAddress || emailOf.get(userId) !== billingAddress);
  if (!recipients.length) return 0;

  const locales = await operatorLocales(config, recipients);
  let queued = 0;
  for (const userId of recipients) {
    const locale = locales.get(userId) ?? 'en';
    const result = await enqueueNotificationEmail(config, {
      userId,
      workspaceId: args.workspaceId,
      type: 'paid_invoices',
      dedupeKey: `invoice:${userId}:${args.paymentKey}:${args.workspaceId}`,
      locale,
      payload: {
        workspace,
        amount: formatBillingMoney(edition, locale, args.currency, args.amountMinor),
        invoice_label: args.receiptNumber ? ` (${args.receiptNumber})` : '',
        action_url: url,
      },
    });
    if (result.queued) queued += 1;
  }
  return queued;
}

// ───────────────────────── the announcement ─────────────────────────

/**
 * At most this many operators are queued an announcement per hour. The
 * relay's address is new, and a burst of identical promotional mail is what
 * a receiving server reads as spam, on the same IP and From as the password
 * resets.
 */
export const ANNOUNCEMENTS_PER_HOUR = 200;

/** An announcement not fanned out by then is closed: a week-old announcement is not news. */
const ANNOUNCEMENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

let warnedAnnouncements = false;

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  fanout_cursor: string | null;
  recipients_queued: number;
  created_at: string;
}

/**
 * What Super Admin wants every operator to read, a page at a time.
 *
 * The request that sends one only writes it down (adminNotificationEmail.ts);
 * the ticker, under its lease, queues it here to the next operators in user
 * order, from where it stopped, until the hour's allowance
 * (ANNOUNCEMENTS_PER_HOUR, counted from the queue itself) is spent. Each
 * operator once (the key), whatever their number of workspaces; never one
 * suspended everywhere they belong; and bounded by the same two switches as
 * everything else: the platform's, and each operator's own. Its jobs are
 * platform mail (no workspace).
 */
export async function fanOutAnnouncements(
  config: ServerConfig,
  now: Date = new Date(),
): Promise<{ queued: number }> {
  const out = { queued: 0 };
  const settings = await loadNotificationEmailSettings(config);
  if (!isTypeEnabled(settings, 'product_updates')) return out;

  const { data, error } = await sb(config)
    .from('notification_email_announcements')
    .select('id, title, body, fanout_cursor, recipients_queued, created_at')
    .eq('status', 'sending')
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) {
    if (!warnedAnnouncements) {
      warnedAnnouncements = true;
      console.warn('[notification-email] announcements unreadable (migration 289c?)', { message: error.message });
    }
    return out;
  }
  const announcements = (data ?? []) as AnnouncementRow[];
  if (!announcements.length) return out;

  const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
  const used = await sb(config)
    .from('notification_email_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'product_updates')
    .gte('created_at', hourAgo);
  if (used.error) return out;
  let budget = ANNOUNCEMENTS_PER_HOUR - (used.count ?? 0);

  for (const announcement of announcements) {
    if (now.getTime() - Date.parse(announcement.created_at) > ANNOUNCEMENT_MAX_AGE_MS) {
      await cancelAnnouncement(config, announcement.id);
      continue;
    }
    let cursor = announcement.fanout_cursor;
    let queuedHere = 0;
    let finished = false;

    while (budget > 0) {
      let query = sb(config).from('workspace_members').select('user_id').is('suspended_at', null);
      if (cursor) query = query.gt('user_id', cursor);
      const { data: members, error: membersError } = await query.order('user_id', { ascending: true }).limit(200);
      if (membersError) break;
      const users = [...new Set(((members ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id)))];
      if (!users.length) {
        finished = true;
        break;
      }

      let stop = false;
      for (const userId of users) {
        if (budget <= 0) break;
        const result = await enqueueNotificationEmail(config, {
          userId,
          workspaceId: null,
          type: 'product_updates',
          dedupeKey: `announcement:${userId}:${announcement.id}`,
          payload: { title: announcement.title, body: announcement.body },
        });
        // A database fault: this operator is tried again on the next pass.
        if (result.reason === 'error') {
          stop = true;
          break;
        }
        // The platform switched announcements off meanwhile: they wait.
        if (result.reason === 'platform_disabled') {
          stop = true;
          break;
        }
        cursor = userId;
        if (result.queued) {
          queuedHere += 1;
          budget -= 1;
        }
      }
      if (stop) break;
    }

    if (cursor !== announcement.fanout_cursor || queuedHere || finished) {
      const nowIso = new Date().toISOString();
      await sb(config)
        .from('notification_email_announcements')
        .update({
          fanout_cursor: cursor,
          recipients_queued: announcement.recipients_queued + queuedHere,
          updated_at: nowIso,
          ...(finished ? { status: 'done', finished_at: nowIso } : {}),
        })
        .eq('id', announcement.id)
        .eq('status', 'sending');
    }
    out.queued += queuedHere;
    if (budget <= 0) break;
  }
  return out;
}

async function cancelAnnouncement(config: ServerConfig, id: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await sb(config)
    .from('notification_email_announcements')
    .update({ status: 'cancelled', finished_at: nowIso, updated_at: nowIso })
    .eq('id', id)
    .eq('status', 'sending');
}
