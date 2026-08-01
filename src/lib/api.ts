/**
 * API client for the self-hosted backend server.
 * All widget bootstrap, visitor tracking, AI, and storage go through this.
 * No Lovable Cloud dependency.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE && import.meta.env.PROD) {
  console.error('[API] VITE_API_BASE_URL is not set. API calls will fail.');
}


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

function authHeaders(): Record<string, string> {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return anonKey ? { 'Authorization': `Bearer ${anonKey}` } : {};
}

/**
 * Real end-user identity for routes that authorize per user + workspace
 * (currently the /api/storage/* routes). The publishable anon key is NOT an
 * identity and is rejected by those routes.
 */
async function userAuthHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Widget ──────────────────────────────────────────────────────

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
    callRuntimeUrl: string | null;
  }>(`/api/widget/config?${params}`);
}

// ─── Visitor Tracking ────────────────────────────────────────────

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

// ─── AI ──────────────────────────────────────────────────────────

export async function aiComplete(data: {
  workspaceId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}) {
  return request<{
    text: string;
    model: string;
    provider: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    latencyMs: number;
  }>('/api/ai/complete', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function aiTestConnection(data: {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}) {
  return request<{
    success: boolean;
    latencyMs: number;
    model: string;
    error?: string;
  }>('/api/ai/test', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function aiGetConfig(workspaceId: string) {
  return request<{
    configured: boolean;
    provider?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }>(`/api/ai/config/${workspaceId}`, {
    headers: await userAuthHeaders(),
  });
}

// ─── Storage ─────────────────────────────────────────────────────

export async function storageUpload(data: {
  workspaceId: string;
  fileKey: string;
  data: string; // base64
  contentType: string;
}) {
  return request<{
    success: boolean;
    url?: string;
    fileKey?: string;
    error?: string;
  }>('/api/storage/upload', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function storageDelete(data: { workspaceId: string; fileKey: string }) {
  return request<{ success: boolean; error?: string }>('/api/storage/delete', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function storageGetUrl(workspaceId: string, fileKey: string) {
  const params = new URLSearchParams({ workspaceId, fileKey });
  return request<{ url: string | null }>(`/api/storage/url?${params}`, {
    headers: await userAuthHeaders(),
  });
}

export async function storageTestConnection(data: {
  provider: string;
  apiKey?: string;
  storageZone?: string;
  region?: string;
  cdnUrl?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  s3Region?: string;
  endpoint?: string;
}) {
  return request<{
    success: boolean;
    latencyMs: number;
    error?: string;
  }>('/api/storage/test', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function storageGetConfig(workspaceId: string) {
  return request<{
    configured: boolean;
    provider?: string;
    region?: string;
    bucket?: string;
    cdnUrl?: string;
    maxFileSizeMB?: number;
  }>(`/api/storage/config/${workspaceId}`, {
    headers: await userAuthHeaders(),
  });
}

// ─── CDN ─────────────────────────────────────────────────────────

export async function cdnPurge(data: { workspaceId: string; paths?: string[] }) {
  return request<{
    success: boolean;
    purgedPaths?: string[];
    error?: string;
  }>('/api/cdn/purge', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function cdnTestConnection(data: {
  provider: string;
  api_key?: string;
  api_token?: string;
  api_secret?: string;
  domain?: string;
  zone_id?: string;
  pull_zone_id?: string;
  hostname?: string;
  service_id?: string;
  access_key_id?: string;
  secret_access_key?: string;
  distribution_id?: string;
  zone_url?: string;
  zone_name?: string;
}) {
  return request<{
    success: boolean;
    latencyMs: number;
    provider: string;
    error?: string;
    details?: string;
  }>('/api/cdn/test', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify(data),
  });
}

export async function cdnGetConfig(workspaceId: string) {
  return request<{
    configured: boolean;
    provider?: string;
    domain?: string;
  }>(`/api/cdn/config/${workspaceId}`, {
    headers: await userAuthHeaders(),
  });
}

export async function cdnGetAssetUrl(workspaceId: string, path: string) {
  return request<{ url: string }>('/api/cdn/asset-url', {
    method: 'POST',
    headers: await userAuthHeaders(),
    body: JSON.stringify({ workspaceId, path }),
  });
}

// ─── Billing ─────────────────────────────────────────────────────

// Billing routes authorize per user + workspace (and per platform admin), so
// they require the real end-user JWT — the publishable anon key is rejected.
export async function billingGetPlans(locale?: string) {
  const params = new URLSearchParams();
  if (locale) params.set('locale', locale);
  return request<{ plans: any[] }>(`/api/billing/plans?${params}`, { headers: await userAuthHeaders() });
}

export async function billingGetStatus(workspaceId: string) {
  return request<{ subscription: any; payments: any[] }>(`/api/billing/status/${workspaceId}`, { headers: await userAuthHeaders() });
}

export async function billingCheckout(data: {
  workspaceId: string;
  planId: string;
  interval: 'monthly' | 'yearly';
  currency: string;
  callbackUrl: string;
  customerEmail?: string;
  customerName?: string;
  amount?: number;
  phone?: string;
}) {
  return request<{ success: boolean; paymentUrl: string; sessionId?: string }>('/api/billing/checkout', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify(data),
  });
}

export async function billingCancel(workspaceId: string) {
  return request<{ success: boolean }>('/api/billing/subscription/cancel', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify({ workspaceId }),
  });
}

export async function billingResume(workspaceId: string) {
  return request<{ success: boolean }>('/api/billing/subscription/resume', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify({ workspaceId }),
  });
}

export async function billingGetPortal(workspaceId: string, returnUrl: string) {
  return request<{ url: string }>('/api/billing/portal', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify({ workspaceId, returnUrl }),
  });
}

export async function billingTest(provider: string, config: Record<string, unknown>) {
  return request<{ success: boolean; latencyMs: number; error?: string }>('/api/billing/test', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify({ provider, config }),
  });
}

export async function billingGetEvents(workspaceId: string) {
  return request<{ events: any[] }>(`/api/billing/events/${workspaceId}`, { headers: await userAuthHeaders() });
}

export async function billingAdminOverview() {
  return request<{
    totalSubscriptions: number;
    activeSubscriptions: number;
    recentPayments: any[];
    recentEvents: any[];
    plans: any[];
  }>('/api/billing/admin/overview', { headers: await userAuthHeaders() });
}

export async function billingAdminGrant(data: { workspaceId: string; planId: string; status?: string; expiresAt?: string }) {
  return request<{ subscription: any }>('/api/billing/admin/grant', {
    method: 'POST', headers: await userAuthHeaders(), body: JSON.stringify(data),
  });
}

export async function billingEntitlement(workspaceId: string, feature: string) {
  return request<{ allowed: boolean; limit?: number; used?: number }>(
    `/api/billing/entitlement?workspaceId=${workspaceId}&feature=${feature}`,
    { headers: await userAuthHeaders() }
  );
}

// ─── Health ──────────────────────────────────────────────────────

export function checkHealth() {
  return request<{ status: string; timestamp: string }>('/api/health');
}

// ─── Admin User Management ──────────────────────────────────────

async function getAdminAuthHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return { 'Authorization': `Bearer ${token}` };
}

export async function adminSendResetLink(email: string) {
  return request<{ success: boolean }>('/api/admin/send-reset-link', {
    method: 'POST',
    headers: await getAdminAuthHeaders(),
    body: JSON.stringify({ email }),
  });
}

export async function adminChangePassword(userId: string, newPassword: string) {
  return request<{ success: boolean }>('/api/admin/change-password', {
    method: 'POST',
    headers: await getAdminAuthHeaders(),
    body: JSON.stringify({ userId, newPassword }),
  });
}

export async function adminBlockUser(userId: string, blocked: boolean) {
  return request<{ success: boolean; blocked: boolean }>('/api/admin/block-user', {
    method: 'POST',
    headers: await getAdminAuthHeaders(),
    body: JSON.stringify({ userId, blocked }),
  });
}

export async function adminGetUserStatus(userId: string) {
  return request<{
    id: string;
    email: string;
    email_confirmed_at: string | null;
    banned_until: string | null;
    last_sign_in_at: string | null;
    created_at: string;
  }>('/api/admin/user-status', {
    method: 'POST',
    headers: await getAdminAuthHeaders(),
    body: JSON.stringify({ userId }),
  });
}

export async function adminImpersonateUser(userId: string) {
  return request<{ url: string }>('/api/admin/impersonate', {
    method: 'POST',
    headers: await getAdminAuthHeaders(),
    body: JSON.stringify({ userId }),
  });
}

export function authSignUp(data: {
  email: string;
  password: string;
  website: string;
  fullName?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}) {
  return request<{
    user: {
      id: string;
      email?: string;
      email_confirmed_at?: string | null;
      user_metadata?: Record<string, unknown>;
      created_at?: string;
    };
    needsEmailVerification: boolean;
    resent?: boolean;
  }>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export { API_BASE };
