// ============================================================================
// SIMPLE BILLING phase 4 — "is this row locked?" for the read paths.
//
// The same rule as the SQL (migration 264): a count kind's row is locked when
// (coalesce(created_at, '-infinity'), id) is after the cutoff; a chat is
// locked when coalesce(updated_at, created_at) is before the activity cutoff.
// Timestamps are compared to the microsecond (Postgres' precision), never
// through Date, which keeps only milliseconds and would misjudge a tie.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import {
  LOCK_STATE_KEY,
  resolveLockState,
  type KindLock,
  type LockCut,
  type LockKind,
  type LockState,
} from './state.js';

/** 'kb' is accepted for 'kb_article' (the state's own key). */
export type LockKindInput = LockKind | 'kb';

function kindOf(kind: LockKindInput): LockKind {
  return kind === 'kb' ? 'kb_article' : kind;
}

function lockOf(state: LockState, kind: LockKindInput): KindLock | null {
  if (!state.enabled) return null;
  return state[LOCK_STATE_KEY[kindOf(kind)]] ?? null;
}

/**
 * A timestamp as microseconds since the epoch: '-infinity' / 'infinity' as
 * ±Infinity, null for nothing or something unreadable. Accepts Postgres'
 * text ('2026-10-11 10:00:00.123456+00') and JSON ('…T…+00:00', '…Z') forms.
 */
export function tsMicros(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t * 1000 : null;
  }
  const s = String(value).trim();
  if (s === '-infinity') return -Infinity;
  if (s === 'infinity') return Infinity;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t * 1000 : null;
  }
  let offset = (m[4] ?? 'Z').toUpperCase();
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    offset = `${offset[0]}${digits.slice(0, 2)}:${(digits.slice(2) || '00').padEnd(2, '0')}`;
  }
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const base = Date.parse(`${m[1]}T${time}${offset}`);
  if (!Number.isFinite(base)) return null;
  const micros = Number((m[3] ?? '').slice(0, 6).padEnd(6, '0'));
  return base * 1000 + micros;
}

/** (ts, id) after (cutTs, cutId), in the SQL's order: ts first, then the uuid bytes. */
function rankAfter(ts: number, id: string, cutTs: number, cutId: string): boolean {
  if (ts !== cutTs) return ts > cutTs;
  return id.toLowerCase() > cutId.toLowerCase();
}

export interface LockableRow {
  id?: string | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  /** member rows: the member's user id (the lock is listed per user). */
  user_id?: string | null;
}

/**
 * Whether `row` is locked in `state`. Nothing is locked while the state is
 * disabled (switch off, unreadable, self-host unlimited) or the kind has no
 * cutoff. Members are judged by the locked user list (the owner and suspended
 * members are never on it).
 */
export function isRowLocked(state: LockState, kind: LockKindInput, row: LockableRow | null | undefined): boolean {
  const lock = lockOf(state, kind);
  if (!lock?.cut || !row) return false;
  const k = kindOf(kind);
  if (k === 'member') {
    const userId = row.user_id ? String(row.user_id).toLowerCase() : null;
    return userId !== null && (lock.ids ?? []).includes(userId);
  }
  if (k === 'conversation') {
    const activity = tsMicros(row.updated_at ?? null) ?? tsMicros(row.created_at ?? null);
    const cutoff = tsMicros(lock.cut.ts);
    return activity !== null && cutoff !== null && activity < cutoff;
  }
  if (!row.id) return false;
  const cutTs = tsMicros(lock.cut.ts);
  if (cutTs === null) return false;
  return rankAfter(tsMicros(row.created_at ?? null) ?? -Infinity, String(row.id), cutTs, lock.cut.id ?? '');
}

/** Whether `userId` holds a seat the plan no longer has (owner and suspended members never). */
export function isMemberLocked(state: LockState, userId: string | null | undefined): boolean {
  return isRowLocked(state, 'member', { user_id: userId ?? null });
}

/**
 * The locked KB article ids of a workspace (empty when nothing is locked or
 * the state is unreadable). Capped (LOCKED_IDS_CAP): article counts are small.
 */
export async function kbLockedIds(config: ServerConfig, workspaceId: string): Promise<Set<string>> {
  const state = await resolveLockState(config, workspaceId, ['kb_article']);
  return new Set(state.enabled ? state.kb?.ids ?? [] : []);
}

/** The locked members' user ids of a workspace. */
export async function memberLockedUserIds(config: ServerConfig, workspaceId: string): Promise<Set<string>> {
  const state = await resolveLockState(config, workspaceId, ['member']);
  return new Set(state.enabled ? state.member?.ids ?? [] : []);
}

// ─── Query filters (postgres-only engine and PostgREST alike) ─────────────
// A filter value is double-quoted: a timestamp holds ':' and '+'.

interface OrFilterable<Q> {
  or(filters: string): Q;
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Only the rows of a count kind (kb_article, contact) at or before the cutoff:
 * the active ones. A null cut (nothing locked) leaves the query as it is.
 */
export function applyUnlockedFilter<Q extends OrFilterable<Q>>(query: Q, cut: LockCut | null | undefined): Q {
  if (!cut) return query;
  const id = cut.id ?? '';
  if (cut.ts === '-infinity') return query.or(`and(created_at.is.null,id.lte.${id})`);
  const ts = quoted(cut.ts);
  return query.or(`created_at.is.null,created_at.lt.${ts},and(created_at.eq.${ts},id.lte.${id})`);
}

/** Only the locked rows of a count kind. A null cut (nothing locked) matches nothing. */
export function applyLockedFilter<Q extends OrFilterable<Q> & { is(column: string, value: null): Q }>(
  query: Q,
  cut: LockCut | null | undefined,
): Q {
  if (!cut) return query.is('id', null);
  const id = cut.id ?? '';
  if (cut.ts === '-infinity') return query.or(`created_at.not.is.null,and(created_at.is.null,id.gt.${id})`);
  const ts = quoted(cut.ts);
  return query.or(`created_at.gt.${ts},and(created_at.eq.${ts},id.gt.${id})`);
}

/** Only the chats active since the retention cutoff (and those with no time at all). */
export function applyConversationUnlockedFilter<Q extends OrFilterable<Q>>(query: Q, cut: LockCut | null | undefined): Q {
  if (!cut) return query;
  const ts = quoted(cut.ts);
  return query.or(
    `updated_at.gte.${ts},and(updated_at.is.null,created_at.gte.${ts}),and(updated_at.is.null,created_at.is.null)`,
  );
}

/** Only the chats whose last activity is before the retention cutoff. A null cut matches nothing. */
export function applyConversationLockedFilter<Q extends OrFilterable<Q> & { is(column: string, value: null): Q }>(
  query: Q,
  cut: LockCut | null | undefined,
): Q {
  if (!cut) return query.is('id', null);
  const ts = quoted(cut.ts);
  return query.or(`updated_at.lt.${ts},and(updated_at.is.null,created_at.lt.${ts})`);
}

/** 403 body of a locked row (design §2): the client shows the upgrade path. */
export type LockErrorCode = 'kb_article_locked' | 'contact_locked' | 'conversation_locked' | 'seat_locked' | 'plan_locked';

export function lockedErrorBody(code: LockErrorCode): { error: LockErrorCode; upgrade_required: true } {
  return { error: code, upgrade_required: true };
}
