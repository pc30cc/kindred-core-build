/**
 * Per-agent "preferred Send action" for the Inbox composer Split Send button.
 *
 * Deliberately a local, per-device preference: it is a UI habit, not shared
 * state, and the project has no generic user-preferences service that would
 * fit it without inventing a subsystem. Scoped by user id so two agents on the
 * same machine never inherit each other's default.
 */

export type PostSendAction = 'none' | 'wait_for_customer' | 'resolve';

/** Workspace fallback when the agent has never chosen an action. */
export const DEFAULT_SEND_ACTION: PostSendAction = 'none';

const VALID: PostSendAction[] = ['none', 'wait_for_customer', 'resolve'];

function key(userId: string | undefined | null): string {
  return `inbox.sendAction.${userId || 'anon'}`;
}

export function readSendActionPref(userId: string | undefined | null): PostSendAction {
  if (typeof window === 'undefined') return DEFAULT_SEND_ACTION;
  try {
    const raw = window.localStorage.getItem(key(userId));
    return VALID.includes(raw as PostSendAction) ? (raw as PostSendAction) : DEFAULT_SEND_ACTION;
  } catch {
    return DEFAULT_SEND_ACTION;
  }
}

export function writeSendActionPref(userId: string | undefined | null, action: PostSendAction): void {
  if (typeof window === 'undefined') return;
  if (!VALID.includes(action)) return;
  try {
    window.localStorage.setItem(key(userId), action);
  } catch {
    /* storage disabled — preference simply doesn't persist */
  }
}
