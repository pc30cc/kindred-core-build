/**
 * Super-admin Global Advanced Routing API client.
 * All endpoints require global admin role (server-enforced).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export interface GlobalAdvancedRoutingPolicy {
  owner_fallback_enabled: boolean;
  owner_fallback_for_chat: boolean;
  owner_fallback_for_audio: boolean;
  owner_fallback_for_video: boolean;
  general_pool_enabled: boolean;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function getGlobalAdvancedRouting(): Promise<GlobalAdvancedRoutingPolicy> {
  const res = await fetch(`${API_BASE}/api/admin/advanced-routing`, {credentials: 'include', 
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
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
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.policy as GlobalAdvancedRoutingPolicy;
}