import { API_BASE } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';
import type { BridgeSettings, BridgeContact, BridgeMessage, BridgeProvider, BridgeSelectors } from '../../../shared/widgetBridge';

export type { BridgeSettings, BridgeContact, BridgeMessage, BridgeProvider, BridgeSelectors };
export async function bridgeRequest<T>(workspaceId: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const res = await authFetch(`${API_BASE}/api/admin/widget-bridge${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'bridge_unavailable');
  return data as T;
}
