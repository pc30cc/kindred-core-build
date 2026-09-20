/**
 * Registration state: the WEBYAR-side mirror of what Asterisk is doing for
 * one workspace installation.
 *
 * Invariants:
 *  - a saved password alone NEVER reads as "registered"; the four readiness
 *    flags (configured / gateway_healthy / sip_registered / livekit_sip_ready)
 *    are independent;
 *  - the encrypted password is decrypted only inside `syncRegistration` and is
 *    handed to the trusted control service and nothing else;
 *  - provisioning is idempotent and scoped to one installation.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type {
  RegistrationState,
  TelephonyErrorCode,
  TelephonyRegistrationRow,
  TelephonySipSettings,
  TelephonyTestResult,
} from './types.js';
import { isRegisterable, maskDomain, registrationDomain } from './settings.js';
import { hasSipPassword, readSipPassword, telephonyCryptoReady } from './secrets.js';
import {
  gatewayHealth,
  isTelephonyGatewayConfigured,
  provisionRegistration,
  removeRegistration,
  testRegistration,
} from './gatewayClient.js';
import { telephonyEvent } from './observability.js';

export const TELEPHONY_PROVIDER_DAFTARESHOMA = 'daftareshoma';

export async function getRegistration(
  config: ServerConfig,
  installationId: string,
): Promise<TelephonyRegistrationRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('telephony_registrations')
    .select('*')
    .eq('installation_id', installationId)
    .maybeSingle();
  if (error) throw new Error(`telephony registration read failed: ${error.message}`);
  return (data as TelephonyRegistrationRow | null) ?? null;
}

export async function getRegistrationByWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<TelephonyRegistrationRow | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('telephony_registrations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`telephony registration read failed: ${error.message}`);
  return (data as TelephonyRegistrationRow | null) ?? null;
}

/** Upserts the non-secret configuration mirror. Idempotent. */
export async function upsertRegistration(
  config: ServerConfig,
  input: {
    installationId: string;
    workspaceId: string;
    provider: string;
    settings: TelephonySipSettings;
    state?: RegistrationState;
  },
): Promise<TelephonyRegistrationRow> {
  const sb = getServiceClient(config);
  const { settings } = input;
  const { data, error } = await sb
    .from('telephony_registrations')
    .upsert(
      {
        installation_id: input.installationId,
        workspace_id: input.workspaceId,
        provider: input.provider,
        sip_username: settings.sip_username || null,
        sip_extension: settings.sip_extension || null,
        sip_domain_udp: settings.sip_domain_udp || null,
        sip_domain_tcp: settings.sip_domain_tcp || null,
        sip_domain_webrtc: settings.sip_domain_webrtc || null,
        outgoing_line: settings.outgoing_line || null,
        transport: settings.transport,
        state: input.state ?? (isRegisterable(settings) ? 'configured' : 'not_configured'),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'installation_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(`telephony registration write failed: ${error.message}`);
  return data as TelephonyRegistrationRow;
}

export async function setRegistrationState(
  config: ServerConfig,
  installationId: string,
  state: RegistrationState,
  errorCode?: TelephonyErrorCode | null,
): Promise<void> {
  const sb = getServiceClient(config);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { state, updated_at: now };
  if (state === 'registered') {
    patch.last_registered_at = now;
    patch.last_error_code = null;
  }
  if (errorCode) {
    patch.last_error_code = errorCode;
    patch.last_error_at = now;
  }
  const { error } = await sb.from('telephony_registrations').update(patch).eq('installation_id', installationId);
  if (error) throw new Error(`telephony registration state write failed: ${error.message}`);
}

export async function markInboundCall(config: ServerConfig, installationId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('telephony_registrations')
    .update({ last_inbound_call_at: new Date().toISOString() })
    .eq('installation_id', installationId);
}

/**
 * Pushes the current configuration + decrypted password to the control
 * service. This is the ONLY place the plaintext password exists in Core, and
 * it lives there for the duration of one HTTPS call.
 */
export async function syncRegistration(
  config: ServerConfig,
  input: { installationId: string; workspaceId: string; provider: string; settings: TelephonySipSettings },
): Promise<{ state: RegistrationState; errorCode: TelephonyErrorCode | null }> {
  if (!isRegisterable(input.settings)) {
    await setRegistrationState(config, input.installationId, 'not_configured');
    return { state: 'not_configured', errorCode: 'not_configured' };
  }
  if (!telephonyCryptoReady(config)) {
    await setRegistrationState(config, input.installationId, 'failed', 'encryption_not_configured');
    return { state: 'failed', errorCode: 'encryption_not_configured' };
  }
  if (!isTelephonyGatewayConfigured(config)) {
    await setRegistrationState(config, input.installationId, 'configured', 'gateway_not_configured');
    return { state: 'configured', errorCode: 'gateway_not_configured' };
  }

  const password = await readSipPassword(config, input.installationId);
  if (!password) {
    await setRegistrationState(config, input.installationId, 'configured', 'not_configured');
    return { state: 'configured', errorCode: 'not_configured' };
  }

  telephonyEvent('telephony.registration.started', {
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    provider: input.provider,
  });
  await setRegistrationState(config, input.installationId, 'registering');

  const started = Date.now();
  const result = await provisionRegistration(config, {
    installationId: input.installationId,
    workspaceId: input.workspaceId,
    provider: input.provider,
    settings: input.settings,
    sipPassword: password,
  });

  if (!result.ok) {
    await setRegistrationState(config, input.installationId, 'failed', result.errorCode);
    telephonyEvent('telephony.registration.failed', {
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      provider: input.provider,
      errorCode: result.errorCode,
      latencyMs: Date.now() - started,
    });
    return { state: 'failed', errorCode: result.errorCode };
  }

  const state = result.data.state ?? 'registering';
  await setRegistrationState(config, input.installationId, state, result.data.error_code ?? null);
  telephonyEvent(
    state === 'registered' ? 'telephony.registration.succeeded' : 'telephony.registration.failed',
    {
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      provider: input.provider,
      errorCode: result.data.error_code ?? null,
      latencyMs: Date.now() - started,
    },
  );
  return { state, errorCode: result.data.error_code ?? null };
}

/** Removes the tenant's Asterisk rows and local state. Safe to call twice. */
export async function deprovisionRegistration(
  config: ServerConfig,
  installationId: string,
): Promise<void> {
  if (isTelephonyGatewayConfigured(config)) {
    await removeRegistration(config, installationId);
  }
  await setRegistrationState(config, installationId, 'disabled');
}

/**
 * Real Test Connection: verifies the live registration at the gateway rather
 * than the shape of the form. Returns only secret-free diagnostics.
 */
export async function runConnectionTest(
  config: ServerConfig,
  input: { installationId: string; workspaceId: string; provider: string; settings: TelephonySipSettings },
): Promise<TelephonyTestResult> {
  const domain = registrationDomain(input.settings);
  const base: TelephonyTestResult = {
    configured: isRegisterable(input.settings) && (await hasSipPassword(config, input.installationId)),
    gateway: 'not_configured',
    registration: 'not_configured',
    extension: input.settings.sip_extension || null,
    domain: maskDomain(domain),
    livekit_sip_ready: false,
  };

  if (!base.configured) return { ...base, error_code: 'not_configured' };

  if (!isTelephonyGatewayConfigured(config)) {
    await setRegistrationState(config, input.installationId, 'configured', 'gateway_not_configured');
    return { ...base, registration: 'configured', error_code: 'gateway_not_configured' };
  }

  const health = await gatewayHealth(config);
  if (!health.ok) {
    await setRegistrationState(config, input.installationId, 'failed', health.errorCode);
    return { ...base, gateway: 'unavailable', registration: 'failed', error_code: health.errorCode };
  }

  // Ensure the tenant's rows exist and are current, then verify registration.
  const synced = await syncRegistration(config, input);
  const verified = await testRegistration(config, input.installationId);

  const livekitReady = Boolean(verified.ok ? (verified.data.livekit_sip_ready ?? health.data.livekit_sip_ready) : health.data.livekit_sip_ready);

  if (!verified.ok) {
    await setRegistrationState(config, input.installationId, 'failed', verified.errorCode);
    return {
      ...base,
      gateway: 'healthy',
      registration: 'failed',
      livekit_sip_ready: livekitReady,
      error_code: verified.errorCode,
    };
  }

  const state = verified.data.state ?? synced.state;
  await setRegistrationState(config, input.installationId, state, verified.data.error_code ?? null);

  return {
    ...base,
    gateway: 'healthy',
    registration: state,
    livekit_sip_ready: livekitReady,
    error_code: verified.data.error_code ?? (livekitReady ? null : 'livekit_sip_unavailable'),
  };
}
