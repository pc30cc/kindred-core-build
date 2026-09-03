import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/apiBase';
import type { Locale } from '@/i18n/config';

export type VerificationPurpose =
  | 'signup_email' | 'signup_phone' | 'password_reset' | 'login_step_up'
  | 'change_email' | 'change_phone' | 'sensitive_action' | 'workspace_invitation';

export const VERIFICATION_PURPOSES: VerificationPurpose[] = [
  'signup_email', 'signup_phone', 'password_reset', 'login_step_up',
  'change_email', 'change_phone', 'sensitive_action', 'workspace_invitation',
];

export interface PurposeSettings {
  purpose: VerificationPurpose;
  adminEnabled: boolean;
  otpLength: number;
  otpTtlSeconds: number;
  maxVerificationAttempts: number;
  resendCooldownSeconds: number;
  maxSendsPerWindow: number;
  rateWindowSeconds: number;
  proofTtlSeconds: number;
  globalRateLimitEnabled: boolean;
  globalRateLimitMaxPerWindow: number | null;
  globalRateLimitWindowSeconds: number | null;
  defaultLocale: Locale;
  revision: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface PurposeGates {
  adminEnabled: boolean;
  consumerImplemented: boolean;
  deploymentAllowlisted: boolean;
  databaseEnabled: boolean;
  effectiveEnabled: boolean;
}

export interface PurposeOverview {
  purpose: VerificationPurpose;
  settings: PurposeSettings;
  gates: PurposeGates;
}

export interface PlatformCeilings {
  otpLength: number;
  otpTtlSeconds: number;
  resendCooldownSecondsMin: number;
  maxSendsPerWindow: number;
  rateWindowSeconds: number;
  maxVerificationAttempts: number;
  proofTtlSeconds: number;
  globalRateLimitWindowSecondsMax: number;
}

export interface ReadinessSnapshot {
  status: 'dormant' | 'configured' | 'error';
  pepperConfigured: boolean;
  configuredKeyVersions: number[];
  currentKeyVersion: number | null;
  stableIndexKeyVersion: number;
  cryptoErrorCode?: string;
  emailProviderConfigured: boolean;
  smsProviderConfigured: boolean;
  databaseAvailable: boolean;
  purposes: Array<{
    purpose: VerificationPurpose;
    adminEnabled: boolean;
    consumerImplemented: boolean;
    deploymentAllowlisted: boolean;
    databaseEnabled: boolean;
    effectiveEnabled: boolean;
  }>;
}

export interface AuditRow {
  id: string;
  purpose: string;
  action: 'update' | 'reset';
  previousSettings: Record<string, unknown>;
  newSettings: Record<string, unknown>;
  actorProfileId: string | null;
  requestId: string;
  locale: string | null;
  createdAt: string;
}

export interface TemplatePreview {
  locale: Locale;
  email: { subject: string; text: string; html: string };
  sms: { text: string };
}

class VerificationAdminApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/verification${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new VerificationAdminApiError(body.error || 'UNKNOWN_ERROR', res.status);
  return body as T;
}

export { VerificationAdminApiError };

export function useVerificationOverview() {
  return useQuery({
    queryKey: ['gv-admin-overview'],
    queryFn: () => adminFetch<{ readiness: ReadinessSnapshot; purposes: PurposeOverview[]; platformCeilings: PlatformCeilings }>('/overview'),
  });
}

export function useVerificationPurposes() {
  return useQuery({
    queryKey: ['gv-admin-purposes'],
    queryFn: () => adminFetch<{ purposes: PurposeOverview[]; platformCeilings: PlatformCeilings }>('/purposes'),
  });
}

export function useVerificationPurpose(purpose: VerificationPurpose | null) {
  return useQuery({
    queryKey: ['gv-admin-purpose', purpose],
    queryFn: () => adminFetch<PurposeOverview & { platformCeilings: PlatformCeilings }>(`/purposes/${purpose}`),
    enabled: !!purpose,
  });
}

export interface UpdateSettingsPayload {
  requestId: string;
  expectedRevision: number;
  adminEnabled: boolean;
  otpLength: number;
  otpTtlSeconds: number;
  maxVerificationAttempts: number;
  resendCooldownSeconds: number;
  maxSendsPerWindow: number;
  rateWindowSeconds: number;
  proofTtlSeconds: number;
  globalRateLimitEnabled: boolean;
  globalRateLimitMaxPerWindow: number | null;
  globalRateLimitWindowSeconds: number | null;
  defaultLocale: Locale;
  locale: Locale;
}

export function useUpdatePurposeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { purpose: VerificationPurpose; payload: UpdateSettingsPayload }) =>
      adminFetch<{ settings: PurposeSettings; effectiveEnabled: boolean }>(`/purposes/${vars.purpose}`, {
        method: 'PUT',
        body: JSON.stringify(vars.payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gv-admin-overview'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-purposes'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-purpose'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-audit'] });
    },
  });
}

export function useResetPurposeSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { purpose: VerificationPurpose; requestId: string; expectedRevision: number; locale: Locale }) =>
      adminFetch<{ settings: PurposeSettings; effectiveEnabled: boolean }>(`/purposes/${vars.purpose}/reset`, {
        method: 'POST',
        body: JSON.stringify({ requestId: vars.requestId, expectedRevision: vars.expectedRevision, locale: vars.locale }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gv-admin-overview'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-purposes'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-purpose'] });
      qc.invalidateQueries({ queryKey: ['gv-admin-audit'] });
    },
  });
}

export function useVerificationAudit(filters: { purpose?: VerificationPurpose; limit?: number }) {
  const params = new URLSearchParams();
  if (filters.purpose) params.set('purpose', filters.purpose);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['gv-admin-audit', filters.purpose ?? 'all', filters.limit ?? 50],
    queryFn: () => adminFetch<{ rows: AuditRow[] }>(`/audit${qs ? `?${qs}` : ''}`),
  });
}

export function useTemplatePreview() {
  return useMutation({
    mutationFn: (locale: Locale) => adminFetch<TemplatePreview>('/templates/preview', {
      method: 'POST',
      body: JSON.stringify({ locale }),
    }),
  });
}
