import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Operator heartbeat API — self-hosted Express endpoint.
 *   POST /api/operator-activity/heartbeat
 *
 * The beat only feeds live presence and the internal active/away split. The
 * online-time report (and the 5-minute analytics buckets behind it) was
 * removed, so there is no stats endpoint any more.
 */
const API_BASE = RESOLVED_API_BASE;

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
