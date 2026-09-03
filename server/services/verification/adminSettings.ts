/**
 * Generic Verification Core — Super Admin settings service.
 *
 * Every mutation goes through the single `gv_admin_update_purpose_settings`
 * RPC (database/migrations/099_generic_verification_admin_settings.sql) —
 * this file never issues a direct UPDATE/INSERT against
 * verification_purpose_settings or its audit table (service_role has no
 * grant to do so; see 099's own verify block). Reads go straight to the
 * table via a plain SELECT (service_role has SELECT there).
 *
 * NOTHING here can activate a purpose: `effectiveEnabled` is always
 * computed by the database's own `gv_admin_effective_enabled`, which ANDs
 * in `gv_admin_consumer_implemented`/`gv_admin_deployment_allowlisted`
 * (both hardcoded empty in 099) and `gv_is_purpose_enabled` (hardcoded
 * empty in 098) — this file cannot make it return anything but false in
 * this pass, no matter what admin_enabled is set to.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  ALL_VERIFICATION_PURPOSES, PLATFORM_MAXIMUMS, findPolicyWeakeningViolations,
  type VerificationPurpose,
} from './types.js';

export class VerificationAdminError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'VerificationAdminError';
  }
}

const ERROR_STATUS: Record<string, number> = {
  PURPOSE_UNKNOWN: 404,
  PURPOSE_NOT_DEPLOYED: 409,
  REVISION_CONFLICT: 409,
  ADMIN_REQUEST_CONFLICT: 409,
  ADMIN_REQUEST_ID_INVALID: 400,
  ADMIN_ACTION_UNKNOWN: 400,
  POLICY_WEAKENING_NOT_ALLOWED: 400,
};

function throwForRpcError(message: string): never {
  const code = Object.keys(ERROR_STATUS).find((c) => message.includes(c));
  if (code) throw new VerificationAdminError(code, ERROR_STATUS[code]);
  // A CHECK-constraint violation or any other unexpected DB error — never
  // forward the raw Postgres message (it can echo back submitted values).
  throw new VerificationAdminError('SETTINGS_INVALID', 400);
}

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
  defaultLocale: 'fa' | 'tr' | 'en';
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

function mapRow(row: Record<string, unknown>): PurposeSettings {
  return {
    purpose: row.purpose as VerificationPurpose,
    adminEnabled: Boolean(row.admin_enabled),
    otpLength: Number(row.otp_length),
    otpTtlSeconds: Number(row.otp_ttl_seconds),
    maxVerificationAttempts: Number(row.max_verification_attempts),
    resendCooldownSeconds: Number(row.resend_cooldown_seconds),
    maxSendsPerWindow: Number(row.max_sends_per_window),
    rateWindowSeconds: Number(row.rate_window_seconds),
    proofTtlSeconds: Number(row.proof_ttl_seconds),
    globalRateLimitEnabled: Boolean(row.global_rate_limit_enabled),
    globalRateLimitMaxPerWindow: row.global_rate_limit_max_per_window == null ? null : Number(row.global_rate_limit_max_per_window),
    globalRateLimitWindowSeconds: row.global_rate_limit_window_seconds == null ? null : Number(row.global_rate_limit_window_seconds),
    defaultLocale: row.default_locale as 'fa' | 'tr' | 'en',
    revision: Number(row.revision),
    updatedBy: (row.updated_by as string) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function assertKnownPurpose(purpose: string): asserts purpose is VerificationPurpose {
  if (!ALL_VERIFICATION_PURPOSES.includes(purpose as VerificationPurpose)) {
    throw new VerificationAdminError('PURPOSE_UNKNOWN', 404);
  }
}

export async function getAllPurposeSettings(config: ServerConfig): Promise<PurposeSettings[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('verification_purpose_settings').select('*').order('purpose');
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapRow);
}

export async function getPurposeSettings(config: ServerConfig, purpose: string): Promise<PurposeSettings> {
  assertKnownPurpose(purpose);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('verification_purpose_settings').select('*').eq('purpose', purpose).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new VerificationAdminError('PURPOSE_UNKNOWN', 404);
  return mapRow(data);
}

/** Gate values are always independently re-derived from the database's own hardcoded-closed functions — never trusted from application state. */
export async function getPurposeGates(config: ServerConfig, purpose: string): Promise<PurposeGates> {
  assertKnownPurpose(purpose);
  const sb = getServiceClient(config);
  const [settings, consumer, deployment, database, effective] = await Promise.all([
    getPurposeSettings(config, purpose),
    sb.rpc('gv_admin_consumer_implemented', { _purpose: purpose }),
    sb.rpc('gv_admin_deployment_allowlisted', { _purpose: purpose }),
    sb.rpc('gv_is_purpose_enabled', { _purpose: purpose }),
    sb.rpc('gv_admin_effective_enabled', { _purpose: purpose }),
  ]);
  if (consumer.error) throw new Error(consumer.error.message);
  if (deployment.error) throw new Error(deployment.error.message);
  if (database.error) throw new Error(database.error.message);
  if (effective.error) throw new Error(effective.error.message);
  return {
    adminEnabled: settings.adminEnabled,
    consumerImplemented: Boolean(consumer.data),
    deploymentAllowlisted: Boolean(deployment.data),
    databaseEnabled: Boolean(database.data),
    effectiveEnabled: Boolean(effective.data),
  };
}

export async function getPurposeOverview(config: ServerConfig, purpose: string): Promise<PurposeOverview> {
  assertKnownPurpose(purpose);
  const [settings, gates] = await Promise.all([getPurposeSettings(config, purpose), getPurposeGates(config, purpose)]);
  return { purpose, settings, gates };
}

export async function getAllPurposeOverviews(config: ServerConfig): Promise<PurposeOverview[]> {
  return Promise.all(ALL_VERIFICATION_PURPOSES.map((p) => getPurposeOverview(config, p)));
}

export interface UpdatePurposeSettingsInput {
  purpose: string;
  requestId: string;
  actorProfileId: string;
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
  defaultLocale: 'fa' | 'tr' | 'en';
  ipHash: string | null;
  userAgent: string | null;
  locale: 'fa' | 'tr' | 'en';
}

export interface UpdatePurposeSettingsResult {
  settings: PurposeSettings;
  effectiveEnabled: boolean;
  replayed: boolean;
}

async function callUpdateRpc(
  config: ServerConfig,
  action: 'update' | 'reset',
  input: UpdatePurposeSettingsInput,
): Promise<UpdatePurposeSettingsResult> {
  assertKnownPurpose(input.purpose);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_admin_update_purpose_settings', {
    _request_id: input.requestId,
    _purpose: input.purpose,
    _action: action,
    _actor_profile_id: input.actorProfileId,
    _expected_revision: input.expectedRevision,
    _admin_enabled: input.adminEnabled,
    _otp_length: input.otpLength,
    _otp_ttl_seconds: input.otpTtlSeconds,
    _max_verification_attempts: input.maxVerificationAttempts,
    _resend_cooldown_seconds: input.resendCooldownSeconds,
    _max_sends_per_window: input.maxSendsPerWindow,
    _rate_window_seconds: input.rateWindowSeconds,
    _proof_ttl_seconds: input.proofTtlSeconds,
    _global_rate_limit_enabled: input.globalRateLimitEnabled,
    _global_rate_limit_max_per_window: input.globalRateLimitMaxPerWindow,
    _global_rate_limit_window_seconds: input.globalRateLimitWindowSeconds,
    _default_locale: input.defaultLocale,
    _ip_hash: input.ipHash,
    _user_agent: input.userAgent,
    _locale: input.locale,
  });
  if (error) throwForRpcError(error.message || '');
  const outcome = data as { replayed: boolean; result: { settings: Record<string, unknown>; effectiveEnabled: boolean } };
  return {
    settings: {
      purpose: outcome.result.settings.purpose as VerificationPurpose,
      adminEnabled: Boolean(outcome.result.settings.adminEnabled),
      otpLength: Number(outcome.result.settings.otpLength),
      otpTtlSeconds: Number(outcome.result.settings.otpTtlSeconds),
      maxVerificationAttempts: Number(outcome.result.settings.maxVerificationAttempts),
      resendCooldownSeconds: Number(outcome.result.settings.resendCooldownSeconds),
      maxSendsPerWindow: Number(outcome.result.settings.maxSendsPerWindow),
      rateWindowSeconds: Number(outcome.result.settings.rateWindowSeconds),
      proofTtlSeconds: Number(outcome.result.settings.proofTtlSeconds),
      globalRateLimitEnabled: Boolean(outcome.result.settings.globalRateLimitEnabled),
      globalRateLimitMaxPerWindow: outcome.result.settings.globalRateLimitMaxPerWindow == null ? null : Number(outcome.result.settings.globalRateLimitMaxPerWindow),
      globalRateLimitWindowSeconds: outcome.result.settings.globalRateLimitWindowSeconds == null ? null : Number(outcome.result.settings.globalRateLimitWindowSeconds),
      defaultLocale: outcome.result.settings.defaultLocale as 'fa' | 'tr' | 'en',
      revision: Number(outcome.result.settings.revision),
      updatedBy: input.actorProfileId,
      updatedAt: new Date().toISOString(),
    },
    effectiveEnabled: outcome.result.effectiveEnabled,
    replayed: outcome.replayed,
  };
}

/**
 * Fast, clean 400 for the common case — the database RPC (migration 100's
 * gv_admin_update_purpose_settings) independently re-enforces the SAME
 * tightening-only rule against the SAME canonical baseline
 * (gv_admin_default_settings, proven identical to getAdminPolicyBaseline by
 * a parity test), so a caller that reaches the RPC directly — bypassing
 * this service layer entirely — still cannot widen a purpose's policy.
 */
export async function updatePurposeSettings(config: ServerConfig, input: UpdatePurposeSettingsInput): Promise<UpdatePurposeSettingsResult> {
  assertKnownPurpose(input.purpose);
  const violations = findPolicyWeakeningViolations(input.purpose, input);
  if (violations.length > 0) {
    throw new VerificationAdminError('POLICY_WEAKENING_NOT_ALLOWED', 400);
  }
  return callUpdateRpc(config, 'update', input);
}

export async function resetPurposeSettings(
  config: ServerConfig,
  input: Pick<UpdatePurposeSettingsInput, 'purpose' | 'requestId' | 'actorProfileId' | 'expectedRevision' | 'ipHash' | 'userAgent' | 'locale'>,
): Promise<UpdatePurposeSettingsResult> {
  // Reset ignores every numeric/boolean policy field on the way in — the
  // RPC substitutes gv_admin_default_settings() and forces admin_enabled
  // back to false regardless of what's passed here.
  return callUpdateRpc(config, 'reset', {
    ...input,
    adminEnabled: false,
    otpLength: 0, otpTtlSeconds: 0, maxVerificationAttempts: 0, resendCooldownSeconds: 0,
    maxSendsPerWindow: 0, rateWindowSeconds: 0, proofTtlSeconds: 0,
    globalRateLimitEnabled: false, globalRateLimitMaxPerWindow: null, globalRateLimitWindowSeconds: null,
    defaultLocale: 'en',
  });
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

export interface AuditQuery {
  purpose?: string;
  limit?: number;
  before?: string;
}

export async function getAuditHistory(config: ServerConfig, query: AuditQuery): Promise<AuditRow[]> {
  const sb = getServiceClient(config);
  let q = sb.from('verification_purpose_settings_audit')
    .select('id, purpose, action, previous_settings, new_settings, actor_profile_id, request_id, locale, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
  if (query.purpose) q = q.eq('purpose', query.purpose);
  if (query.before) q = q.lt('created_at', query.before);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    purpose: r.purpose as string,
    action: r.action as 'update' | 'reset',
    previousSettings: r.previous_settings as Record<string, unknown>,
    newSettings: r.new_settings as Record<string, unknown>,
    actorProfileId: (r.actor_profile_id as string) ?? null,
    requestId: r.request_id as string,
    // ip_hash/user_agent are deliberately NOT selected/returned here — the
    // audit page needs actor/purpose/changed-fields/timestamp/locale, not
    // raw request metadata, keeping the API response minimal.
    locale: (r.locale as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

/** Platform ceilings, exposed read-only so the UI can show them beside each editable field. */
export function getPlatformCeilings() {
  return {
    otpLength: PLATFORM_MAXIMUMS.otpLength,
    otpTtlSeconds: PLATFORM_MAXIMUMS.otpTtlSeconds,
    resendCooldownSecondsMin: PLATFORM_MAXIMUMS.resendCooldownSecondsMin,
    maxSendsPerWindow: PLATFORM_MAXIMUMS.maxSendsPerWindow,
    rateWindowSeconds: PLATFORM_MAXIMUMS.rateWindowSeconds,
    maxVerificationAttempts: PLATFORM_MAXIMUMS.maxVerificationAttempts,
    proofTtlSeconds: PLATFORM_MAXIMUMS.proofTtlSeconds,
    globalRateLimitWindowSecondsMax: PLATFORM_MAXIMUMS.globalRateLimitWindowSecondsMax,
    globalRateLimitMaxPerWindowMax: PLATFORM_MAXIMUMS.globalRateLimitMaxPerWindowMax,
  };
}
