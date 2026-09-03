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
import { ALL_VERIFICATION_PURPOSES, type VerificationPurpose } from './types.js';
import { getAllPurposeOverviews, type PurposeOverview } from './adminSettings.js';

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
    /** Always false in this pass — see the migration 099 verify block for the proof this cannot be forced true. */
    effectiveEnabled: boolean;
  }>;
}

async function isPlatformEmailProviderConfigured(config: ServerConfig): Promise<boolean> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.from('app_runtime_config').select('value').eq('key', 'default_email_provider').maybeSingle();
    if (error) return false;
    const value = (data as { value?: unknown } | null)?.value;
    return Boolean(value && typeof value === 'object' && Object.keys(value as object).length > 0);
  } catch {
    return false;
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
  const [emailConfigured, smsInfo, databaseAvailable, overviews] = await Promise.all([
    isPlatformEmailProviderConfigured(config),
    getSmsProviderInfo(config).catch(() => ({ configured: false }) as { configured: boolean }),
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
    emailProviderConfigured: emailConfigured,
    smsProviderConfigured: Boolean(smsInfo.configured),
    databaseAvailable,
    purposes,
  };
}
