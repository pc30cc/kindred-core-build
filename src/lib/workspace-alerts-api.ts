/**
 * Workspace operational alerts — read-only, server-derived.
 * Backed by the self-hosted Express endpoint /api/workspace-alerts/:workspaceId.
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface WorkspaceAlert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  params?: Record<string, string>;
  action?: string;
}

export interface WorkspaceAlertsResponse {
  alerts: WorkspaceAlert[];
  counts: { total: number; critical: number };
  generatedAt: string;
}

export async function fetchWorkspaceAlerts(workspaceId: string): Promise<WorkspaceAlertsResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  const res = await fetch(`${API_BASE}/api/workspace-alerts/${workspaceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as WorkspaceAlertsResponse;
}