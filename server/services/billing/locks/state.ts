// ============================================================================
// SIMPLE BILLING phase 4 — computed locks: a workspace's lock state
// (docs/billing/SIMPLE_BILLING.md "Over the limit after a downgrade").
//
// Nothing is stored. Migration 265 holds the one definition: per kind, the
// effective limit and the cutoff row (billing_lock_cutoff); a row ranked after
// the cutoff (created_at, id — oldest first) is locked, a chat whose last
// activity is before the retention cutoff is locked. This module reads those
// cutoffs, keeps them 60 s per workspace, and every read path asks it.
//
//   - Kill switch: billing_settings.locks_enabled of the running edition
//     (billing_locks_enabled()). Off = nothing is locked anywhere.
//   - Only explicit limits lock; absent, -1 or NULL is unlimited (SQL).
//   - Fail open: anything unreadable locks nothing. The create-time quotas
//     (requireLimit, kbArticleQuota) stay fail-closed.
//   - A self-host install with unlimited billing never locks.
//
// The cache holds cutoffs, not row lists, so a row created after the read is
// still judged against the cutoff; the article and member id lists are the
// exception (small, refetched with the cutoff).
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { coalesce } from '../../../lib/inflight.js';

export type LockKind = 'kb_article' | 'contact' | 'member' | 'conversation';

export const LOCK_KINDS: readonly LockKind[] = Object.freeze(['kb_article', 'contact', 'member', 'conversation']);

/**
 * The cutoff: for the count kinds the last row that stays active
 * (`ts` = its created_at or '-infinity', `id`); for chats the activity
 * cutoff (`ts`), with `id` null.
 */
export interface LockCut {
  ts: string;
  id: string | null;
}

export interface KindLock {
  /** The effective limit (for chats: the retention in days); null = unlimited. */
  limit: number | null;
  total: number;
  locked: number;
  /** Null = nothing is locked. */
  cut: LockCut | null;
  /** kb_article: the locked article ids; member: the locked members' user ids. */
  ids?: string[];
}

export interface LockState {
  enabled: boolean;
  kb: KindLock | null;
  contact: KindLock | null;
  member: KindLock | null;
  conversation: KindLock | null;
}

export const LOCK_STATE_KEY: Readonly<Record<LockKind, 'kb' | 'contact' | 'member' | 'conversation'>> = Object.freeze({
  kb_article: 'kb',
  contact: 'contact',
  member: 'member',
  conversation: 'conversation',
});

/** Nothing locked: the kill switch is off, or the state could not be read. */
export function unlockedState(): LockState {
  return { enabled: false, kb: null, contact: null, member: null, conversation: null };
}

// ─── The SQL (migration 265) ───────────────────────────────────────────────
// Every call into the lock functions goes through here, so their argument
// names live in one place.

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** Rows the data layer returns per call; longer id lists are read in pages. */
const ID_PAGE = 1000;
/** At most this many locked ids are held per kind (KB articles and seats are small). */
export const LOCKED_IDS_CAP = 5000;

type Client = ReturnType<typeof getServiceClient>;

function rpcError(name: string, error: { message?: string } | null | undefined): Error {
  return new Error(`${name}: ${error?.message || 'failed'}`);
}

/** billing_locks_enabled(): the running edition's kill switch. Throws when unreadable. */
export async function readLocksEnabled(config: ServerConfig): Promise<boolean> {
  const { data, error } = await getServiceClient(config).rpc('billing_locks_enabled');
  if (error) throw rpcError('billing_locks_enabled', error);
  return data === true;
}

/** billing_effective_plan_id(ws): the plan in force (the Free fallback included); null without one. */
export async function readEffectivePlanId(config: ServerConfig, workspaceId: string): Promise<string | null> {
  const { data, error } = await getServiceClient(config).rpc('billing_effective_plan_id', { p_workspace_id: workspaceId });
  if (error) throw rpcError('billing_effective_plan_id', error);
  return typeof data === 'string' && data ? data : null;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** One row of billing_lock_cutoff, as the data layer returns it (a set or one record). */
export function parseCutoffRow(data: unknown): KindLock {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') return { limit: null, total: 0, locked: 0, cut: null };
  const ts = row.cut_ts === null || row.cut_ts === undefined ? null : String(row.cut_ts);
  const id = row.cut_id === null || row.cut_id === undefined ? null : String(row.cut_id).toLowerCase();
  return {
    limit: numOrNull(row.lim),
    total: num(row.total),
    locked: num(row.locked),
    cut: ts ? { ts, id } : null,
  };
}

/** billing_lock_cutoff(ws, kind, plan): the effective plan when `planId` is null. Throws when unreadable. */
export async function readLockCutoff(
  config: ServerConfig,
  workspaceId: string,
  kind: LockKind,
  planId: string | null = null,
): Promise<KindLock> {
  const { data, error } = await getServiceClient(config).rpc('billing_lock_cutoff', {
    p_workspace_id: workspaceId,
    p_kind: kind,
    p_plan_id: planId,
  });
  if (error) throw rpcError('billing_lock_cutoff', error);
  return parseCutoffRow(data);
}

/**
 * billing_locked_ids(ws, kind): the locked rows, oldest first (members: their
 * user ids), at most `cap`. Read in pages: the data layer returns at most
 * 1000 rows per call. Throws when unreadable.
 */
export async function readLockedIds(
  config: ServerConfig,
  workspaceId: string,
  kind: LockKind,
  cap: number = LOCKED_IDS_CAP,
  sb: Client = getServiceClient(config),
): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < cap; from += ID_PAGE) {
    const to = Math.min(from + ID_PAGE, cap) - 1;
    const { data, error } = await sb
      .rpc('billing_locked_ids', { p_workspace_id: workspaceId, p_kind: kind, p_plan_id: null, p_max: cap })
      .range(from, to);
    if (error) throw rpcError('billing_locked_ids', error);
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const id = typeof row === 'string' ? row : (row as Record<string, unknown> | null)?.billing_locked_ids;
      if (typeof id === 'string' && id) out.push(id.toLowerCase());
    }
    if (rows.length < to - from + 1) break;
  }
  return out;
}

// ─── Cache ────────────────────────────────────────────────────────────────

const TTL_MS = 60_000;
const MAX_ENTRIES = 4000;

const kindCache = new Map<string, { value: KindLock; expiresAt: number }>();
let enabledCache: { value: boolean; expiresAt: number } | null = null;

function kindKey(workspaceId: string, kind: LockKind): string {
  return `${workspaceId}:${kind}`;
}

function bound(): void {
  if (kindCache.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of kindCache) if (entry.expiresAt <= now) kindCache.delete(key);
  let excess = kindCache.size - MAX_ENTRIES;
  for (const key of kindCache.keys()) {
    if (excess-- <= 0) break;
    kindCache.delete(key);
  }
}

/**
 * Forget the cached lock state: of one workspace (a plan change, an
 * override, a delete that frees a slot), or of all of them and the kill
 * switch (a plan edit, the Super Admin switch).
 */
export function clearLockStateCache(workspaceId?: string): void {
  if (!workspaceId) {
    kindCache.clear();
    enabledCache = null;
    return;
  }
  for (const kind of LOCK_KINDS) kindCache.delete(kindKey(workspaceId, kind));
}

/** How long an unreadable switch reads as off without asking again. */
const FAILED_TTL_MS = 30_000;

/**
 * The kill switch, cached 60 s. Throws when unreadable; the failure is then
 * remembered for 30 s as off, so a missing or failing billing_locks_enabled
 * (a replica ahead of migration 265, a database hiccup) costs one query and
 * one warning per window, not one per request.
 */
export async function locksEnabled(config: ServerConfig): Promise<boolean> {
  const now = Date.now();
  if (enabledCache && enabledCache.expiresAt > now) return enabledCache.value;
  let value: boolean;
  try {
    value = await coalesce('billing_locks_enabled', () => readLocksEnabled(config));
  } catch (e) {
    enabledCache = { value: false, expiresAt: Date.now() + FAILED_TTL_MS };
    throw e;
  }
  enabledCache = { value, expiresAt: Date.now() + TTL_MS };
  return value;
}

async function kindLock(config: ServerConfig, workspaceId: string, kind: LockKind): Promise<KindLock> {
  const key = kindKey(workspaceId, kind);
  const hit = kindCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await coalesce(`billing_lock:${key}`, async () => {
    const lock = await readLockCutoff(config, workspaceId, kind);
    if (lock.locked > 0 && (kind === 'kb_article' || kind === 'member')) {
      lock.ids = await readLockedIds(config, workspaceId, kind);
    } else if (kind === 'kb_article' || kind === 'member') {
      lock.ids = [];
    }
    return lock;
  });
  kindCache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  bound();
  return value;
}

/**
 * The lock state of a workspace, for `kinds` (all four by default). Never
 * throws: anything unreadable gives `{ enabled: false }`, which locks
 * nothing (S4, fail open).
 */
export async function resolveLockState(
  config: ServerConfig,
  workspaceId: string,
  kinds: readonly LockKind[] = LOCK_KINDS,
): Promise<LockState> {
  if (config.selfHostBillingUnlimited === true || !workspaceId) return unlockedState();
  try {
    if (!(await locksEnabled(config))) return unlockedState();
    const state: LockState = { enabled: true, kb: null, contact: null, member: null, conversation: null };
    const unique = [...new Set(kinds)];
    const locks = await Promise.all(unique.map((kind) => kindLock(config, workspaceId, kind)));
    unique.forEach((kind, i) => {
      state[LOCK_STATE_KEY[kind]] = locks[i];
    });
    return state;
  } catch (e) {
    console.warn('[billing-locks] lock state unreadable, nothing locked:', e instanceof Error ? e.message : e);
    return unlockedState();
  }
}

/** True when any of the state's kinds has a locked row. */
export function hasAnyLock(state: LockState): boolean {
  if (!state.enabled) return false;
  return [state.kb, state.contact, state.member, state.conversation].some((k) => (k?.locked ?? 0) > 0);
}

// ─── Deletion clock (billing_lock_clocks, written by the hourly job) ──────

export interface LockClockRow {
  kind: string;
  episode_key: string;
  since: string;
  cutoff_at?: string | null;
  locked_count?: number | null;
  notice_30_at: string | null;
  notice_7_at: string | null;
  deleted_at: string | null;
}

const DAY_MS = 86_400_000;

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * When an episode's rows are deleted at the earliest (design §8): the base
 * deadline (count kinds: since + L days; chats: the batch date), pushed so the
 * 30-day and 7-day notices both run their full time. A notice not sent yet is
 * counted from when it can still go out (now, or its own date). Null when the
 * plan keeps locked data forever (L null) or the episode is closed.
 */
export function clockDeadline(clock: LockClockRow, retentionDays: number | null, now = Date.now()): Date | null {
  if (clock.deleted_at) return null;
  if (retentionDays === null || !(retentionDays > 0)) return null;
  const base = clock.kind === 'conversation'
    ? ms(clock.episode_key)
    : (() => {
        const since = ms(clock.since);
        return since === null ? null : since + retentionDays * DAY_MS;
      })();
  if (base === null) return null;
  const n30 = ms(clock.notice_30_at) ?? Math.max(now, base - 30 * DAY_MS);
  const n7 = ms(clock.notice_7_at) ?? Math.max(now, base - 7 * DAY_MS, n30);
  return new Date(Math.max(base, n30 + 30 * DAY_MS, n7 + 7 * DAY_MS));
}

/**
 * The next date locked data of this workspace is deleted, from its open
 * clocks and the effective plan's locked_data_retention_days. Null while the
 * switch is off, the plan keeps it forever, or nothing is on the clock.
 * Never throws.
 */
export async function nextDeletionAt(config: ServerConfig, workspaceId: string, now = Date.now()): Promise<string | null> {
  try {
    if (config.selfHostBillingUnlimited === true || !(await locksEnabled(config))) return null;
    const sb = getServiceClient(config);
    const planId = await readEffectivePlanId(config, workspaceId);
    if (!planId) return null;
    const { data: plan, error: planError } = await sb
      .from('billing_plans')
      .select('locked_data_retention_days')
      .eq('id', planId)
      .maybeSingle();
    if (planError) throw planError;
    const retention = numOrNull((plan as { locked_data_retention_days?: unknown } | null)?.locked_data_retention_days);
    if (retention === null) return null;
    const { data, error } = await sb
      .from('billing_lock_clocks')
      .select('kind, episode_key, since, cutoff_at, locked_count, notice_30_at, notice_7_at, deleted_at')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);
    if (error) throw error;
    let best: number | null = null;
    for (const row of (data ?? []) as LockClockRow[]) {
      const at = clockDeadline(row, retention, now)?.getTime() ?? null;
      if (at !== null && (best === null || at < best)) best = at;
    }
    return best === null ? null : new Date(best).toISOString();
  } catch (e) {
    console.warn('[billing-locks] next deletion date unreadable:', e instanceof Error ? e.message : (e as { message?: string })?.message ?? e);
    return null;
  }
}

// ─── The summary GET /api/plans/workspace/:id/effective carries ───────────

export interface LockSummaryKind {
  limit: number | null;
  total: number;
  locked: number;
  cut: LockCut | null;
}

export interface LockSummary {
  enabled: boolean;
  kb_article: LockSummaryKind | null;
  contact: LockSummaryKind | null;
  member: LockSummaryKind | null;
  /** limit = the plan's data_retention_days; cut.ts = the activity cutoff. */
  conversation: LockSummaryKind | null;
  any_locked: boolean;
  next_deletion_at: string | null;
}

function summaryOf(lock: KindLock | null, withCut = true): LockSummaryKind | null {
  if (!lock) return null;
  return { limit: lock.limit, total: lock.total, locked: lock.locked, cut: withCut ? lock.cut : null };
}

/** Counts and cutoffs per kind, and the next deletion date. Never throws. */
export async function lockSummary(config: ServerConfig, workspaceId: string): Promise<LockSummary> {
  const state = await resolveLockState(config, workspaceId);
  const anyLocked = hasAnyLock(state);
  return {
    enabled: state.enabled,
    kb_article: summaryOf(state.kb),
    contact: summaryOf(state.contact),
    // A member cutoff is a membership row; the app only needs the counts.
    member: summaryOf(state.member, false),
    conversation: summaryOf(state.conversation),
    any_locked: anyLocked,
    next_deletion_at: anyLocked ? await nextDeletionAt(config, workspaceId) : null,
  };
}
