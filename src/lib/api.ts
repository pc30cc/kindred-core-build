/**
 * API client for the self-hosted backend server.
 * All widget bootstrap and visitor tracking goes through this.
 * No Lovable Cloud dependency.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

// Widget config — fetched by the loader and also usable from dashboard
export function fetchWidgetConfig(workspaceId: string, origin?: string) {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (origin) params.set('origin', origin);
  return request<{
    enabled: boolean;
    workspaceId: string;
    branding: {
      platformName: string;
      primaryColor: string;
      logoUrl: string | null;
      launcherText: string;
      welcomeMessage: string;
    };
    position: string;
    locale: string;
    features: { chat: boolean; knowledgeBase: boolean; visitorTracking: boolean };
    runtimeUrl: string | null;
    styleUrl: string | null;
  }>(`/api/widget/config?${params}`);
}

// Visitor tracking
export function trackVisitor(data: {
  workspace_id: string;
  visitor_id: string;
  current_page: string;
  referrer?: string;
  browser?: string;
  device?: string;
  os?: string;
}) {
  return request<{ session_id: string; visitor_id: string }>('/api/visitors/track', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function heartbeatVisitor(data: {
  workspace_id: string;
  session_id: string;
  current_page: string;
}) {
  return request<{ ok: boolean }>('/api/visitors/heartbeat', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Health check
export function checkHealth() {
  return request<{ status: string; timestamp: string }>('/api/health');
}

export { API_BASE };
