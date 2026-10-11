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
//      from 7 days before the deadline the 30-day notice set. Each is
//      recorded on the clock before the mail goes out (an atomic UPDATE …
//      WHERE notice IS NULL) and taken back when the mail fails, so it goes
//      out once and an unsent notice never leads to a deletion. Episodes due
//      the same day share one mail;
//   4. once both notices went out and the deadline passed (the latest of the
//      base deadline, 30 days after the 30-day notice and 7 days after the
//      7-day one), the rows still locked and named by the 30-day notice:
//      their storage objects first (contact avatars, chat attachments), then
//      billing_locked_delete, which checks all of it again in SQL under the
//      account lock, in chunks.
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
import { clearLockStateCache, readEffectivePlanId, readLockedIds, readLocksEnabled } from './state.js';
import { tsMicros } from './predicates.js';
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
 * is marked first (only one replica wins it); the mail names the latest
 * deletion date of the group; an unsent mail takes every mark back.
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
  const stamp = now.toISOString();
  const marked: LockClock[] = [];
  for (const clock of episodes) {
    let update = sb
      .from('billing_lock_clocks')
      .update({ [column]: stamp })
      .eq('workspace_id', clock.workspace_id)
      .eq('kind', clock.kind)
      .eq('episode_key', clock.episode_key)
      .is(column, null)
      .is('deleted_at', null);
    if (which === '7') update = update.not('notice_30_at', 'is', null);
    const { data, error } = await update.select('workspace_id');
    if (error) throw new Error(`billing_lock_clocks: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) marked.push(clock);
  }
  if (!marked.length) return 0;

  const counts: Partial<Record<DeletableKind, number>> = {};
  for (const clock of marked) counts[clock.kind] = (counts[clock.kind] ?? 0) + clock.locked_count;
  const workspaceId = marked[0].workspace_id;
  const plans = await planNamesFor(config, [planId]);
  const exportUrl = await resolveWorkspaceAppUrl(config, workspaceId, '/billing');
  const daysLeft = Math.max(Math.ceil((deadline - now.getTime()) / DAY_MS), 1);
  const sent = await sendBillingEmail(config, workspaceId, 'billing_locked_data_deletion', (ctx: BillingEmailContext) => ({
    plan_name: localizedPlanName(plans.get(planId ?? ''), ctx.locale),
    days_left: ctx.number(daysLeft),
    deletion_date: ctx.date(new Date(deadline).toISOString()),
    locked_summary: lockedSummary(counts, ctx.locale, ctx.number),
    export_url: exportUrl,
  }));
  if (sent.sent) return 1;
  for (const clock of marked) {
    await sb
      .from('billing_lock_clocks')
      .update({ [column]: null })
      .eq('workspace_id', clock.workspace_id)
      .eq('kind', clock.kind)
      .eq('episode_key', clock.episode_key)
      .eq(column, stamp);
  }
  return 0;
}

/** The candidates of one chunk: locked now and named by the 30-day notice (chats: before the noticed cutoff). */
async function chunkCandidates(
  sb: Client,
  clock: LockClock,
  ids: string[],
): Promise<Array<{ id: string; avatar?: string | null }>> {
  if (!ids.length) return [];
  const limitOf = (iso: string | null) => (iso ? tsMicros(iso) : null);
  if (clock.kind === 'conversation') {
    const cutoff = limitOf(clock.cutoff_at);
    if (cutoff === null) return [];
    const { data, error } = await sb.from('conversations').select('id, created_at, updated_at').eq('workspace_id', clock.workspace_id).in('id', ids);
    if (error) throw new Error(`conversations: ${error.message}`);
    return ((data ?? []) as Array<{ id: string; created_at: string | null; updated_at: string | null }>)
      .filter((r) => {
        const at = tsMicros(r.updated_at ?? r.created_at);
        return at === null || at < cutoff;
      })
      .map((r) => ({ id: r.id }));
  }
  const noticed = limitOf(clock.notice_30_at);
  if (noticed === null) return [];
  const table = clock.kind === 'kb_article' ? 'knowledge_base_articles' : 'contacts';
  const columns = clock.kind === 'contact' ? 'id, created_at, avatar_storage_key' : 'id, created_at';
  const { data, error } = await sb.from(table).select(columns).eq('workspace_id', clock.workspace_id).in('id', ids);
  if (error) throw new Error(`${table}: ${error.message}`);
  return ((data ?? []) as unknown as Array<{ id: string; created_at: string | null; avatar_storage_key?: string | null }>)
    .filter((r) => {
      const at = tsMicros(r.created_at);
      return at === null || at < noticed;
    })
    .map((r) => ({ id: r.id, avatar: r.avatar_storage_key ?? null }));
}

const isStorageKey = (key: string | null | undefined): key is string =>
  typeof key === 'string' && key.length > 0 && !/^[a-z]+:\/\//i.test(key) && !key.startsWith('/');

/**
 * Removes the storage objects of the candidates first, so a deleted row
 * never leaves an orphan behind. Returns the ids whose objects are gone; a
 * row whose object could not be deleted waits for the next run.
 */
async function clearStorage(
  config: ServerConfig,
  sb: Client,
  clock: LockClock,
  rows: Array<{ id: string; avatar?: string | null }>,
): Promise<string[]> {
  const ws = clock.workspace_id;
  if (clock.kind === 'kb_article' || !rows.length) return rows.map((r) => r.id);
  const failed = new Set<string>();
  if (clock.kind === 'contact') {
    const keys = [...new Set(rows.map((r) => r.avatar).filter(isStorageKey))];
    // An avatar another contact still shows stays.
    const shared = new Set<string>();
    if (keys.length) {
      const ids = new Set(rows.map((r) => r.id));
      const { data, error } = await sb.from('contacts').select('id, avatar_storage_key').eq('workspace_id', ws).in('avatar_storage_key', keys);
      if (error) throw new Error(`contacts: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; avatar_storage_key: string }>) if (!ids.has(r.id)) shared.add(r.avatar_storage_key);
    }
    for (const row of rows) {
      if (!isStorageKey(row.avatar) || shared.has(row.avatar)) continue;
      const result = await deleteFile(config, ws, row.avatar, { allowLegacyKey: true });
      if (!result.success) failed.add(row.id);
    }
  } else {
    const ids = rows.map((r) => r.id);
    const { data, error } = await sb
      .from('conversation_attachments')
      .select('id, conversation_id, storage_path')
      .eq('workspace_id', ws)
      .in('conversation_id', ids);
    if (error) throw new Error(`conversation_attachments: ${error.message}`);
    for (const a of (data ?? []) as Array<{ conversation_id: string; storage_path: string | null }>) {
      if (failed.has(a.conversation_id) || !isStorageKey(a.storage_path)) continue;
      const result = await deleteFile(config, ws, a.storage_path);
      if (!result.success) failed.add(a.conversation_id);
    }
  }
  if (failed.size) console.warn(`[billing-locks] ${failed.size} ${clock.kind} row(s) of ${ws} kept: their files could not be deleted`);
  return rows.map((r) => r.id).filter((id) => !failed.has(id));
}

/** Deletes what an episode may delete now, in chunks. Returns the rows deleted. */
async function deleteEpisode(config: ServerConfig, sb: Client, clock: LockClock): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < MAX_CHUNKS; round += 1) {
    const ids = await readLockedIds(config, clock.workspace_id, clock.kind, DELETE_CHUNK, sb);
    const rows = await chunkCandidates(sb, clock, ids);
    const ready = await clearStorage(config, sb, clock, rows);
    // Called with an empty list too: it closes the episode once nothing of it is left.
    const { data, error } = await sb.rpc('billing_locked_delete', {
      p_workspace_id: clock.workspace_id,
      p_kind: clock.kind,
      p_episode_key: clock.episode_key,
      p_ids: ready,
    });
    if (error) throw new Error(`billing_locked_delete: ${error.message || 'failed'}`);
    const n = Number(data ?? 0) || 0;
    deleted += n;
    if (n === 0 || ready.length < rows.length || rows.length < ids.length || ids.length < DELETE_CHUNK) break;
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
