/**
 * SIMPLE BILLING phase 4 — Knowledge Base articles locked by the plan
 * (docs/billing/SIMPLE_BILLING.md "Over the limit after a downgrade").
 *
 * An article is locked when it ranks after the plan's `max_kb_articles`
 * (oldest first by created_at, id — every article counts, any status, the
 * same denominator as the create quota). Nothing is stored: the cutoff comes
 * from the lock core (server/services/billing/locks, migration 265) and every
 * KB reader asks this module.
 *
 * A locked article is:
 *   - hidden from the help center, the widget, Telegram and the AI;
 *   - read-only for operators (listed with `locked: true`, PATCH → 403);
 *   - still deletable (deleting frees a slot and unlocks the next one).
 *
 * Fail open (design S4): while the kill switch is off, or the state cannot be
 * read, nothing is locked and every reader behaves exactly as before.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  clearLockStateCache,
  resolveLockState,
  unlockedState,
  type LockCut,
  type LockState,
} from '../billing/locks/state.js';
import { applyUnlockedFilter, isRowLocked, lockedErrorBody } from '../billing/locks/predicates.js';

export interface KbLock {
  /** True only while the switch is on and at least one article is locked. */
  active: boolean;
  /** The last article that stays active; null = nothing locked. */
  cut: LockCut | null;
  /** The locked article ids (capped by the lock core; complete when `complete`). */
  ids: ReadonlySet<string>;
  /** False when more articles are locked than `ids` holds. */
  complete: boolean;
  limit: number | null;
  locked: number;
  state: LockState;
}

const NO_LOCK: KbLock = Object.freeze({
  active: false,
  cut: null,
  ids: new Set<string>(),
  complete: true,
  limit: null,
  locked: 0,
  state: unlockedState(),
});

/** Nothing locked (the switch is off, or the state is unreadable). */
export function noKbLock(): KbLock {
  return NO_LOCK;
}

/** The KB lock of a workspace. Never throws; cached 60 s by the lock core. */
export async function resolveKbLock(config: ServerConfig, workspaceId: string): Promise<KbLock> {
  if (!workspaceId) return NO_LOCK;
  const state = await resolveLockState(config, workspaceId, ['kb_article']);
  const kb = state.enabled ? state.kb : null;
  if (!kb || !kb.cut || !(kb.locked > 0)) return NO_LOCK;
  const ids = new Set((kb.ids ?? []).map((id) => id.toLowerCase()));
  return {
    active: true,
    cut: kb.cut,
    ids,
    complete: ids.size >= kb.locked,
    limit: kb.limit,
    locked: kb.locked,
    state,
  };
}

export interface KbLockableRow {
  id?: string | null;
  /** Pass it whenever it was read (null included): the cutoff is then exact. */
  created_at?: string | Date | null;
}

/**
 * Whether `row` is locked. With `created_at` read (present on the row, even
 * as null) the cutoff decides, to the microsecond; without it the locked id
 * list does.
 */
export function isKbArticleLocked(lock: KbLock, row: KbLockableRow | null | undefined): boolean {
  if (!lock.active || !row?.id) return false;
  if ('created_at' in row && row.created_at !== undefined) {
    return isRowLocked(lock.state, 'kb_article', { id: row.id, created_at: row.created_at });
  }
  return lock.ids.has(String(row.id).toLowerCase());
}

/** The ids of `rows` that are locked. */
export function lockedKbIdsOf(lock: KbLock, rows: ReadonlyArray<KbLockableRow> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!lock.active) return out;
  for (const row of rows ?? []) if (row?.id && isKbArticleLocked(lock, row)) out.add(String(row.id));
  return out;
}

/** Drops the locked rows (rows must carry `id`, and `created_at` when read). */
export function withoutLockedKb<T extends KbLockableRow>(lock: KbLock, rows: ReadonlyArray<T> | null | undefined): T[] {
  const list = (rows ?? []) as T[];
  if (!lock.active) return list.slice();
  return list.filter((row) => !isKbArticleLocked(lock, row));
}

interface OrFilterable<Q> {
  or(filters: string): Q;
}

/**
 * Restricts a knowledge_base_articles query to the active articles (at or
 * before the cutoff). Leaves the query as it is when nothing is locked.
 */
export function applyKbUnlockedFilter<Q extends OrFilterable<Q>>(query: Q, lock: KbLock): Q {
  return lock.active ? applyUnlockedFilter(query, lock.cut) : query;
}

/**
 * Whether the article `articleId` of `workspaceId` is locked, exactly: the id
 * list first, the article's created_at when the list is capped. Unreadable →
 * false (fail open; the SQL guard in _ai_kb_apply_generated still holds).
 */
export async function isKbArticleIdLocked(
  config: ServerConfig,
  workspaceId: string,
  articleId: string | null | undefined,
  lock?: KbLock,
): Promise<boolean> {
  if (!articleId) return false;
  const l = lock ?? (await resolveKbLock(config, workspaceId));
  if (!l.active) return false;
  if (l.ids.has(articleId.toLowerCase())) return true;
  if (l.complete) return false;
  const { data, error } = await getServiceClient(config)
    .from('knowledge_base_articles')
    .select('id, created_at')
    .eq('id', articleId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return false;
  return isKbArticleLocked(l, data as KbLockableRow);
}

/**
 * Forget the cached lock state after an article is deleted: the slot it frees
 * unlocks the next article now rather than after the 60 s cache.
 */
export function forgetKbLock(workspaceId: string): void {
  clearLockStateCache(workspaceId);
}

/** The 403 body for an edit of a locked article. */
export function kbArticleLockedBody(): { error: 'kb_article_locked'; upgrade_required: true } {
  return lockedErrorBody('kb_article_locked') as { error: 'kb_article_locked'; upgrade_required: true };
}

/** The error the SQL guard (_ai_kb_apply_generated, 265) raises. */
export function isKbArticleLockedError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.includes('kb_article_locked');
}
