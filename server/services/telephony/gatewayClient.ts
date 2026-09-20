/**
 * Core → WEBYAR Telephony Control Service client.
 *
 * The control service owns Asterisk: it writes PJSIP Realtime rows, reloads
 * the affected endpoint, watches registration state and drives call control
 * over ARI. Core never opens a SIP socket and never edits Asterisk files.
 *
 * FAIL CLOSED: with no base URL or no TELEPHONY_INTERNAL_SECRET every call
 * returns `gateway_not_configured`. There is no unauthenticated fallback.
 */

import type { ServerConfig } from '../../config.js';
import type {
  RegistrationState,
  TelephonyErrorCode,
  TelephonyGatewayStatus,
  TelephonySipSettings,
} from './types.js';
import { registrationDomain } from './settings.js';
import { telephonyEvent } from './observability.js';

export const TELEPHONY_SECRET_HEADER = 'x-telephony-internal-secret';

const DEFAULT_TIMEOUT_MS = 12_000;

export type GatewayResult<T> =
  | { ok: true; data: T; errorCode?: undefined; detail?: undefined }
  | { ok: false; data?: undefined; errorCode: TelephonyErrorCode; detail?: string };

function configured(config: ServerConfig): boolean {
  return Boolean(config.telephonyInternalBaseUrl && config.telephonyInternalSecret);
}

async function request<T>(
  config: ServerConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GatewayResult<T>> {
  if (!configured(config)) return { ok: false, errorCode: 'gateway_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.telephonyInternalBaseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Same value in both transports: proxies routinely eat Authorization.
        authorization: `Bearer ${config.telephonyInternalSecret}`,
        [TELEPHONY_SECRET_HEADER]: String(config.telephonyInternalSecret),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

    if (!res.ok) {
      const code = (parsed?.error_code as TelephonyErrorCode) || 'gateway_unavailable';
      return { ok: false, errorCode: code, detail: parsed?.error ? String(parsed.error) : `http_${res.status}` };
    }
    return { ok: true, data: (parsed ?? {}) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code: TelephonyErrorCode = /abort|timeout/i.test(message)
      ? 'registration_timeout'
      : /ENOTFOUND|EAI_AGAIN|dns/i.test(message)
        ? 'dns_failure'
        : 'gateway_unavailable';
    telephonyEvent('telephony.gateway.error', { errorCode: code, detail: message });
    return { ok: false, errorCode: code, detail: message };
  } finally {
    clearTimeout(timer);
  }
}

export function isTelephonyGatewayConfigured(config: ServerConfig): boolean {
  return configured(config);
}

export async function gatewayHealth(config: ServerConfig): Promise<GatewayResult<TelephonyGatewayStatus>> {
  return request<TelephonyGatewayStatus>(config, 'GET', '/internal/telephony/health', undefined, 6000);
}

export interface ProvisionInput {
  installationId: string;
  workspaceId: string;
  provider: string;
  settings: TelephonySipSettings;
  /** Decrypted only on this code path, never logged, never returned. */
  sipPassword: string;
}

/**
 * Idempotent, tenant-scoped provisioning. Re-sending the same input produces
 * the same Asterisk rows; only the affected endpoint is reloaded, so other
 * workspaces' registrations are untouched and Asterisk is never restarted.
 */
export async function provisionRegistration(
  config: ServerConfig,
  input: ProvisionInput,
): Promise<GatewayResult<{ state: RegistrationState; error_code?: TelephonyErrorCode }>> {
  return request(config, 'PUT', `/internal/telephony/registrations/${encodeURIComponent(input.installationId)}`, {
    workspace_id: input.workspaceId,
    provider: input.provider,
    sip_username: input.settings.sip_username,
    sip_password: input.sipPassword,
    sip_extension: input.settings.sip_extension,
    domain: registrationDomain(input.settings),
    transport: input.settings.transport,
    outgoing_line: input.settings.outgoing_line,
  }, 20_000);
}

export async function removeRegistration(
  config: ServerConfig,
  installationId: string,
): Promise<GatewayResult<{ removed: boolean }>> {
  return request(config, 'DELETE', `/internal/telephony/registrations/${encodeURIComponent(installationId)}`);
}

export async function testRegistration(
  config: ServerConfig,
  installationId: string,
): Promise<GatewayResult<{ state: RegistrationState; error_code?: TelephonyErrorCode; livekit_sip_ready?: boolean }>> {
  return request(config, 'POST', `/internal/telephony/registrations/${encodeURIComponent(installationId)}/test`, {}, 25_000);
}

export type CallControlAction = 'answer' | 'reject' | 'hangup';

/**
 * Call control. `answer` carries the room the SIP leg must be bridged into —
 * Core decides the room name, the gateway never invents one.
 */
export async function controlCall(
  config: ServerConfig,
  input: { installationId: string; sipCallId: string; action: CallControlAction; roomName?: string | null },
): Promise<GatewayResult<{ ok: boolean }>> {
  return request(config, 'POST', '/internal/telephony/calls/control', {
    installation_id: input.installationId,
    sip_call_id: input.sipCallId,
    action: input.action,
    room_name: input.roomName ?? null,
  });
}
