import { API_BASE } from './apiBase';
import { authFetch } from './authFetch';

export interface AdminUserDeletionJob {
  id: string;
  status: 'collecting_workspaces' | 'awaiting_workspace_deletions' | 'purging_user' | 'completed' | 'failed';
  error_message: string | null;
  attempt_count: number;
  next_retry_at: string | null;
}

export interface AdminUserDeletionStatus {
  job: AdminUserDeletionJob | null;
  user_exists: boolean;
}

/** Latest account-deletion job for a user, plus whether their profile still exists. */
export async function adminGetUserDeletionStatus(userId: string): Promise<AdminUserDeletionStatus> {
  const res = await authFetch(`${API_BASE}/api/admin/management/users/${userId}/deletion-status`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `API error: ${res.status}`);
  return body as AdminUserDeletionStatus;
}

export type UserDeletionOutcome =
  | { state: 'deleted' }
  | { state: 'failed'; reason: string | null }
  | { state: 'pending' };

type StatusFetcher = () => Promise<AdminUserDeletionStatus>;

/** Reads one deletion-status response. `null` means "still running". */
export function interpretUserDeletionStatus(status: AdminUserDeletionStatus): UserDeletionOutcome | null {
  // The final purge also removes the job row, so a missing profile is the
  // authoritative "done" signal — a completed job is the same fact.
  if (!status.user_exists || status.job?.status === 'completed') return { state: 'deleted' };
  if (status.job?.status === 'failed') return { state: 'failed', reason: status.job.error_message };
  return null;
}

/**
 * Account deletion runs in a server worker (owned workspaces' storage first,
 * then the database), so the request that queues it says nothing about
 * whether it worked. Polls until the user is really gone, the job fails,
 * or `timeoutMs` passes — in which case it is still running server-side.
 */
export async function waitForUserDeletion(
  fetchStatus: StatusFetcher,
  { intervalMs = 3_000, timeoutMs = 180_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<UserDeletionOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = interpretUserDeletionStatus(await fetchStatus());
    if (outcome) return outcome;
    if (Date.now() + intervalMs > deadline) return { state: 'pending' };
    await sleep(intervalMs);
  }
}
