import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Super-admin Global Advanced Routing API client.
 * All endpoints require global admin role (server-enforced).
 */

const API_BASE = RESOLVED_API_BASE;

export interface GlobalAdvancedRoutingPolicy {
  owner_fallback_enabled: boolean;
  owner_fallback_for_chat: boolean;
  owner_fallback_for_audio: boolean;
  owner_fallback_for_video: boolean;
  general_pool_enabled: boolean;
}

export async function getGlobalAdvancedRouting(): Promise<GlobalAdvancedRoutingPolicy> {
  const res = await fetch(`${API_BASE}/api/admin/advanced-routing`, {credentials: 'include', 
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.policy as GlobalAdvancedRoutingPolicy;
}

export async function updateGlobalAdvancedRouting(
  patch: Partial<GlobalAdvancedRoutingPolicy>,
): Promise<GlobalAdvancedRoutingPolicy> {
  const res = await fetch(`${API_BASE}/api/admin/advanced-routing`, {credentials: 'include', 
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.policy as GlobalAdvancedRoutingPolicy;
}