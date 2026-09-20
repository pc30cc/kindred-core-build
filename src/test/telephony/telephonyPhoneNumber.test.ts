/**
 * PSTN caller identity normalization. The rule that matters: a call must NEVER
 * be dropped because we could not classify the caller ID.
 */
import { describe, expect, it } from 'vitest';
import {
  contactMatchCandidates,
  maskNumberForLog,
  normalizeTelephonyNumber,
  toAsciiDigits,
} from '../../../shared/telephony/phoneNumber.js';
import { normalizePhoneToE164 } from '../../../server/services/phoneVerification/phone.js';

describe('telephony caller-ID normalization', () => {
  it('normalizes Iranian mobiles in every written form', () => {
    for (const input of ['09121234567', '+989121234567', '00989121234567', '989121234567', '۰۹۱۲۱۲۳۴۵۶۷']) {
      const n = normalizeTelephonyNumber(input);
      expect(n.e164, input).toBe('+989121234567');
      expect(n.kind).toBe('e164');
      expect(n.country).toBe('IR');
    }
  });

  it('accepts Iranian landlines that the SMS normalizer rejects on purpose', () => {
    const n = normalizeTelephonyNumber('02191001234');
    expect(n.e164).toBe('+982191001234');
    // The SMS-verification normalizer must stay strict — this is the whole
    // reason the telephony layer exists separately.
    expect((normalizePhoneToE164('02191001234') as { ok: boolean }).ok).toBe(false);
  });

  it('keeps foreign caller IDs usable instead of discarding them', () => {
    expect(normalizeTelephonyNumber('+442071838750').e164).toBe('+442071838750');
    expect(normalizeTelephonyNumber('004915112345678').e164).toBe('+4915112345678');
  });

  it('classifies withheld caller IDs as anonymous and never throws', () => {
    for (const input of ['anonymous', 'Unavailable', '', '   ', 'restricted']) {
      const n = normalizeTelephonyNumber(input);
      expect(n.kind).toBe('anonymous');
      expect(n.e164).toBeNull();
      expect(typeof n.display).toBe('string');
    }
    expect(() => normalizeTelephonyNumber(undefined as never)).not.toThrow();
    expect(() => normalizeTelephonyNumber(null as never)).not.toThrow();
  });

  it('treats short internal codes as extensions, not broken numbers', () => {
    expect(normalizeTelephonyNumber('1001').kind).toBe('short');
  });

  it('offers workspace contact lookup candidates for every stored shape', () => {
    const candidates = contactMatchCandidates(normalizeTelephonyNumber('+989121234567'));
    expect(candidates).toContain('+989121234567');
    expect(candidates).toContain('09121234567');
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('masks numbers before they reach a log line', () => {
    const masked = maskNumberForLog('+989121234567');
    expect(masked).not.toContain('9121234567');
    expect(masked.length).toBeGreaterThan(0);
  });

  it('converts Persian and Arabic-Indic digits', () => {
    expect(toAsciiDigits('۰۹۱۲')).toBe('0912');
    expect(toAsciiDigits('٠٩١٢')).toBe('0912');
  });
});
