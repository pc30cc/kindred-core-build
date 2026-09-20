/**
 * Validation + normalization of the non-secret SIP settings.
 *
 * Everything here exists for ONE reason: these values are eventually written
 * into Asterisk PJSIP Realtime rows and used to build SIP URIs. Any character
 * outside the strict allow-lists below could turn a configuration row into a
 * configuration injection, so untrusted strings never reach the telephony
 * service unvalidated.
 */

import type { TelephonySipSettings, TelephonyTransport } from './types.js';

/** SIP user parts: letters, digits and a conservative punctuation subset. */
const SIP_USER_RE = /^[A-Za-z0-9._\-+]{1,64}$/;
/** Extensions: digits (and `*`/`#` for provider short codes). */
const EXTENSION_RE = /^[0-9*#]{1,16}$/;
/** Hostname with optional :port. No schemes, no paths, no parameters. */
const SIP_DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:\d{2,5})?$/;
/** Outgoing caller line: digits, optional leading +. */
const LINE_RE = /^\+?[0-9]{3,20}$/;

const TRANSPORTS: readonly TelephonyTransport[] = ['udp', 'tcp', 'tls'];

export type SettingsFieldError =
  | 'sip_username_invalid'
  | 'sip_extension_invalid'
  | 'sip_domain_udp_invalid'
  | 'sip_domain_tcp_invalid'
  | 'sip_domain_webrtc_invalid'
  | 'outgoing_line_invalid'
  | 'transport_invalid';

export type ParsedSettings =
  | { ok: true; settings: TelephonySipSettings; complete: boolean; errors?: undefined }
  | { ok: false; settings?: undefined; complete?: undefined; errors: SettingsFieldError[] };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validates a settings object. Empty optional fields are allowed (MVP lets the
 * user save a partially filled form), but any PRESENT value must be valid.
 * `complete` reports whether the minimum needed to register is present.
 */
export function parseTelephonySettings(input: unknown): ParsedSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const errors: SettingsFieldError[] = [];

  const sip_username = str(raw.sip_username);
  const sip_extension = str(raw.sip_extension);
  const sip_domain_udp = str(raw.sip_domain_udp).toLowerCase();
  const sip_domain_tcp = str(raw.sip_domain_tcp).toLowerCase();
  const sip_domain_webrtc = str(raw.sip_domain_webrtc).toLowerCase();
  const outgoing_line = str(raw.outgoing_line);
  const transportRaw = str(raw.transport).toLowerCase() || 'udp';

  if (sip_username && !SIP_USER_RE.test(sip_username)) errors.push('sip_username_invalid');
  if (sip_extension && !EXTENSION_RE.test(sip_extension)) errors.push('sip_extension_invalid');
  if (sip_domain_udp && !SIP_DOMAIN_RE.test(sip_domain_udp)) errors.push('sip_domain_udp_invalid');
  if (sip_domain_tcp && !SIP_DOMAIN_RE.test(sip_domain_tcp)) errors.push('sip_domain_tcp_invalid');
  if (sip_domain_webrtc && !SIP_DOMAIN_RE.test(sip_domain_webrtc)) errors.push('sip_domain_webrtc_invalid');
  if (outgoing_line && !LINE_RE.test(outgoing_line)) errors.push('outgoing_line_invalid');
  if (!TRANSPORTS.includes(transportRaw as TelephonyTransport)) errors.push('transport_invalid');

  if (errors.length) return { ok: false, errors };

  const settings: TelephonySipSettings = {
    sip_username,
    sip_extension,
    sip_domain_udp,
    sip_domain_tcp,
    sip_domain_webrtc,
    outgoing_line,
    transport: transportRaw as TelephonyTransport,
  };

  return { ok: true, settings, complete: isRegisterable(settings) };
}

/** The minimum set Asterisk needs to attempt a REGISTER. */
export function isRegisterable(s: TelephonySipSettings): boolean {
  return Boolean(s.sip_username && registrationDomain(s));
}

/** The domain used for registration, chosen by transport with a safe fallback. */
export function registrationDomain(s: TelephonySipSettings): string {
  if (s.transport === 'tcp') return s.sip_domain_tcp || s.sip_domain_udp || '';
  if (s.transport === 'tls') return s.sip_domain_webrtc || s.sip_domain_tcp || s.sip_domain_udp || '';
  return s.sip_domain_udp || s.sip_domain_tcp || '';
}

/** Stable provider account identity: `user@domain`, never used as a secret. */
export function accountIdentity(s: TelephonySipSettings): string | null {
  const domain = registrationDomain(s);
  if (!s.sip_username || !domain) return null;
  return `${s.sip_username}@${domain}`;
}

/** Masks a domain for UI/diagnostics: keeps the registrable suffix. */
export function maskDomain(domain: string | null | undefined): string | null {
  const d = String(domain ?? '');
  if (!d) return null;
  const parts = d.split(':')[0].split('.');
  if (parts.length <= 2) return d;
  return `***.${parts.slice(-2).join('.')}`;
}
