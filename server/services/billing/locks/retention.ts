// ============================================================================
// SIMPLE BILLING phase 4 — deletion of locked data, the hourly job's `locks`
// step (docs/billing/SIMPLE_BILLING.md: "Locked data is deleted after the
// plan's retention days, after notices 30 and 7 days before"; design §8).
//
// Per workspace (at most RETENTION_WORKSPACES_PER_TICK an hour: those with
// an open episode first, then the next active workspaces, each in rotation):
//
//   1. a locked agent's open chats go back to the queue (locks/release.ts);
//   2. billing_lock_clock_observe: the deletion clock (265). An episode opens
//      when a kind is first seen locked and is removed once nothing is (an
//      upgrade, deletions, an override); chats run in monthly batches;
//   3. with the plan's locked_data_retention_days (L; none by default), the
//      30-day notice from 30 days before the deadline, then the 7-day notice
//      from 7 days before the deadline the 30-day notice set. Each is claimed
//      on the clock first (one replica sends it; the 30-day claim fixes the
//      cutoff it announces) and recorded only once its mail went out, so an
//      unsent notice never leads to a deletion. Episodes due the same day
//      share one mail;
//   4. once both notices went out and the deadline passed (the latest of the
//      base deadline, 30 days after the 30-day notice and 7 days after the
//      7-day one), the rows still locked and announced by the 30-day notice
//      (billing_locked_delete_targets), deleted by billing_locked_delete,
//      which checks all of it again in SQL under the account lock, in chunks;
//      then the storage objects of the rows that are gone (contact avatars,
//      chat attachments).
//
// While the edition's switch is off nothing is noticed or deleted; the open
// episodes are only observed, which removes them (nothing is locked), so a
// switch turned on again starts a new clock with new notices.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { deleteFile } from '../../storage/index.js';
import { resolveWorkspaceAppUrl } from '../../auth-email.js';
import { localizedPlanName, planNamesFor, sendBillingEmail, type BillingEmailContext } from '../account/notify.js';
import { clearLockStateCache, readEffectivePlanId, readLocksEnabled } from './state.js';
import { releaseLockedAgentChats } from './release.js';

/** Workspaces handled per hourly run. */
export const RETENTION_WORKSPACES_PER_TICK = 200;
/** Rows read, cleared from storage and deleted at a time. */
const DELETE_CHUNK = 500;
/** Chunks per episode per run; the rest waits for the next hour. */
const MAX_CHUNKS = 20;
const DAY_MS = 86_400_000;

export type DeletableKind = 'kb_article' | 'contact' | 'conversation';
const DELETABLE: readonly DeletableKind[] = ['kb_article', 'contact', 'conversation'];

/** One row of billing_lock_clocks. */
export interface LockClock {
  workspace_id: string;
  kind: DeletableKind;
  episode_key: string;
  since: string;
  cutoff_at: string | null;
  locked_count: number;
  notice_30_at: string | null;
  notice_7_at: string | null;
  deleted_at: string | null;
}

export interface LockRetentionReport {
  skipped?: boolean;
  workspaces: number;
  released: number;
  notices: number;
  deleted: Record<DeletableKind, number>;
  errors: string[];
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * The base deadline of an episode: count kinds since + L days; chats the
 * batch date (the key, 00:00 UTC). Null without L or with an unreadable row.
 */
export function episodeBase(clock: Pick<LockClock, 'kind' | 'since' | 'episode_key'>, retentionDays: number | null): number | null {
  if (retentionDays === null || !(retentionDays > 0)) return null;
  if (clock.kind === 'conversation') return ms(`${clock.episode_key}T00:00:00Z`);
  const since = ms(clock.since);
  return since === null ? null : since + retentionDays * DAY_MS;
}

/** The notice an episode is due for now, if any: the 30-day one first, the 7-day one only after it. */
export function noticeDue(clock: LockClock, retentionDays: number | null, now: number): '30' | '7' | null {
  if (clock.deleted_at) return null;
  const base = episodeBase(clock, retentionDays);
  if (base === null) return null;
  const n30 = ms(clock.notice_30_at);
  if (n30 === null) return now >= base - 30 * DAY_MS ? '30' : null;
  if (clock.notice_7_at) return null;
  return now >= Math.max(base, n30 + 30 * DAY_MS) - 7 * DAY_MS ? '7' : null;
}

/**
 * The deletion date a notice sent now names: for the 30-day one the base
 * deadline or 30 days from now; for the 7-day one also 30 days after the
 * 30-day notice, or 7 days from now. A late notice never shortens its period.
 */
export function noticeDeadline(clock: LockClock, retentionDays: number | null, which: '30' | '7', now: number): number | null {
  const base = episodeBase(clock, retentionDays);
  if (base === null) return null;
  if (which === '30') return Math.max(base, now + 30 * DAY_MS);
  const n30 = ms(clock.notice_30_at) ?? now;
  return Math.max(base, n30 + 30 * DAY_MS, now + 7 * DAY_MS);
}

/**
 * When an episode's rows may be deleted (the TypeScript twin of 265's
 * billing_lock_episode_deadline, which billing_locked_delete checks again):
 * both notices recorded, the latest of the base deadline, 30 days after the
 * 30-day notice and 7 days after the 7-day notice. Null while it may not.
 */
export function deletionDeadline(clock: LockClock, retentionDays: number | null): number | null {
  if (clock.deleted_at) return null;
  const base = episodeBase(clock, retentionDays);
  const n30 = ms(clock.notice_30_at);
  const n7 = ms(clock.notice_7_at);
  if (base === null || n30 === null || n7 === null) return null;
  return Math.max(base, n30 + 30 * DAY_MS, n7 + 7 * DAY_MS);
}

const NOUNS: Record<string, Record<DeletableKind, [string, string]>> = {
  en: { kb_article: ['article', 'articles'], contact: ['contact', 'contacts'], conversation: ['chat', 'chats'] },
  fa: { kb_article: ['مقاله', 'مقاله'], contact: ['مخاطب', 'مخاطب'], conversation: ['گفتگو', 'گفتگو'] },
  tr: { kb_article: ['makale', 'makale'], contact: ['kişi', 'kişi'], conversation: ['sohbet', 'sohbet'] },
};

/** "12 articles, 340 contacts, 1,200 chats" in the mail's language and digits. */
export function lockedSummary(
  counts: Partial<Record<DeletableKind, number>>,
  locale: string,
  number: (value: number) => string,
): string {
  const nouns = NOUNS[locale] ?? NOUNS.en;
  const parts = DELETABLE
    .filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => {
      const n = counts[kind] as number;
      return `${number(n)} ${nouns[kind][n === 1 ? 0 : 1]}`;
    });
  return parts.join(locale === 'fa' ? '، ' : ', ');
}

function parseClock(row: Record<string, unknown>): LockClock | null {
  const kind = String(row.kind ?? '') as DeletableKind;
  if (!DELETABLE.includes(kind) || typeof row.workspace_id !== 'string' || typeof row.episode_key !== 'string') return null;
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(String(v)).toISOString());
  return {
    workspace_id: row.workspace_id,
    kind,
    episode_key: row.episode_key,
    since: iso(row.since) ?? new Date(0).toISOString(),
    cutoff_at: iso(row.cutoff_at),
    locked_count: Number(row.locked_count ?? 0) || 0,
    notice_30_at: iso(row.notice_30_at),
    notice_7_at: iso(row.notice_7_at),
    deleted_at: iso(row.deleted_at),
  };
}

type Client = ReturnType<typeof getServiceClient>;

/** billing_lock_clock_observe(ws): the open episodes after observing them. */
export async function observeLockClock(sb: Client, workspaceId: string): Promise<LockClock[]> {
  const { data, error } = await sb.rpc('billing_lock_clock_observe', { p_workspace_id: workspaceId });
  if (error) throw new Error(`billing_lock_clock_observe: ${error.message || 'failed'}`);
  return (Array.isArray(data) ? data : data ? [data] : [])
    .map((row) => parseClock(row as Record<string, unknown>))
    .filter((c): c is LockClock => c !== null && !c.deleted_at);
}

// Two rotations, kept in memory: over the workspaces with an open episode
// (they need their notices and deletions) and over every active workspace
// (to see new locks). The process holding the ticker lease walks on from
// where it stopped, so no workspace waits behind the first ones in id
// order; a restart starts over.
const cursors: { clock: string | null; active: string | null } = { clock: null, active: null };

/** For tests. */
export function resetRetentionCursor(): void {
  cursors.clock = null;
  cursors.active = null;
}

/** One page of distinct workspace ids after `after`, in id order; `end` when the list ran out. */
type PageReader = (after: string | null) => Promise<{ ids: string[]; end: boolean }>;

/** Up to `limit` ids after the rotation's cursor, wrapping around once. */
async function rotate(which: keyof typeof cursors, read: PageReader, limit: number, skip: Set<string>): Promise<string[]> {
  if (limit <= 0) return [];
  const out: string[] = [];
  let wrapped = false;
  let page = await read(cursors[which]);
  while (out.length < limit) {
    for (const id of page.ids) {
      if (out.length >= limit) break;
      cursors[which] = id;
      if (!skip.has(id) && !out.includes(id)) out.push(id);
    }
    if (out.length >= limit) break;
    if (page.end) {
      // The end of the list: the next page starts over, once per run.
      cursors[which] = null;
      if (wrapped) break;
      wrapped = true;
    }
    page = await read(cursors[which]);
  }
  return out;
}

/** Workspaces with an open episode. */
const clockPages = (sb: Client, limit: number): PageReader => async (after) => {
  const rows = Math.max(limit * 4, 100);
  let query = sb.from('billing_lock_clocks').select('workspace_id').is('deleted_at', null)
    .order('workspace_id', { ascending: true }).limit(rows);
  if (after) query = query.gt('workspace_id', after);
  const { data, error } = await query;
  if (error) throw new Error(`billing_lock_clocks: ${error.message}`);
  const list = (data ?? []) as Array<{ workspace_id: string }>;
  return { ids: [...new Set(list.map((r) => r.workspace_id))], end: list.length < rows };
};

/** Active workspaces. */
const activePages = (sb: Client, limit: number): PageReader => async (after) => {
  let query = sb.from('workspaces').select('id').eq('status', 'active').order('id', { ascending: true }).limit(limit);
  if (after) query = query.gt('id', after);
  const { data, error } = await query;
  if (error) throw new Error(`workspaces: ${error.message}`);
  const list = (data ?? []) as Array<{ id: string }>;
  return { ids: list.map((r) => r.id), end: list.length < limit };
};

/** The effective plan's locked_data_retention_days and its names (null: kept forever). */
async function planRetention(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ days: number | null; planId: string | null }> {
  const planId = await readEffectivePlanId(config, workspaceId);
  if (!planId) return { days: null, planId: null };
  const { data, error } = await getServiceClient(config)
    .from('billing_plans')
    .select('locked_data_retention_days')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw new Error(`billing_plans: ${error.message}`);
  const raw = (data as { locked_data_retention_days?: unknown } | null)?.locked_data_retention_days;
  const days = raw === null || raw === undefined ? null : Number(raw);
  return { days: days !== null && Number.isInteger(days) && days > 0 ? days : null, planId };
}


/**
 * Sends one notice for episodes of a workspace due for it now. Each episode
 * is claimed first (billing_lock_notice_claim: only one replica wins it, and
 * the 30-day claim fixes what the notice announces); the notice is recorded
 * (notice_*_at) only after its mail went out, so a crash, a failed mail or a
 * failed write never leaves a notice that counts toward a deletion without
 * having been sent. A claim never confirmed expires after 30 minutes and the
 * mail goes out again. The mail names the latest deletion date of the group.
 * Returns the number of mails sent (0 or 1).
 */
async function sendNotice(
  config: ServerConfig,
  sb: Client,
  episodes: LockClock[],
  which: '30' | '7',
  deadline: number,
  planId: string | null,
  now: Date,
): Promise<number> {
  const column = which === '30' ? 'notice_30_at' : 'notice_7_at';
  const claimColumn = which === '30' ? 'notice_30_claimed_at' : 'notice_7_claimed_at';
  const claimed: Array<{ clock: LockClock; count: number; stamp: string }> = [];
  const release = async () => {
    for (const { clock, stamp } of claimed) {
      const { error } = await sb
        .from('billing_lock_clocks')
        .update({ [claimColumn]: null })
        .eq('workspace_id', clock.workspace_id)
        .eq('kind', clock.kind)
        .eq('episode_key', clock.episode_key)
        .eq(claimColumn, stamp);
      // A claim left behind only delays the notice: it expires.
      if (error) console.warn(`[billing-locks] claim of ${clock.workspace_id}/${clock.kind} not released: ${error.message}`);
    }
  };

  try {
    for (const clock of episodes) {
      const { data, error } = await sb.rpc('billing_lock_notice_claim', {
        p_workspace_id: clock.workspace_id,
        p_kind: clock.kind,
        p_episode_key: clock.episode_key,
        p_which: which,
      });
      if (error) throw new Error(`billing_lock_notice_claim: ${error.message || 'failed'}`);
      const row = (Array.isArray(data) ? data[0] : data) as { locked_count?: unknown; claimed_at?: unknown } | null | undefined;
      if (!row || row.claimed_at === null || row.claimed_at === undefined) continue;
      // Milliseconds (the claim is stamped so), whatever form the data layer returns.
      const stamp = new Date(row.claimed_at instanceof Date ? row.claimed_at : String(row.claimed_at)).toISOString();
      claimed.push({ clock, count: Number(row.locked_count ?? clock.locked_count) || 0, stamp });
    }
  } catch (e) {
    await release();
    throw e;
  }
  if (!claimed.length) return 0;

  let sent = false;
  try {
    const counts: Partial<Record<DeletableKind, number>> = {};
    for (const { clock, count } of claimed) counts[clock.kind] = (counts[clock.kind] ?? 0) + count;
    const workspaceId = claimed[0].clock.workspace_id;
    const plans = await planNamesFor(config, [planId]);
    const exportUrl = await resolveWorkspaceAppUrl(config, workspaceId, '/billing');
    const daysLeft = Math.max(Math.ceil((deadline - now.getTime()) / DAY_MS), 1);
    const result = await sendBillingEmail(config, workspaceId, 'billing_locked_data_deletion', (ctx: BillingEmailContext) => ({
      plan_name: localizedPlanName(plans.get(planId ?? ''), ctx.locale),
      days_left: ctx.number(daysLeft),
      deletion_date: ctx.date(new Date(deadline).toISOString()),
      locked_summary: lockedSummary(counts, ctx.locale, ctx.number),
      export_url: exportUrl,
    }));
    sent = result.sent === true;
  } finally {
    if (!sent) await release();
  }
  if (!sent) return 0;

  // The mail went out: record the notice (it now counts toward the deadline).
  const stamp = now.toISOString();
  for (const { clock, stamp: claimStamp } of claimed) {
    const { error } = await sb
      .from('billing_lock_clocks')
      .update({ [column]: stamp, [claimColumn]: null })
      .eq('workspace_id', clock.workspace_id)
      .eq('kind', clock.kind)
      .eq('episode_key', clock.episode_key)
      .eq(claimColumn, claimStamp)
      .is(column, null);
    // Unrecorded, the notice does not count: its claim expires and the mail
    // goes out again (a duplicate mail, never a deletion without a notice).
    if (error) throw new Error(`billing_lock_clocks: ${error.message}`);
  }
  return 1;
}

/**
 * The rows of an episode that may be deleted now, oldest first
 * (billing_locked_delete_targets: the deadline, the switch, locked now and
 * announced by the 30-day notice), with what each holds in storage.
 */
async function deletionTargets(
  sb: Client,
  clock: LockClock,
): Promise<Array<{ id: string; avatar?: string | null }>> {
  const { data, error } = await sb
    .rpc('billing_locked_delete_targets', {
      p_workspace_id: clock.workspace_id,
      p_kind: clock.kind,
      p_episode_key: clock.episode_key,
      p_ids: null,
      p_max: DELETE_CHUNK,
    })
    .range(0, DELETE_CHUNK - 1);
  if (error) throw new Error(`billing_locked_delete_targets: ${error.message || 'failed'}`);
  const ids = (Array.isArray(data) ? data : [])
    .map((row) => (typeof row === 'string' ? row : (row as Record<string, unknown> | null)?.billing_locked_delete_targets))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!ids.length || clock.kind !== 'contact') return ids.map((id) => ({ id }));
  const { data: rows, error: readError } = await sb
    .from('contacts')
    .select('id, avatar_storage_key')
    .eq('workspace_id', clock.workspace_id)
    .in('id', ids);
  if (readError) throw new Error(`contacts: ${readError.message}`);
  const avatar = new Map(((rows ?? []) as Array<{ id: string; avatar_storage_key: string | null }>).map((r) => [r.id, r.avatar_storage_key]));
  return ids.map((id) => ({ id, avatar: avatar.get(id) ?? null }));
}

const isStorageKey = (key: string | null | undefined): key is string =>
  typeof key === 'string' && key.length > 0 && !/^[a-z]+:\/\//i.test(key) && !key.startsWith('/');

/** Rows the data layer returns per read. */
const READ_PAGE = 1000;

/** The storage objects of chats, every page of them (a chat can hold many). */
async function chatAttachmentPaths(sb: Client, workspaceId: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await sb
      .from('conversation_attachments')
      .select('id, conversation_id, storage_path')
      .eq('workspace_id', workspaceId)
      .in('conversation_id', ids)
      .order('id', { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) throw new Error(`conversation_attachments: ${error.message}`);
    const rows = (data ?? []) as Array<{ conversation_id: string; storage_path: string | null }>;
    for (const a of rows) {
      if (!isStorageKey(a.storage_path)) continue;
      const list = out.get(a.conversation_id) ?? [];
      list.push(a.storage_path);
      out.set(a.conversation_id, list);
    }
    if (rows.length < READ_PAGE) break;
  }
  return out;
}

/**
 * Removes the storage objects of rows billing_locked_delete has just
 * deleted. Only rows that are gone lose their files: a row the SQL kept (an
 * upgrade, the switch, a lock change in between) keeps them. A file that
 * cannot be deleted is left behind and logged, never a row's file lost.
 */
async function clearStorage(
  config: ServerConfig,
  sb: Client,
  clock: LockClock,
  gone: Array<{ id: string; avatar?: string | null }>,
  attachments: Map<string, string[]>,
): Promise<void> {
  const ws = clock.workspace_id;
  if (clock.kind === 'kb_article' || !gone.length) return;
  let failed = 0;
  if (clock.kind === 'contact') {
    const keys = [...new Set(gone.map((r) => r.avatar).filter(isStorageKey))];
    if (!keys.length) return;
    // An avatar another contact still shows stays.
    const { data, error } = await sb.from('contacts').select('avatar_storage_key').eq('workspace_id', ws).in('avatar_storage_key', keys);
    if (error) throw new Error(`contacts: ${error.message}`);
    const shared = new Set(((data ?? []) as Array<{ avatar_storage_key: string }>).map((r) => r.avatar_storage_key));
    for (const key of keys) {
      if (shared.has(key)) continue;
      const result = await deleteFile(config, ws, key, { allowLegacyKey: true });
      if (!result.success) failed += 1;
    }
  } else {
    for (const row of gone) {
      for (const path of attachments.get(row.id) ?? []) {
        const result = await deleteFile(config, ws, path);
        if (!result.success) failed += 1;
      }
    }
  }
  if (failed) console.warn(`[billing-locks] ${failed} file(s) of deleted ${clock.kind} rows of ${ws} could not be deleted`);
}

/** Deletes what an episode may delete now, in chunks. Returns the rows deleted. */
async function deleteEpisode(config: ServerConfig, sb: Client, clock: LockClock): Promise<number> {
  let deleted = 0;
  const table = clock.kind === 'kb_article' ? 'knowledge_base_articles' : clock.kind === 'contact' ? 'contacts' : 'conversations';
  for (let round = 0; round < MAX_CHUNKS; round += 1) {
    const rows = await deletionTargets(sb, clock);
    const ids = rows.map((r) => r.id);
    // The files are read before the rows go (a chat's attachments go with it).
    const attachments = clock.kind === 'conversation' && ids.length ? await chatAttachmentPaths(sb, clock.workspace_id, ids) : new Map<string, string[]>();
    // Called with an empty list too: it closes the episode once nothing of it is left.
    const { data, error } = await sb.rpc('billing_locked_delete', {
      p_workspace_id: clock.workspace_id,
      p_kind: clock.kind,
      p_episode_key: clock.episode_key,
      p_ids: ids,
    });
    if (error) throw new Error(`billing_locked_delete: ${error.message || 'failed'}`);
    const n = Number(data ?? 0) || 0;
    deleted += n;
    if (n > 0) {
      const left = new Set<string>();
      if (n < ids.length) {
        const { data: still, error: readError } = await sb.from(table).select('id').eq('workspace_id', clock.workspace_id).in('id', ids);
        if (readError) throw new Error(`${table}: ${readError.message}`);
        for (const r of (still ?? []) as Array<{ id: string }>) left.add(r.id);
      }
      await clearStorage(config, sb, clock, rows.filter((r) => !left.has(r.id)), attachments);
    }
    if (n === 0 || n < ids.length || ids.length < DELETE_CHUNK) break;
  }
  if (deleted > 0) clearLockStateCache(clock.workspace_id);
  return deleted;
}

/** One workspace: release, observe, notices, deletions. */
async function retainWorkspace(
  config: ServerConfig,
  sb: Client,
  workspaceId: string,
  now: Date,
  report: LockRetentionReport,
): Promise<void> {
  report.released += (await releaseLockedAgentChats(config, workspaceId)).length;
  const clocks = await observeLockClock(sb, workspaceId);
  if (!clocks.length) return;
  const { days, planId } = await planRetention(config, workspaceId);
  if (days === null) return; // the plan keeps locked data: no notice, no deletion

  const t = now.getTime();
  // Deletions first: an episode due for deletion was noticed in earlier runs.
  for (const clock of clocks) {
    const deadline = deletionDeadline(clock, days);
    if (deadline === null || t < deadline) continue;
    report.deleted[clock.kind] += await deleteEpisode(config, sb, clock);
  }

  // Notices, one mail per notice and deletion day.
  for (const which of ['30', '7'] as const) {
    const groups = new Map<string, { deadline: number; episodes: LockClock[] }>();
    for (const clock of clocks) {
      if (noticeDue(clock, days, t) !== which) continue;
      const deadline = noticeDeadline(clock, days, which, t);
      if (deadline === null) continue;
      const day = new Date(deadline).toISOString().slice(0, 10);
      const group = groups.get(day) ?? { deadline, episodes: [] };
      group.deadline = Math.max(group.deadline, deadline);
      group.episodes.push(clock);
      groups.set(day, group);
    }
    for (const group of groups.values()) {
      report.notices += await sendNotice(config, sb, group.episodes, which, group.deadline, planId, now);
    }
  }
}

/**
 * The `locks` step of the hourly job (job.ts, under the simple_billing
 * lease). Never throws for one workspace: its error is reported and the
 * next one runs.
 */
export async function runLockRetention(
  config: ServerConfig,
  now: Date = new Date(),
  limit: number = RETENTION_WORKSPACES_PER_TICK,
): Promise<LockRetentionReport> {
  const report: LockRetentionReport = {
    workspaces: 0,
    released: 0,
    notices: 0,
    deleted: { kb_article: 0, contact: 0, conversation: 0 },
    errors: [],
  };
  const sb = getServiceClient(config);
  const enabled = config.selfHostBillingUnlimited !== true && (await readLocksEnabled(config));
  const onTheClock = await rotate('clock', clockPages(sb, limit), limit, new Set());

  if (!enabled) {
    // Nothing is locked: observing removes the episodes left open.
    for (const workspaceId of onTheClock) {
      try {
        await observeLockClock(sb, workspaceId);
        report.workspaces += 1;
      } catch (e) {
        report.errors.push(`${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ...report, skipped: true };
  }

  const workspaces = [...onTheClock, ...(await rotate('active', activePages(sb, limit), limit - onTheClock.length, new Set(onTheClock)))];
  for (const workspaceId of workspaces) {
    try {
      await retainWorkspace(config, sb, workspaceId, now, report);
      report.workspaces += 1;
    } catch (e) {
      report.errors.push(`${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
