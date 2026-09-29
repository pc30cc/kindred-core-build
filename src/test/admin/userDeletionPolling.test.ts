/**
 * The admin "delete user" button only queues a server job. It used to toast
 * "user and all related data deleted" the moment the job was queued, even
 * though the job then failed and nothing was removed. waitForUserDeletion
 * reports success only when the user is actually gone.
 */
import { describe, it, expect } from 'vitest';
import { interpretUserDeletionStatus, waitForUserDeletion } from '@/lib/adminUserDeletion';
import type { AdminUserDeletionJob } from '@/lib/adminUserDeletion';

const job = (status: AdminUserDeletionJob['status'], error_message: string | null = null): AdminUserDeletionJob => ({
  id: 'job', status, error_message, attempt_count: 0, next_retry_at: null,
});

describe('interpretUserDeletionStatus', () => {
  it('is still running while the job works and the profile exists', () => {
    expect(interpretUserDeletionStatus({ job: job('awaiting_workspace_deletions'), user_exists: true })).toBeNull();
  });

  it('is deleted once the profile is gone, even though the purge removed the job row', () => {
    expect(interpretUserDeletionStatus({ job: null, user_exists: false })).toEqual({ state: 'deleted' });
  });

  it('is failed, with the reason, when the job failed and the user still exists', () => {
    expect(interpretUserDeletionStatus({ job: job('failed', 'S3 list failed: 403'), user_exists: true }))
      .toEqual({ state: 'failed', reason: 'S3 list failed: 403' });
  });
});

describe('waitForUserDeletion', () => {
  it('polls until the user is gone', async () => {
    const responses = [
      { job: job('collecting_workspaces'), user_exists: true },
      { job: job('purging_user'), user_exists: true },
      { job: null, user_exists: false },
    ];
    let calls = 0;
    const outcome = await waitForUserDeletion(async () => responses[calls++], { intervalMs: 1, sleep: async () => {} });
    expect(outcome).toEqual({ state: 'deleted' });
    expect(calls).toBe(3);
  });

  it('never reports success for a job that is still running when it times out', async () => {
    const outcome = await waitForUserDeletion(
      async () => ({ job: job('awaiting_workspace_deletions'), user_exists: true }),
      { intervalMs: 10, timeoutMs: 25, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    );
    expect(outcome).toEqual({ state: 'pending' });
  });
});
