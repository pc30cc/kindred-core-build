/**
 * Gmail `history.list` checkpoint rules for the `gmail_sync_inbox` job.
 *
 * The stored `gmail_history_id` is the point the NEXT sync resumes from, so it
 * may only move past messages that actually landed in Core. Advancing it past
 * a message whose fetch/upsert failed loses that email for good.
 *
 *   - every message landed (or is gone from the mailbox) → advance;
 *   - some failed and the job still has retry budget      → hold the
 *     checkpoint and fail the job so it retries (re-processing the ones that
 *     did land is harmless: Core's upsert is idempotent per Message-ID);
 *   - some failed on the job's FINAL attempt              → advance anyway and
 *     log the skipped ids, so one permanently-bad message cannot pin the
 *     checkpoint (and every future sync) forever.
 */
import { GmailError } from '../../server/services/channels/gmail/types.js';

/**
 * True when Gmail says the message no longer exists (deleted / purged between
 * the history entry and our fetch). Nothing to retry — treat as done.
 */
export function isGmailMessageGone(err: unknown): boolean {
  return err instanceof GmailError && err.code === 'gmail_provider_error' && /^Gmail 404\b/.test(err.detail || '');
}

export type GmailCheckpointDecision = 'advance' | 'hold_and_retry' | 'advance_giving_up';

export function gmailCheckpointDecision(input: {
  failedCount: number;
  attemptCount: number;
  maxAttempts: number;
}): GmailCheckpointDecision {
  if (input.failedCount <= 0) return 'advance';
  // `attempt_count` is incremented when the job is claimed, so it equals
  // `max_attempts` on the last try (see failChannelJob's exhaustion rule).
  return input.attemptCount >= input.maxAttempts ? 'advance_giving_up' : 'hold_and_retry';
}
