/**
 * Anonymous visitor display identity — src/lib/contact-display.ts.
 *
 * Covers the acceptance cases from the visitor-display-identity feature:
 * localized "Visitor from {city} · {code}" fallback, real-name precedence,
 * city-changes-without-touching-identity, and malformed-city resilience.
 */
import { describe, it, expect } from 'vitest';
import {
  contactDisplayName,
  isAnonymousContact,
  resolveVisitorCode,
  sanitizeCity,
  type ContactDisplayT,
} from '../../lib/contact-display';

/** Minimal i18next-shaped t() — interpolates {{var}} exactly like the real one. */
const fa: ContactDisplayT = (key, vars) => {
  const table: Record<string, string> = {
    'inbox.visitorAnonymous': 'بازدیدکننده · {{code}}',
    'inbox.visitorAnonymousFromCity': 'بازدیدکننده از {{city}} · {{code}}',
  };
  let s = table[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, v);
  return s;
};
const en: ContactDisplayT = (key, vars) => {
  const table: Record<string, string> = {
    'inbox.visitorAnonymous': 'Visitor · {{code}}',
    'inbox.visitorAnonymousFromCity': 'Visitor from {{city}} · {{code}}',
  };
  let s = table[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, v);
  return s;
};

describe('contactDisplayName — anonymous fallback', () => {
  it('CASE 1: anonymous + city → "Visitor from {city} · {code}" (fa)', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Tehran')).toBe('بازدیدکننده از Tehran · K7M4');
  });

  it('CASE 2: anonymous + no city → "Visitor · {code}"', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, null)).toBe('بازدیدکننده · K7M4');
    expect(contactDisplayName(contact, 'c1', en, undefined)).toBe('Visitor · K7M4');
  });

  it('CASE 3: named contact → real name wins over city/code', () => {
    const contact = { name: 'Ali Ahmadi', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Tehran')).toBe('Ali Ahmadi');
  });

  it('CASE 5: city changes, code stays the same', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    const before = contactDisplayName(contact, 'c1', fa, 'Tehran');
    const after = contactDisplayName(contact, 'c1', fa, 'Isfahan');
    expect(before).toBe('بازدیدکننده از Tehran · K7M4');
    expect(after).toBe('بازدیدکننده از Isfahan · K7M4');
    expect(before.split('· ')[1]).toBe(after.split('· ')[1]); // code unchanged
  });

  it('CASE 6: visitor becomes identified — same underlying contact, name now wins', () => {
    const anonymous = { name: 'Visitor', visitor_code: 'K7M4' };
    const identified = { name: 'Ali Ahmadi', visitor_code: 'K7M4' }; // same contact, same code
    expect(contactDisplayName(anonymous, 'c1', fa, 'Tehran')).toBe('بازدیدکننده از Tehran · K7M4');
    expect(contactDisplayName(identified, 'c1', fa, 'Tehran')).toBe('Ali Ahmadi');
  });

  it('CASE 8: Persian localization', () => {
    const contact = { name: null, visitor_code: 'P8X4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Shiraz')).toBe('بازدیدکننده از Shiraz · P8X4');
  });

  it('CASE 9: English localization', () => {
    const contact = { name: null, visitor_code: 'P8X4' };
    expect(contactDisplayName(contact, 'c1', en, 'Shiraz')).toBe('Visitor from Shiraz · P8X4');
  });

  it('CASE 10: null city treated as unavailable', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe('Visitor · K7M4');
  });

  it('CASE 11: empty/whitespace city treated as unavailable', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, '')).toBe('Visitor · K7M4');
    expect(contactDisplayName(contact, 'c1', en, '   ')).toBe('Visitor · K7M4');
  });

  it('CASE 12: malformed city values ("null"/"undefined"/"Unknown") never render literally', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    for (const bad of ['null', 'undefined', 'Unknown', 'N/A']) {
      const out = contactDisplayName(contact, 'c1', en, bad);
      expect(out).toBe('Visitor · K7M4');
      expect(out).not.toMatch(/from (null|undefined|Unknown)/i);
    }
  });

  it('CASE 13: legacy contact with no visitor_code and no anon_code derives a stable fallback from the contact id, never crashes', () => {
    const contact = { name: 'Visitor' };
    const out1 = contactDisplayName(contact, 'contact-id-abc', en, null);
    const out2 = contactDisplayName(contact, 'contact-id-abc', en, null);
    expect(out1).toBe(out2); // stable, not re-randomized per render
    expect(out1).toMatch(/^Visitor · [A-Z0-9]{4}$/);
  });

  it('legacy metadata.anon_code is used when visitor_code column is absent', () => {
    const contact = { name: 'Visitor', metadata: { anon_code: 'LEGA' } };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe('Visitor · LEGA');
  });

  it('persisted visitor_code takes precedence over legacy metadata.anon_code', () => {
    const contact = { name: 'Visitor', visitor_code: 'NEWW', metadata: { anon_code: 'OLDD' } };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe('Visitor · NEWW');
  });

  it('email-only contact (no name) shows the email, not the anonymous label — pre-existing behavior preserved', () => {
    const contact = { name: null, email: 'ali@example.com', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, 'Tehran')).toBe('ali@example.com');
  });

  it('CASE 15: never renders the "Visitor" placeholder name string as-is even if city/code are present', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    const out = contactDisplayName(contact, 'c1', en, 'Tehran');
    expect(out).not.toBe('Visitor');
    expect(out).toBe('Visitor from Tehran · K7M4');
  });

  it('null contact never crashes the resolver', () => {
    expect(() => contactDisplayName(null, 'c1', en, 'Tehran')).not.toThrow();
    expect(contactDisplayName(null, 'c1', en, null)).toMatch(/^Visitor · /);
  });
});

describe('isAnonymousContact', () => {
  it('true for the placeholder name with no email', () => {
    expect(isAnonymousContact({ name: 'Visitor' })).toBe(true);
    expect(isAnonymousContact({ name: null })).toBe(true);
    expect(isAnonymousContact(null)).toBe(true);
  });
  it('false once a real name or email exists', () => {
    expect(isAnonymousContact({ name: 'Ali Ahmadi' })).toBe(false);
    expect(isAnonymousContact({ name: 'Visitor', email: 'a@b.com' })).toBe(false);
  });
});

describe('sanitizeCity', () => {
  it('accepts a real city', () => {
    expect(sanitizeCity('Tehran')).toBe('Tehran');
  });
  it('rejects non-string, empty, whitespace and sentinel values', () => {
    expect(sanitizeCity(undefined)).toBeNull();
    expect(sanitizeCity(null)).toBeNull();
    expect(sanitizeCity(42)).toBeNull();
    expect(sanitizeCity('')).toBeNull();
    expect(sanitizeCity('   ')).toBeNull();
    expect(sanitizeCity('null')).toBeNull();
    expect(sanitizeCity('undefined')).toBeNull();
    expect(sanitizeCity('unknown')).toBeNull();
  });
});

describe('resolveVisitorCode', () => {
  it('prefers the persisted column over metadata.anon_code and the id-derived fallback', () => {
    expect(resolveVisitorCode({ visitor_code: 'AAAA', metadata: { anon_code: 'BBBB' } }, 'x')).toBe('AAAA');
  });
  it('falls back to metadata.anon_code when the column is absent', () => {
    expect(resolveVisitorCode({ metadata: { anon_code: 'BBBB' } }, 'x')).toBe('BBBB');
  });
  it('CASE 14: the code alone carries no authorization semantics — it is just a display string', () => {
    // resolveVisitorCode never touches the network/auth layer; it is a pure
    // string transform of already-authorized data. Asserting its return type
    // stays a plain code (no embedded ids/tokens) is the contract test here.
    const code = resolveVisitorCode({ visitor_code: 'K7M4' }, 'contact-id');
    expect(code).toBe('K7M4');
    expect(code).not.toContain('contact-id');
  });
});
