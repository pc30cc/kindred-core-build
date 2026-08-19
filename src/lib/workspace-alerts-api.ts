/**
 * Workspace operational alerts — read-only, server-derived.
 * Backed by the self-hosted Express endpoint /api/workspace-alerts/:workspaceId.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL;

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface WorkspaceAlert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  params?: Record<string, string>;
  action?: string;
  /** Critical alerts cannot be dismissed — they clear only when resolved. */
  dismissible?: boolean;
  signature?: string;
}

export interface WorkspaceAlertsResponse {
  alerts: WorkspaceAlert[];
  counts: { total: number; critical: number };
  generatedAt: string;
}

export async function fetchWorkspaceAlerts(workspaceId: string): Promise<WorkspaceAlertsResponse> {
  const res = await fetch(`${API_BASE}/api/workspace-alerts/${workspaceId}`, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as WorkspaceAlertsResponse;
}

/**
 * Marks alerts as read. Dismissals are stored per user in the database, so they
 * follow the operator across devices; critical alerts are ignored server-side.
 */
export async function dismissWorkspaceAlerts(
  workspaceId: string,
  payload: { alertId?: string; all?: boolean },
): Promise<{ dismissed: number }> {
  const res = await fetch(`${API_BASE}/api/workspace-alerts/${workspaceId}/dismiss`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as { dismissed: number };
}