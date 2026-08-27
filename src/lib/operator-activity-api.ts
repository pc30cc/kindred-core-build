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
  current_state: 'online' | 'offline';
  current_reason: string;
}

export interface OperatorActivityStats {
  days: number;
  since: string;
  totals: {
    operators: number;
    online_minutes: number;
    replies_sent: number;
    conversations_assigned: number;
    online_now: number;
  };
  operators: OperatorActivityRow[];
}

export async function fetchOperatorActivity(workspaceId: string, days: number): Promise<OperatorActivityStats> {
  const res = await fetch(
    `${API_BASE}/api/operator-activity/${workspaceId}/stats?days=${days}`,
    { credentials: 'include' },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as OperatorActivityStats;
}

export async function sendOperatorHeartbeat(workspaceId: string): Promise<void> {
  await fetch(`${API_BASE}/api/operator-activity/heartbeat`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId }),
  }).catch(() => undefined);
}
