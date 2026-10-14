/** Browser-neutral API types; never expose encrypted browser sessions. */
export type BridgeProvider = 'auto' | 'webyar' | 'crisp' | 'raychat' | 'goftino' | 'custom';
export type BridgeListKey = 'shared' | BridgeAllowedProvider;
export interface BridgeSiteList { urls: string[]; includeShared: boolean }
export type BridgeSiteLists = Partial<Record<BridgeListKey, BridgeSiteList>>;
export interface BridgeBatchDraft { urls: string[]; provider?: BridgeAllowedProvider }
export function normalizeBridgeUrls(values: string[]): string[] {
  return [...new Set(values.map(value => {
    const raw = value.trim();
    if (!raw) return '';
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    parsed.hash = ''; return parsed.toString();
  }).filter(Boolean))];
}
export function bridgeListDraft(lists: BridgeSiteLists, key: BridgeListKey): BridgeBatchDraft {
  const own = lists[key];
  return { urls: normalizeBridgeUrls([...(own?.urls || []), ...(key !== 'shared' && own?.includeShared ? lists.shared?.urls || [] : [])]),
    ...(key === 'shared' ? {} : { provider: key }) };
}
export interface BridgeSelectors {
  frame?: string;
  root?: string;
  launcher?: string;
  start?: string;
  name?: string;
  email?: string;
  phone?: string;
  formSubmit?: string;
  composer?: string;
  send?: string;
  inbound?: string;
  outbound?: string;
  messageIdAttribute?: string;
}
export interface BridgeIdentity { name: string; email: string; phone: string }
export const bridgeProviders = ['webyar', 'crisp', 'raychat', 'goftino', 'custom'] as const;
export type BridgeAllowedProvider = typeof bridgeProviders[number];
export interface BridgeSettings { enabled: boolean; identity: BridgeIdentity; allowedProviders: BridgeAllowedProvider[]; roundSize: number; intervalSeconds: number }
export interface BridgeBatch {
  id: string; body: string; status: 'running' | 'paused' | 'completed' | 'cancelled'; created_at: string;
  round_size: number; interval_seconds: number; approved_through: number; review_version: number; next_send_at: string;
  total: number; pending: number; sent: number; failed: number; uncertain: number; skipped: number;
}
export interface BridgeBatchItem { url: string; position: number; contact_id: string | null; delivery: string; error: string | null }

export interface BridgeContact {
  id: string;
  name: string;
  url: string;
  provider: BridgeProvider;
  selectors: BridgeSelectors;
  enabled: boolean;
  deleting: boolean;
  status: string;
  last_error: string | null;
  last_seen_at: string | null;
  ai_replied_at?: string | null;
  ai_reply_label?: string | null;
  ai_reply_source?: 'widget_label' | 'manual' | null;
}
export interface BridgeMessage {
  id: string;
  contact_id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  delivery: 'queued' | 'preparing' | 'dispatching' | 'sent' | 'received' | 'failed' | 'uncertain' | 'cancelled';
  dedupe_key: string;
  ai_label?: string | null;
  required_provider?: BridgeAllowedProvider | null;
  batch_id?: string | null;
  batch_position?: number | null;
  error: string | null;
  created_at: string;
}
