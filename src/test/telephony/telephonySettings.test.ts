/**
 * Settings validation is the config-injection boundary: these values end up in
 * Asterisk PJSIP Realtime rows, so anything outside the allow-lists must be
 * rejected here rather than sanitized downstream.
 */
import { describe, expect, it } from 'vitest';
import {
  accountIdentity,
  isRegisterable,
  maskDomain,
  parseTelephonySettings,
  registrationDomain,
} from '../../../server/services/telephony/settings.js';

const base = {
  sip_username: 'webyar1001',
  sip_extension: '1001',
  sip_domain_udp: 'sip.daftareshoma.com',
  sip_domain_tcp: 'siptcp.daftareshoma.com',
  sip_domain_webrtc: 'wss.daftareshoma.com',
  outgoing_line: '+982191001234',
  transport: 'udp',
};

describe('telephony settings validation', () => {
  it('accepts a complete DaftareShoma account', () => {
    const parsed = parseTelephonySettings(base);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.complete).toBe(true);
    expect(parsed.ok && parsed.settings.transport).toBe('udp');
  });

  it('allows a partially filled form but marks it incomplete', () => {
    const parsed = parseTelephonySettings({ sip_extension: '1001' });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.complete).toBe(false);
  });

  it.each([
    ['sip_username', 'bad user;exten=666', 'sip_username_invalid'],
    ['sip_username', 'a\nb', 'sip_username_invalid'],
    ['sip_extension', '10 01', 'sip_extension_invalid'],
    ['sip_domain_udp', 'sip.example.com/;transport=udp', 'sip_domain_udp_invalid'],
    ['sip_domain_udp', 'sip://sip.example.com', 'sip_domain_udp_invalid'],
    ['sip_domain_webrtc', 'wss.example.com\n[endpoint]', 'sip_domain_webrtc_invalid'],
    ['outgoing_line', '0912-123-4567', 'outgoing_line_invalid'],
    ['transport', 'sctp', 'transport_invalid'],
  ])('rejects config injection in %s', (field, value, code) => {
    const parsed = parseTelephonySettings({ ...base, [field]: value });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors).toContain(code);
  });

  it('picks the registration domain by transport with a safe fallback', () => {
    expect(registrationDomain({ ...base, transport: 'tcp' } as never)).toBe('siptcp.daftareshoma.com');
    expect(registrationDomain({ ...base, transport: 'tls' } as never)).toBe('wss.daftareshoma.com');
    expect(registrationDomain({ ...base, transport: 'tls', sip_domain_webrtc: '' } as never))
      .toBe('siptcp.daftareshoma.com');
  });

  it('derives a stable account identity and never leaks a full domain when masked', () => {
    expect(accountIdentity(base as never)).toBe('webyar1001@sip.daftareshoma.com');
    expect(accountIdentity({ ...base, sip_username: '' } as never)).toBeNull();
    expect(maskDomain('sip.daftareshoma.com')).toBe('***.daftareshoma.com');
    expect(maskDomain(null)).toBeNull();
  });

  it('needs a username and a domain before a REGISTER is attempted', () => {
    expect(isRegisterable(base as never)).toBe(true);
    expect(isRegisterable({ ...base, sip_domain_udp: '', sip_domain_tcp: '' } as never)).toBe(false);
  });
});
