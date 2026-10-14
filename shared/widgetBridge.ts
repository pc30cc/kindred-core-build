/** Browser-neutral API types; never expose encrypted browser sessions. */
export type BridgeProvider = 'auto' | 'webyar' | 'crisp' | 'raychat' | 'custom';
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
export interface BridgeSettings { enabled: boolean; identity: BridgeIdentity }
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
}
export interface BridgeMessage {
  id: string;
  contact_id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  delivery: 'queued' | 'preparing' | 'dispatching' | 'sent' | 'received' | 'failed' | 'uncertain' | 'cancelled';
  dedupe_key: string;
  error: string | null;
  created_at: string;
}
