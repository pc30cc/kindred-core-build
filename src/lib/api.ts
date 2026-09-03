/**
 * API client for the self-hosted backend server.
 * All widget bootstrap, visitor tracking, AI, and storage go through this.
 * No Lovable Cloud dependency.
 */

// Same-origin (`''`) when VITE_API_BASE_URL is not configured at build time —
// the frontend nginx `/api/` proxy (BACKEND_URL) then handles the request.
import { API_BASE } from './apiBase';




async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', 
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
    body: JSON.stringify(data),
  });
}

export async function storageDelete(data: { workspaceId: string; fileKey: string }) {
  return request<{ success: boolean; error?: string }>('/api/storage/delete', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function storageGetUrl(workspaceId: string, fileKey: string) {
  const params = new URLSearchParams({ workspaceId, fileKey });
  return request<{ url: string | null }>(`/api/storage/url?${params}`, {
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
    body: JSON.stringify(data),
  });
}

export async function cdnGetConfig(workspaceId: string) {
  return request<{
    configured: boolean;
    provider?: string;
    domain?: string;
  }>(`/api/cdn/config/${workspaceId}`, {
  });
}

export async function cdnGetAssetUrl(workspaceId: string, path: string) {
  return request<{ url: string }>('/api/cdn/asset-url', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, path }),
  });
}

// ─── Billing ─────────────────────────────────────────────────────

// Billing routes authorize per user + workspace (and per platform admin), so
// they require the real end-user JWT — the publishable anon key is rejected.
export async function billingGetPlans(locale?: string) {
  const params = new URLSearchParams();
  if (locale) params.set('locale', locale);
  return request<{ plans: any[] }>(`/api/billing/plans?${params}`);
}

export async function billingGetStatus(workspaceId: string) {
  return request<{ subscription: any; payments: any[]; attempts?: any[] }>(`/api/billing/status/${workspaceId}`);
}

/** Invoice shown to the customer BEFORE the gateway redirect. */
export interface BillingInvoice {
  intentId: string;
  invoiceNumber: string | null;
  issuedAt: string;
  expiresAt: string;
  planId: string;
  planName: string;
  interval: 'monthly' | 'yearly';
  actionType: string;
  amountIrr: number;
  totalIrr: number;
  periodStart: string;
  periodEnd: string;
  stacked: boolean;
  providerName: string;
}

export async function billingInvoicePreview(data: {
  workspaceId: string;
  planId: string;
  interval: 'monthly' | 'yearly';
  currency?: string;
}) {
  return request<{ invoice: BillingInvoice }>('/api/billing/invoice-preview', {
    method: 'POST', body: JSON.stringify({ currency: 'IRR', ...data }),
  });
}

/** The customer closed the invoice without paying. */
export async function billingCancelInvoice(intentId: string) {
  return request<{ success: boolean }>(`/api/billing/invoice/${encodeURIComponent(intentId)}/cancel`, { method: 'POST' });
}

export async function billingCheckout(data: {
  workspaceId: string;
  planId: string;
  interval: 'monthly' | 'yearly';
  currency: string;
  callbackUrl: string;
  customerEmail?: string;
  customerName?: string;
  phone?: string;
  intentId?: string;
}) {
  // The charged amount is always computed server-side from the plan's price —
  // never accepted from the client.
  return request<{ success: boolean; paymentUrl: string; sessionId?: string; authority?: string; intentId?: string }>('/api/billing/checkout', {
    method: 'POST', body: JSON.stringify(data),
  });
}

/**
 * Verifies a gateway return. `intentId` is REQUIRED for the Iranian one-time
 * gateways — the amount/plan/interval are re-derived server-side from the
 * payment intent, never from `params` (the raw, untrusted redirect query).
 */
export async function billingVerifyCallback(input: {
  workspaceId: string;
  provider: string;
  params: Record<string, string>;
  intentId?: string;
}) {
  return request<BillingVerifyResponse>(
    '/api/billing/verify-callback',
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** Server-built receipt: every field is derived from persisted state. */
export interface BillingReceipt {
  status: string;
  intentId: string;
  amountIrr: number;
  purchaseType: 'subscription' | 'ai_credit_topup';
  actionType: string | null;
  providerName: string;
  providerRef: string | null;
  orderId: string;
  paidAt: string | null;
  planName: string | null;
  billingInterval: string | null;
  invoiceNumber?: string | null;
  periodEnd?: string | null;
  newAiBalanceIrr?: number;
}

export interface BillingVerifyResponse {
  success: boolean;
  verified?: boolean;
  /** Finalization still running — poll billingGetPaymentIntent. */
  pending?: boolean;
  providerRef?: string;
  amount?: number;
  status?: string;
  duplicate?: boolean;
  receipt?: BillingReceipt;
}

/**
 * Polls the authoritative state of a payment intent. Used by the result screen
 * when a callback lands while the server is still applying the payment.
 */
export async function billingGetPaymentIntent(intentId: string) {
  return request<{ status: string; pending: boolean; receipt: BillingReceipt | null; failureReason: string | null }>(
    `/api/billing/payment-intent/${encodeURIComponent(intentId)}`,
  );
}

export async function billingGetProviders() {
  return request<{ providers: Record<string, { name: string; capabilities: Record<string, boolean> }> }>('/api/billing/providers');
}

export async function billingCancel(workspaceId: string) {
  return request<{ success: boolean }>('/api/billing/subscription/cancel', {
    method: 'POST', body: JSON.stringify({ workspaceId }),
  });
}

export async function billingResume(workspaceId: string) {
  return request<{ success: boolean }>('/api/billing/subscription/resume', {
    method: 'POST', body: JSON.stringify({ workspaceId }),
  });
}

export async function billingGetPortal(workspaceId: string, returnUrl: string) {
  return request<{ url: string }>('/api/billing/portal', {
    method: 'POST', body: JSON.stringify({ workspaceId, returnUrl }),
  });
}

export async function billingTest(provider: string, config: Record<string, unknown>) {
  return request<{ success: boolean; latencyMs: number; error?: string }>('/api/billing/test', {
    method: 'POST', body: JSON.stringify({ provider, config }),
  });
}

export async function billingGetEvents(workspaceId: string) {
  return request<{ events: any[] }>(`/api/billing/events/${workspaceId}`);
}

export interface AiBillingSummary {
  currency: string;
  cycleId: string;
  renewsAt: string;
  available: number;
  reserved: number;
  granted: number;
  usedThisCycle: number;
  planRemaining: number;
  purchasedRemaining: number;
  aiReplies: number;
  mode: 'METER_ONLY' | 'ENFORCED';
}

export async function aiBillingSummary(workspaceId: string) {
  return request<AiBillingSummary>(`/api/ai-billing/workspaces/${workspaceId}/summary`);
}

export async function aiCreditTopupConfig(workspaceId: string) {
  return request<{ presetsToman: number[]; minToman: number; maxToman: number; currency: string; displayCurrency: string }>(
    `/api/ai-billing/workspaces/${workspaceId}/topup/config`,
  );
}

export async function aiCreditTopupCheckout(workspaceId: string, input: { amountToman: number; callbackUrl: string }) {
  return request<{ success: boolean; paymentUrl: string; sessionId?: string; authority?: string; intentId: string }>(
    `/api/ai-billing/workspaces/${workspaceId}/topup/checkout`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function billingAdminOverview() {
  return request<{
    totalSubscriptions: number;
    activeSubscriptions: number;
    recentPayments: any[];
    recentEvents: any[];
    plans: any[];
  }>('/api/billing/admin/overview');
}

export async function billingAdminGrant(data: { workspaceId: string; planId: string; status?: string; expiresAt?: string }) {
  return request<{ subscription: any }>('/api/billing/admin/grant', {
    method: 'POST', body: JSON.stringify(data),
  });
}

export async function billingEntitlement(workspaceId: string, feature: string) {
  return request<{ allowed: boolean; limit?: number; used?: number }>(
    `/api/billing/entitlement?workspaceId=${workspaceId}&feature=${feature}`,
    undefined
  );
}

// ─── Health ──────────────────────────────────────────────────────

export function checkHealth() {
  return request<{ status: string; timestamp: string }>('/api/health');
}

// ─── Admin User Management ──────────────────────────────────────

export async function adminSendResetLink(email: string) {
  return request<{ success: boolean }>('/api/admin/send-reset-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function adminChangePassword(userId: string, newPassword: string) {
  return request<{ success: boolean }>('/api/admin/change-password', {
    method: 'POST',
    body: JSON.stringify({ userId, newPassword }),
  });
}

export async function adminBlockUser(userId: string, blocked: boolean) {
  return request<{ success: boolean; blocked: boolean }>('/api/admin/block-user', {
    method: 'POST',
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
    body: JSON.stringify({ userId }),
  });
}

/** Hard-delete a user and every trace of their data (platform admin only). */
export async function adminDeleteUser(userId: string) {
  return request<{ success: boolean; summary: unknown; storageFailures: number }>(
    `/api/admin/management/users/${userId}`,
    { method: 'DELETE' },
  );
}

export async function adminDeleteUserAvatar(userId: string) {
  return request<{ success: boolean }>(`/api/admin/users/${userId}/avatar`, {
    method: 'DELETE',
  });
}

// ─── Admin: edit user identity / profile ─────────────────────────
export interface AdminUserProfilePatch {
  full_name?: string | null;
  company_name?: string | null;
  website_domain?: string | null;
  preferred_locale?: 'fa' | 'en' | 'tr' | null;
  email?: string;
}

export async function adminUpdateUserProfile(userId: string, patch: AdminUserProfilePatch) {
  return request<{ success: boolean }>(`/api/admin/users/${userId}/profile`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function adminSetUserEmailVerified(userId: string, verified: boolean) {
  return request<{ success: boolean; verified: boolean }>(`/api/admin/users/${userId}/email-verification`, {
    method: 'POST',
    body: JSON.stringify({ verified }),
  });
}

export async function adminSetUserPhone(userId: string, phone: string, country = 'IR') {
  return request<{ success: boolean; phone: string; country: string }>(`/api/admin/users/${userId}/phone`, {
    method: 'PUT',
    body: JSON.stringify({ phone, country }),
  });
}

export async function adminRemoveUserPhone(userId: string) {
  return request<{ success: boolean }>(`/api/admin/users/${userId}/phone`, {
    method: 'DELETE',
  });
}

export interface AdminUserBilling {
  workspaces: { id: string; name: string; slug: string }[];
  plans: { id: string; name: string; slug: string; localized: any }[];
  payments: {
    id: string; workspace_id: string; provider_name: string | null; provider_payment_id: string | null;
    amount: number | null; currency: string | null; status: string | null; refund_amount: number | null;
    metadata: any; created_at: string | null;
  }[];
  events: {
    id: string; workspace_id: string; event_type: string | null; provider_name: string | null;
    provider_event_id: string | null; amount: number | null; currency: string | null; status: string | null;
    metadata: any; processed_at: string | null; created_at: string | null;
  }[];
  subscriptions: {
    id: string; workspace_id: string; plan_id: string | null; provider_name: string | null;
    provider_subscription_id: string | null; provider_customer_id: string | null; status: string | null;
    cancel_at_period_end: boolean | null; current_period_start: string | null; current_period_end: string | null;
    trial_end: string | null; created_at: string | null; updated_at: string | null;
  }[];
  planChanges: {
    id: string; workspace_id: string; old_plan_id: string | null; new_plan_id: string | null;
    change_type: string | null; changed_by: string | null; metadata: any; created_at: string | null;
  }[];
  gateways?: {
    id: string; workspace_id: string; provider_type: string; provider_name: string;
    is_active: boolean | null; created_at: string | null; updated_at: string | null;
    config_summary: { key: string; value: string | null }[];
  }[];
}

export async function adminGetUserBilling(userId: string, limit = 100) {
  return request<AdminUserBilling>(`/api/admin/users/${userId}/billing?limit=${limit}`, {
  });
}

export interface AdminUserEmailLog {
  id: string;
  template_slug: string | null;
  recipient_email: string | null;
  subject: string | null;
  status: string | null;
  provider_name: string | null;
  error_message: string | null;
  created_at: string | null;
  sent_at: string | null;
  metadata?: any;
}

export interface AdminUserSmsLog {
  id: string;
  purpose: string | null;
  delivery_status: string | null;
  provider_name: string | null;
  provider_message_id: string | null;
  created_by: string | null;
  sent_at: string | null;
  created_at: string | null;
  consumed_at: string | null;
  expires_at: string | null;
  phone_masked: string | null;
}

export async function adminGetUserMessages(userId: string, limit = 50) {
  // Email/SMS logs are platform-admin data: the only path is the first-party
  // admin API (session-authenticated, service_role-backed). There is no
  // browser-direct Supabase fallback — that used to depend on an
  // `authenticated`/auth.uid() RLS policy that no longer applies.
  return request<{ emails: AdminUserEmailLog[]; sms: AdminUserSmsLog[] }>(
    `/api/admin/users/${userId}/messages?limit=${limit}`,
    undefined,
  );
}

export async function adminImpersonateUser(userId: string) {
  return request<{ url: string }>('/api/admin/impersonate', {
    method: 'POST',
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

// ─── Admin: SMS provider (platform-level, super admin only) ──────
// The backend never returns the stored credential; `hasApiKey` is the only
// signal the browser receives about it.

export interface AdminSmsProviderInfo {
  providerName: 'kavenegar' | 'smsir' | 'disabled';
  configured: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  sender: string | null;
  verifyTemplate: string | null;
  lineNumber: string | null;
  verifyTemplateId: number | null;
  verifyParameterName: string | null;
  updatedAt: string | null;
}

export interface AdminSmsTestResult {
  success: boolean;
  provider: string;
  latencyMs?: number;
  balance?: number | null;
  currency?: string;
  accountType?: string | null;
  error?: string;
  errorCode?: string;
}

export async function adminGetSmsProvider() {
  return request<AdminSmsProviderInfo>('/api/admin/providers/sms', {
  });
}

export type AdminSmsProviderSavePayload =
  | {
      providerName: 'kavenegar';
      enabled: boolean;
      apiKey?: string;
      sender?: string;
      verifyTemplate: string;
    }
  | {
      providerName: 'smsir';
      enabled: boolean;
      apiKey?: string;
      lineNumber: string;
      verifyTemplateId: number;
      verifyParameterName: string;
    };

export async function adminSaveSmsProvider(payload: AdminSmsProviderSavePayload) {
  return request<AdminSmsProviderInfo>('/api/admin/providers/sms', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function adminDeleteSmsProvider() {
  return request<AdminSmsProviderInfo>('/api/admin/providers/sms', {
    method: 'DELETE',
  });
}

export async function adminTestSmsProvider() {
  return request<AdminSmsTestResult>('/api/admin/providers/sms/test', {
    method: 'POST',
  });
}

// ─── Phone verification (account-level OTP) ──────────────────────
// Responses are sanitized by the backend: they never contain the SMS vendor,
// template, sender/line number, provider message id or a raw provider error.

export type PhoneVerificationPurpose = 'widget_access';

export interface PhoneVerificationStatus {
  workspaceId?: string;
  required: boolean;
  satisfied: boolean;
  canVerify: boolean;
  phoneSet?: boolean;
  phoneMasked?: string | null;
  allowedCountries?: string[];
  resendAfterSeconds?: number;
  verifiedAt?: string | null;
  /** Resume fields — the backend only returns these to the subject. */
  hasActiveChallenge?: boolean;
  activeChallengeId?: string | null;
  challengeExpiresInSeconds?: number | null;
  remainingAttempts?: number | null;
}

export interface PhoneChallenge {
  success: true;
  challengeId: string;
  phoneMasked: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export interface PhoneCheckResult {
  success: true;
  verified: true;
  phoneMasked: string | null;
  verifiedAt: string | null;
}

export interface PhoneVerificationContext {
  purpose: PhoneVerificationPurpose;
  workspaceId?: string;
  workspaceSlug?: string;
}

export async function getPhoneVerificationStatus(ctx: PhoneVerificationContext) {
  const params = new URLSearchParams({ purpose: ctx.purpose });
  if (ctx.workspaceId) params.set('workspaceId', ctx.workspaceId);
  if (ctx.workspaceSlug) params.set('workspaceSlug', ctx.workspaceSlug);
  return request<PhoneVerificationStatus>(`/api/phone-verification/status?${params}`, {
  });
}

export async function startPhoneVerification(
  input: PhoneVerificationContext & { country: string; phone: string },
) {
  return request<PhoneChallenge>('/api/phone-verification/start', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function resendPhoneVerification(ctx: PhoneVerificationContext) {
  return request<PhoneChallenge>('/api/phone-verification/resend', {
    method: 'POST',
    body: JSON.stringify(ctx),
  });
}

export async function checkPhoneVerification(
  input: PhoneVerificationContext & { challengeId: string; code: string },
) {
  return request<PhoneCheckResult>('/api/phone-verification/check', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Server-side invalidation of the outstanding code ("change number"). */
export async function cancelPhoneVerification(
  input: PhoneVerificationContext & { challengeId?: string | null },
) {
  return request<{ success: true; cancelled: number }>('/api/phone-verification/cancel', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ─── Admin: phone verification (super admin only) ────────────────

export interface AdminPhoneVerification {
  userId: string;
  phone: string | null;
  phoneMasked: string | null;
  country: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationMethod: 'sms_otp' | 'admin_manual' | null;
  verifiedByAdminId: string | null;
  verifiedByAdminEmail: string | null;
  manualVerificationReason: string | null;
  hasActiveChallenge: boolean;
  challengeExpiresInSeconds: number | null;
  lastSentAt: string | null;
  remainingAttempts: number | null;
}

export async function adminGetUserPhoneVerification(userId: string) {
  return request<AdminPhoneVerification>(`/api/admin/users/${userId}/phone-verification`, {
  });
}

export async function adminResendUserPhoneVerification(userId: string) {
  return request<{ success: true; phoneMasked: string; expiresInSeconds: number; resendAfterSeconds: number }>(
    `/api/admin/users/${userId}/phone-verification/resend`,
    { method: 'POST' },
  );
}

export async function adminManualVerifyUserPhone(userId: string, reason: string) {
  return request<{
    success: true;
    verified: true;
    verificationMethod: 'sms_otp' | 'admin_manual';
    verifiedAt: string | null;
    alreadyVerified?: boolean;
  }>(
    `/api/admin/users/${userId}/phone-verification/manual-verify`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

// ─── Account email verification ──────────────────────────────────

export interface ResendVerificationResult {
  success: boolean;
  sent?: boolean;
  already_verified?: boolean;
  email?: string;
}

export class ResendVerificationError extends Error {
  constructor(
    public readonly code: 'too_many_requests' | 'email_send_failed' | 'unauthorized' | 'unknown',
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'ResendVerificationError';
  }
}

/**
 * Re-send the verification email for the CURRENTLY signed-in account.
 * Routed through the self-hosted backend (`/api/account/resend-verification`),
 * which issues a fresh token and delivers it via the configured email
 * provider — no Supabase built-in mail involved.
 */
export async function resendMyVerificationEmail(locale?: string): Promise<ResendVerificationResult> {
  const res = await fetch(`${API_BASE}/api/account/resend-verification`, {credentials: 'include', 
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: locale || 'en' }),
  });
  const body = await res.json().catch(() => ({} as any));
  if (res.ok) return body as ResendVerificationResult;
  if (res.status === 429) {
    throw new ResendVerificationError('too_many_requests', Number(body?.retry_after_seconds) || 60);
  }
  if (res.status === 401) throw new ResendVerificationError('unauthorized');
  if (res.status === 502) throw new ResendVerificationError('email_send_failed');
  throw new ResendVerificationError('unknown');
}
