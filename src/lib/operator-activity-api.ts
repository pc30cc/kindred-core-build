import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Operator activity API — self-hosted Express endpoints.
 *   POST /api/operator-activity/heartbeat
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
  /** Available to visitors by their own status and schedule. */
  current_state: 'online' | 'offline';
  current_reason: string;
  /**
   * Live presence, as chat routing reads it: active / away (panel or app
   * open), disconnected (available but nothing open), offline. Absent from
   * an older server.
   */
  presence_state?: OperatorPresenceState;
}

export type OperatorPresenceState = 'active' | 'away' | 'disconnected' | 'offline';

export interface OperatorActivityStats {
  days: number;
  since: string;
  totals: {
    operators: number;
    online_minutes: number;
    replies_sent: number;
    conversations_assigned: number;
    /** Connected right now (active or away). */
    online_now: number;
    /** Available to visitors by their own status and schedule. */
    available_now?: number;
    csat_avg?: number | null;
    csat_count?: number;
  };
  operators: OperatorActivityRow[];
  /**
   * false: online minutes are not recorded (their table is gone), so
   * online_minutes, present_minutes, daily and last_seen are empty, not
   * measured zeros. Absent from an older server: tracked.
   */
  online_time_tracked?: boolean;
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
export async function sendOperatorHeartbeat(workspaceId: string, interacted = true): Promise<void> {
  await fetch(`${API_BASE}/api/operator-activity/heartbeat`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, interacted }),
  }).catch(() => undefined);
}
