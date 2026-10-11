/**
 * SIMPLE BILLING phase 4 — contacts and chats locked by the plan
 * (docs/billing/SIMPLE_BILLING.md "Over the limit after a downgrade").
 *
 *   - A contact is locked when it ranks after the plan's `max_contacts`
 *     (oldest first by created_at, id). Only the contacts the plan counts
 *     rank (decision D1): spam and anonymous widget visitors (no name, email
 *     or phone) are never locked — the same predicate as the SQL
 *     (billing_lock_rank_rows, migration 264) and the quota.
 *   - A chat is locked when its last activity (updated_at, else created_at)
 *     is older than the plan's `data_retention_days` (D2). A visitor writing
 *     again moves updated_at, so a customer coming back is never blocked.
 *
 * A locked contact is listed redacted (its stored fields never reach the
 * browser), cannot be opened or edited, and can still be deleted. A locked
 * chat is listed without its preview; its messages, replies, status changes
 * and claims are refused with 403 `conversation_locked`. Inside an unlocked
 * chat a locked contact only hides its details (D4).
 *
 * Fail open (design S4): while the kill switch is off, or the state cannot be
 * read, nothing is locked and every route behaves exactly as before.
 */
import type { ServerConfig } from '../config.js';
import {
  clearLockStateCache,
  resolveLockState,
  unlockedState,
  type LockState,
} from './billing/locks/state.js';
import { isRowLocked, lockedErrorBody } from './billing/locks/predicates.js';
import { contactForPanel } from './billing/locks/redact.js';
import { ANON_CONTACT_NAME } from './widget/anonymousContact.js';

export { unlockedState };
export type { LockState };

/** The lock state of the contacts and chats of a workspace. Never throws; cached 60 s. */
export async function resolveContactChatLocks(config: ServerConfig, workspaceId: string): Promise<LockState> {
  if (!workspaceId) return unlockedState();
  return resolveLockState(config, workspaceId, ['contact', 'conversation']);
}

/** The columns a contact needs for its lock to be judged (D1 + the rank key). */
export const CONTACT_LOCK_COLUMNS = 'id, created_at, is_spam, name, email, phone, metadata';

export interface ContactLockRow {
  id?: string | null;
  created_at?: string | Date | null;
  is_spam?: boolean | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  metadata?: unknown;
}

function blank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Whether the plan counts this contact (D1), as billing_lock_rank_rows does:
 * not spam, and not an anonymous widget visitor without a name, email or
 * phone ('Visitor' is the legacy placeholder name).
 */
export function isCountableContact(row: ContactLockRow | null | undefined): boolean {
  if (!row) return false;
  if (row.is_spam === true) return false;
  const meta = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const anonymous = String(meta.anonymous ?? '') === 'true';
  if (!anonymous) return true;
  const noName = blank(row.name) || row.name === ANON_CONTACT_NAME;
  return !(noName && blank(row.email) && blank(row.phone));
}

/** Whether a contact is locked: it is counted and ranks after the cutoff. */
export function isContactLocked(state: LockState, row: ContactLockRow | null | undefined): boolean {
  if (!state.enabled || !state.contact?.cut || !row?.id) return false;
  if (!isCountableContact(row)) return false;
  return isRowLocked(state, 'contact', { id: row.id, created_at: row.created_at ?? null });
}

export interface ConversationLockRow {
  id?: string | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
}

/** Whether a chat is locked: its last activity is before the retention cutoff. */
export function isConversationLocked(state: LockState, row: ConversationLockRow | null | undefined): boolean {
  if (!state.enabled || !state.conversation?.cut || !row) return false;
  return isRowLocked(state, 'conversation', { created_at: row.created_at ?? null, updated_at: row.updated_at ?? null });
}

/** The plan's chat retention (days), for the client's "older than N days". */
export function conversationRetentionDays(state: LockState): number | null {
  return state.enabled ? state.conversation?.limit ?? null : null;
}

/** The plan's contact limit, for the client's "your plan allows N contacts". */
export function contactLimit(state: LockState): number | null {
  return state.enabled ? state.contact?.limit ?? null : null;
}

/**
 * A contact as the panel may see it: `locked: false` as it is, or redacted
 * with `locked: true` (only id, workspace_id and created_at stay).
 */
export function contactRowForPanel<T extends Record<string, unknown>>(state: LockState, row: T): T & { locked: boolean } {
  return contactForPanel(row, isContactLocked(state, row as ContactLockRow));
}

/** 403 body of a locked contact. */
export function contactLockedBody(state: LockState) {
  return { ...lockedErrorBody('contact_locked'), limit: contactLimit(state) };
}

/** 403 body of a locked chat. */
export function conversationLockedBody(state: LockState) {
  return { ...lockedErrorBody('conversation_locked'), retention_days: conversationRetentionDays(state) };
}

/**
 * Whether the chat `row` of `workspaceId` is locked now. Reads the cached
 * lock state; never throws (fail open).
 */
export async function conversationLockedNow(
  config: ServerConfig,
  workspaceId: string,
  row: ConversationLockRow,
): Promise<{ locked: boolean; state: LockState }> {
  const state = await resolveContactChatLocks(config, workspaceId);
  return { locked: isConversationLocked(state, row), state };
}

/**
 * Forget the cached lock state after contacts are deleted: the slots they
 * free unlock the next contacts now rather than after the 60 s cache.
 */
export function forgetContactLocks(workspaceId: string): void {
  clearLockStateCache(workspaceId);
}
