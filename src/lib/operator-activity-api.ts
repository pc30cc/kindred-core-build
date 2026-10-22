import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Operator activity API — self-hosted Express endpoints.
 *   POST /api/operator-activity/heartbeat
 *   POST /api/operator-activity/leave   (a beacon)
 *   GET  /api/operator-activity/:workspaceId/stats?days=
 */
const API_BASE = RESOLVED_API_BASE;

export interface OperatorActivityRow {
  user_id: string;
  role: string;
  profile: { id: string; full_name: string | null; email: string | null; avatar_url: string | null } | null;
  online_minutes: number;
  present_minutes: number;
  active_days: number;
  avg_minutes_per_active_day: number;
  last_seen: string | null;
  daily: Record<string, number>;
  conversations_assigned: number;
  conversations_resolved: number;
  replies_sent: number;
  /** Visitors' average rating (1–5, one decimal) in the window; null without ratings. */
  csat_avg?: number | null;
  csat_count?: number;
  /** Available by their status and schedule (what visitors see), not whether a panel is open. */
  current_state: 'online' | 'offline';
  current_reason: string;
  /**
   * Live presence, as routing reads it: a panel or app open and active,
   * idle (away), available but nothing open (disconnected), or offline.
   * Absent from older servers.
   */
  presence_state?: 'active' | 'away' | 'disconnected' | 'offline';
}

export interface OperatorActivityStats {
  days: number;
  since: string;
  /**
   * Whether online time is recorded. It is not (its table was dropped,
   * database/migrations/223): online_minutes, present_minutes, daily and
   * last_seen are then empty, not measured zeros. Older servers do not say,
   * and do not record it either.
   */
  online_time_tracked?: boolean;
  totals: {
    operators: number;
    online_minutes: number;
    replies_sent: number;
    conversations_assigned: number;
    /** Connected right now (newer servers); available by settings on older ones. */
    online_now: number;
    /** Available by their status and schedule right now (newer servers). */
    available_now?: number;
    csat_avg?: number | null;
    csat_count?: number;
  };
  operators: OperatorActivityRow[];
}

export async function fetchOperatorActivity(workspaceId: string, days: number): Promise<OperatorActivityStats> {
  const res = await fetch(
    `${API_BASE}/api/operator-activity/${workspaceId}/stats?days=${days}`,
    { credentials: 'include' },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error || `Request failed: ${res.status}`);
  return body as OperatorActivityStats;
}

/**
 * `interacted` reports whether the operator actually did something since the
 * previous beat (key/click/focus — never mousemove streams). It only drives
 * the internal active/away split; it can never affect what visitors see.
 */
export async function sendOperatorHeartbeat(workspaceId: string, interacted = true, sourceId?: string): Promise<void> {
  await fetch(`${API_BASE}/api/operator-activity/heartbeat`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sourceId ? { workspace_id: workspaceId, interacted, source_id: sourceId } : { workspace_id: workspaceId, interacted }),
  }).catch(() => undefined);
}

/**
 * This tab is going away (R-11): ends its part of the operator's live
 * presence now, instead of when the lease expires (up to 5 minutes later,
 * while routing could still pick them). A beacon, so it survives the page
 * being torn down: the string body goes as text/plain, a CORS-simple request
 * (no preflight) that carries the session cookie and the Origin like the
 * heartbeat does. Where sendBeacon is missing or refuses, a keepalive fetch.
 */
export function sendOperatorLeave(workspaceId: string, sourceId: string): void {
  const url = `${API_BASE}/api/operator-activity/leave`;
  const body = JSON.stringify({ workspace_id: workspaceId, source_id: sourceId });
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return;
  } catch { /* fall through */ }
  try {
    void fetch(url, {
      credentials: 'include',
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
    }).catch(() => undefined);
  } catch { /* the lease expires as before */ }
}

/** Whether the report carries real online time (see `online_time_tracked`). */
export function onlineTimeTracked(data: Pick<OperatorActivityStats, 'online_time_tracked'> | null | undefined): boolean {
  return data?.online_time_tracked === true;
}

/** An operator's live presence: the server's, else (older servers) their availability by settings. */
export function livePresenceOf(op: Pick<OperatorActivityRow, 'presence_state' | 'current_state'>): 'active' | 'away' | 'disconnected' | 'offline' {
  if (op.presence_state) return op.presence_state;
  return op.current_state === 'online' ? 'disconnected' : 'offline';
}

/**
 * The report's "online now" and "available now": who has a panel or app
 * open (active or away), and who is available by status and schedule.
 * Counted from the rows when they carry live presence; an older server's
 * report does not say who is connected (its `online_now` was the settings
 * alone), so "online now" is unknown (null) there.
 */
export function presenceTotals(data: OperatorActivityStats | null | undefined): { onlineNow: number | null; availableNow: number } {
  const rows = data?.operators ?? [];
  const live = rows.some((r) => !!r.presence_state);
  return {
    onlineNow: live
      ? rows.filter((r) => r.presence_state === 'active' || r.presence_state === 'away').length
      : rows.length ? null : 0,
    availableNow: data?.totals.available_now ?? rows.filter((r) => r.current_state === 'online').length,
  };
}
