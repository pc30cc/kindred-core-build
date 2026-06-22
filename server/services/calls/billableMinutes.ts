/**
 * Canonical billable-minute computation for call_sessions.
 *
 * SINGLE SOURCE OF TRUTH (read-side / tests).
 *
 * Policy (locked in docs/CALL_NUMERIC_LIMITS.md):
 *   - Billable iff: connected_at IS NOT NULL AND state = 'ended'
 *     AND ended_at IS NOT NULL.
 *   - Billable seconds = max(0, ended_at - connected_at).
 *   - Billable minutes = CEIL(seconds / 60). Zero-second outcomes
 *     produce zero minutes (no write).
 *   - Aggregation bucket = UTC YYYY-MM of ended_at.
 *   - Pre-connect time (created_at → connected_at), queue time,
 *     hold time, and recording-only time DO NOT count.
 *
 * WRITE PATH (canonical, sole writer):
 *   - DB trigger `tg_call_sessions_bill_minutes` increments
 *     `workspace_usage_counters.call_minutes_used` on the OLD.state
 *     != 'ended' -> NEW.state = 'ended' transition. The trigger is
 *     end-path agnostic: it fires regardless of which application
 *     code path (endCallSession, livekitWebhook room_finished, or
 *     callWidget cancel-after-connect) performed the update.
 *
 * Application code MUST NOT increment call_minutes_used directly.
 * This module is read-only / test-only.
 */

export interface BillableInput {
  connected_at: string | null | undefined;
  ended_at: string | null | undefined;
  state: string | null | undefined;
}

export interface BillableResult {
  billable: boolean;
  seconds: number;
  minutes: number;
  periodUtc: string | null;
  reason?: string;
}

function parseIsoMs(v: string | null | undefined): number | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Compute the billable-minute contribution of a single call_session row.
 * Pure function. Mirrors the DB trigger's semantics exactly.
 */
export function computeBillable(row: BillableInput): BillableResult {
  if (row.state !== 'ended') {
    return { billable: false, seconds: 0, minutes: 0, periodUtc: null, reason: 'not_ended' };
  }
  const connectedMs = parseIsoMs(row.connected_at);
  if (connectedMs === null) {
    return { billable: false, seconds: 0, minutes: 0, periodUtc: null, reason: 'never_connected' };
  }
  const endedMs = parseIsoMs(row.ended_at);
  if (endedMs === null) {
    return { billable: false, seconds: 0, minutes: 0, periodUtc: null, reason: 'no_ended_at' };
  }
  const seconds = Math.max(0, Math.round((endedMs - connectedMs) / 1000));
  if (seconds === 0) {
    return { billable: false, seconds: 0, minutes: 0, periodUtc: null, reason: 'zero_duration' };
  }
  const minutes = Math.ceil(seconds / 60);
  const periodUtc = new Date(endedMs).toISOString().slice(0, 7);
  return { billable: true, seconds, minutes, periodUtc };
}