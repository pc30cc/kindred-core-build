/**
 * Generic Verification Core — safe, non-secret readiness snapshot.
 *
 * Every field here is safe to return to a Super Admin browser session:
 * booleans, counts, version NUMBERS, and safe string codes. NEVER a pepper
 * value, a pepper hash, a provider credential, a service-role key, a
 * database connection string, or a raw environment variable dump.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getVerificationCryptoReadiness } from './crypto.js';
import { getSmsProviderInfo } from '../sms/index.js';
import type { SmsProviderInfo } from '../sms/types.js';
import { ALL_VERIFICATION_PURPOSES, type VerificationPurpose } from './types.js';
import { getAllPurposeOverviews, type PurposeOverview } from './adminSettings.js';

/**
 * Readiness is OBSERVATIONAL ONLY — computing one of these values never
 * sends anything and never creates a challenge. Four states, not a
 * boolean, because "no row in app_runtime_config" (unconfigured), "a row
 * exists but is missing the credential a real send would need" (invalid),
 * and "the readiness check itself could not reach the database"
 * (unavailable) are different operational situations that a Super Admin
 * needs to tell apart from "genuinely ready" (configured) — collapsing
 * them into one boolean previously reported "configured" for a
 * provider_name with no usable credential at all.
 */
export type ProviderReadinessState = 'unconfigured' | 'configured' | 'invalid' | 'unavailable';

export interface ReadinessSnapshot {
  status: 'dormant' | 'configured' | 'error';
  pepperConfigured: boolean;
  configuredKeyVersions: number[];
  currentKeyVersion: number | null;
  stableIndexKeyVersion: number;
  cryptoErrorCode?: string;
  emailProviderStatus: ProviderReadinessState;
  smsProviderStatus: ProviderReadinessState;
  databaseAvailable: boolean;
  purposes: Array<{
    purpose: VerificationPurpose;
    adminEnabled: boolean;
    consumerImplemented: boolean;
    deploymentAllowlisted: boolean;
    databaseEnabled: boolean;
    /** Always false in this pass — see the migration 099 verify block for the proof this cannot be forced true. */
    effectiveEnabled: boolean;
  }>;
}

function nonEmptyString(source: Record<string, unknown> | undefined, key: string): boolean {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Classifies the SAME shape `default_email_provider` stores
 * (`{provider_name, config, secrets}` — see server/services/email/index.ts's
 * own `normalizeProviderConfig`) into a readiness state without importing
 * that module's send-path internals. Only checks for the PRESENCE of the
 * credential field each provider's own adapter requires
 * (server/services/email/providers/{resend,sendgrid,smtp}.ts) — never its
 * value.
 */
export function classifyEmailProviderConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): ProviderReadinessState {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const providerNameRaw = typeof row?.provider_name === 'string' ? row.provider_name : typeof row?.provider === 'string' ? row.provider : '';
  const providerName = providerNameRaw.trim().toLowerCase();
  if (!providerName || providerName === 'disabled') return 'unconfigured';

  const cfg = row?.config && typeof row.config === 'object' && !Array.isArray(row.config) ? (row.config as Record<string, unknown>) : undefined;
  const secrets = row?.secrets && typeof row.secrets === 'object' && !Array.isArray(row.secrets) ? (row.secrets as Record<string, unknown>) : undefined;
  const hasCredential = (key: string) => nonEmptyString(cfg, key) || nonEmptyString(secrets, key);

  switch (providerName) {
    case 'resend':
      return hasCredential('api_key') || Boolean(env.RESEND_API_KEY) ? 'configured' : 'invalid';
    case 'sendgrid':
      return hasCredential('api_key') || Boolean(env.SENDGRID_API_KEY) ? 'configured' : 'invalid';
    case 'smtp':
      return hasCredential('smtp_host') || Boolean(env.SMTP_HOST) ? 'configured' : 'invalid';
    default:
      // A provider_name that isn't one of the platform's own adapters.
      return 'invalid';
  }
}

async function getEmailProviderStatus(config: ServerConfig): Promise<ProviderReadinessState> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.from('app_runtime_config').select('value').eq('key', 'default_email_provider').maybeSingle();
    if (error) return 'unavailable';
    return classifyEmailProviderConfig((data as { value?: unknown } | null)?.value);
  } catch {
    return 'unavailable';
  }
}

/**
 * Classifies an already-redacted `SmsProviderInfo` (server/services/sms/
 * index.ts's `getSmsProviderInfo` — never reads a raw credential itself)
 * into the same four-state readiness contract as email.
 */
export function classifySmsProviderInfo(info: SmsProviderInfo): ProviderReadinessState {
  if (info.providerName === 'disabled' || !info.hasApiKey) return 'unconfigured';
  if (info.providerName === 'kavenegar' && !info.sender) return 'invalid';
  if (info.providerName === 'smsir' && (!info.lineNumber || info.verifyTemplateId == null)) return 'invalid';
  return 'configured';
}

async function getSmsProviderStatus(config: ServerConfig): Promise<ProviderReadinessState> {
  try {
    const info = await getSmsProviderInfo(config);
    return classifySmsProviderInfo(info);
  } catch {
    return 'unavailable';
  }
}

async function isDatabaseAvailable(config: ServerConfig): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { error } = await sb.rpc('gv_is_purpose_enabled', { _purpose: 'signup_email' });
    return !error;
  } catch {
    return false;
  }
}

export async function getReadinessSnapshot(config: ServerConfig): Promise<ReadinessSnapshot> {
  const crypto = getVerificationCryptoReadiness();
  const [emailProviderStatus, smsProviderStatus, databaseAvailable, overviews] = await Promise.all([
    getEmailProviderStatus(config),
    getSmsProviderStatus(config),
    isDatabaseAvailable(config),
    getAllPurposeOverviews(config).catch((): PurposeOverview[] => []),
  ]);

  const purposeMap = new Map(overviews.map((o) => [o.purpose, o]));
  const purposes = ALL_VERIFICATION_PURPOSES.map((purpose) => {
    const overview = purposeMap.get(purpose);
    return {
      purpose,
      adminEnabled: overview?.gates.adminEnabled ?? false,
      consumerImplemented: overview?.gates.consumerImplemented ?? false,
      deploymentAllowlisted: overview?.gates.deploymentAllowlisted ?? false,
      databaseEnabled: overview?.gates.databaseEnabled ?? false,
      effectiveEnabled: overview?.gates.effectiveEnabled ?? false,
    };
  });

  const status: ReadinessSnapshot['status'] = crypto.status === 'error' || !databaseAvailable ? 'error' : 'dormant';

  return {
    status,
    pepperConfigured: crypto.status === 'configured',
    configuredKeyVersions: crypto.configuredVersions,
    currentKeyVersion: crypto.currentVersion,
    stableIndexKeyVersion: crypto.stableIndexVersion,
    cryptoErrorCode: crypto.errorCode,
    emailProviderStatus,
    smsProviderStatus,
    databaseAvailable,
    purposes,
  };
}
