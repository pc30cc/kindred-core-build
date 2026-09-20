/**
 * Registration provisioning.
 *
 * Core PUTs a tenant's validated SIP settings plus the decrypted password.
 * This module re-validates everything (defence in depth — the SIP password and
 * every identifier end up inside Asterisk configuration), writes the PJSIP
 * Realtime rows, reloads only the affected registration and then reports the
 * REAL registration state observed by Asterisk.
 *
 * The plaintext SIP password lives in exactly two places: this request body in
 * memory, and the restricted `asterisk.ps_auths` row Asterisk needs to answer
 * the provider's digest challenge. It is never logged and never returned.
 */

import type { AsteriskControl, RegistrationOutcome } from './asteriskAri.js';
import type { RealtimeStore } from './database.js';

export type RegistrationState =
  | 'not_configured' | 'configured' | 'registering' | 'registered' | 'failed' | 'disabled';

export type TelephonyErrorCode =
  | 'invalid_credentials' | 'dns_failure' | 'registration_timeout' | 'provider_rejected'
  | 'transport_unsupported' | 'gateway_unavailable' | 'not_configured' | 'unknown_error';

const SIP_USER_RE = /^[A-Za-z0-9._\-+]{1,64}$/;
const EXTENSION_RE = /^[0-9*#]{1,16}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:\d{2,5})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSWORD_RE = /^[\x21-\x7e]{4,128}$/; // printable ASCII, no spaces/control chars
const TRANSPORTS = new Set(['udp', 'tcp', 'tls']);

export interface ProvisionRequest {
  installationId: string;
  workspaceId: string;
  provider: string;
  sipUsername: string;
  sipPassword: string;
  sipExtension: string;
  domain: string;
  transport: string;
}

export type ValidationError =
  | 'installation_id_invalid' | 'workspace_id_invalid' | 'sip_username_invalid'
  | 'sip_password_invalid' | 'sip_extension_invalid' | 'domain_invalid' | 'transport_invalid';

export type ParseResult =
  | { ok: true; value: ProvisionRequest }
  | { ok: false; errors: ValidationError[] };

/** Strict allow-list parsing. Anything outside it is rejected, never escaped. */
export function parseProvisionRequest(installationId: string, body: any): ParseResult {
  const errors: ValidationError[] = [];
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const workspaceId = s(body?.workspace_id);
  const sipUsername = s(body?.sip_username);
  const sipPassword = typeof body?.sip_password === 'string' ? body.sip_password : '';
  const sipExtension = s(body?.sip_extension);
  const domain = s(body?.domain).toLowerCase();
  const transport = (s(body?.transport) || 'udp').toLowerCase();

  if (!UUID_RE.test(installationId)) errors.push('installation_id_invalid');
  if (!UUID_RE.test(workspaceId)) errors.push('workspace_id_invalid');
  if (!SIP_USER_RE.test(sipUsername)) errors.push('sip_username_invalid');
  if (!PASSWORD_RE.test(sipPassword)) errors.push('sip_password_invalid');
  if (!EXTENSION_RE.test(sipExtension)) errors.push('sip_extension_invalid');
  if (!DOMAIN_RE.test(domain)) errors.push('domain_invalid');
  if (!TRANSPORTS.has(transport)) errors.push('transport_invalid');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      installationId,
      workspaceId,
      provider: s(body?.provider) || 'daftareshoma',
      sipUsername,
      sipPassword,
      sipExtension,
      domain,
      transport,
    },
  };
}

/** Stable, SIP-safe Asterisk object id for an installation. */
export function objectIdFor(installationId: string): string {
  return `wby${installationId.replace(/-/g, '')}`;
}

export function outcomeToState(outcome: RegistrationOutcome): {
  state: RegistrationState;
  errorCode: TelephonyErrorCode | null;
} {
  switch (outcome) {
    case 'registered': return { state: 'registered', errorCode: null };
    case 'registering': return { state: 'registering', errorCode: null };
    case 'invalid_credentials': return { state: 'failed', errorCode: 'invalid_credentials' };
    case 'provider_rejected': return { state: 'failed', errorCode: 'provider_rejected' };
    case 'dns_failure': return { state: 'failed', errorCode: 'dns_failure' };
    case 'transport_unsupported': return { state: 'failed', errorCode: 'transport_unsupported' };
    case 'registration_timeout': return { state: 'failed', errorCode: 'registration_timeout' };
    case 'not_found': return { state: 'not_configured', errorCode: 'not_configured' };
    default: return { state: 'failed', errorCode: 'unknown_error' };
  }
}

export interface RegistrationDeps {
  store: RealtimeStore;
  asterisk: AsteriskControl;
  publicSipHost: string;
  timeoutMs: number;
  /** Injectable for tests so nothing sleeps in CI. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits for a terminal registration state. `registering` past the deadline is
 * reported as a timeout, never as success.
 */
export async function waitForRegistration(
  deps: RegistrationDeps,
  objectId: string,
): Promise<RegistrationOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + deps.timeoutMs;
  let last: RegistrationOutcome = 'registering';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      last = await deps.asterisk.registrationState(objectId);
    } catch {
      return 'registration_timeout';
    }
    if (last !== 'registering' && last !== 'not_found') return last;
    if (Date.now() >= deadline) return last === 'not_found' ? 'not_found' : 'registration_timeout';
    await sleep(1000);
  }
}

export async function provisionRegistration(
  deps: RegistrationDeps,
  req: ProvisionRequest,
): Promise<{ state: RegistrationState; errorCode: TelephonyErrorCode | null; objectId: string }> {
  const objectId = objectIdFor(req.installationId);
  await deps.store.upsertRegistration({
    objectId,
    installationId: req.installationId,
    workspaceId: req.workspaceId,
    provider: req.provider,
    sipUsername: req.sipUsername,
    sipPassword: req.sipPassword,
    sipExtension: req.sipExtension,
    domain: req.domain,
    transport: req.transport as 'udp' | 'tcp' | 'tls',
    // Contact user the provider will dial back on; the public host is applied
    // by PJSIP's external_signaling_address (see pjsip.conf template).
    contactUser: req.sipExtension || req.sipUsername,
  });

  await deps.asterisk.reloadRegistration(objectId);
  const outcome = await waitForRegistration(deps, objectId);
  return { ...outcomeToState(outcome), objectId };
}

export async function removeRegistration(
  deps: RegistrationDeps,
  installationId: string,
): Promise<boolean> {
  const objectId = objectIdFor(installationId);
  await deps.asterisk.removeRegistration(objectId).catch(() => undefined);
  return deps.store.deleteRegistration(objectId);
}

export async function testRegistration(
  deps: RegistrationDeps,
  installationId: string,
): Promise<{ state: RegistrationState; errorCode: TelephonyErrorCode | null }> {
  const objectId = objectIdFor(installationId);
  // Kick a fresh REGISTER so the answer reflects the provider right now, not a
  // stale row: a database row alone must never read as "registered".
  await deps.asterisk.reloadRegistration(objectId).catch(() => undefined);
  const outcome = await waitForRegistration(deps, objectId);
  return outcomeToState(outcome);
}
