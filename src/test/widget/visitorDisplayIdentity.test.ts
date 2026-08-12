/**
 * Anonymous visitor display identity — src/lib/contact-display.ts.
 *
 * Covers the acceptance cases from the visitor-display-identity feature:
 * localized "Visitor from {city} · {code}" fallback, real-name precedence,
 * city-changes-without-touching-identity, malformed-city resilience, and
 * locale-aware region/country localization + bidi isolation of the Latin
 * visitor code embedded in RTL text.
 *
 * Iran-specific rule: for country_code=IR, the anonymous label is built
 * from `geo.region` (province), never `geo.city` — see
 * src/lib/geo/iranProvinceLocalization.ts and the module doc comment in
 * contact-display.ts. Every other country still uses `geo.city`, canonical.
 */
import { describe, it, expect } from 'vitest';
import {
  contactDisplayName,
  isAnonymousContact,
  resolveVisitorCode,
  sanitizeCity,
  type ContactDisplayT,
} from '../../lib/contact-display';
import { getDisplayName } from '../../features/contacts/utils';

const FSI = '⁨';
const PDI = '⁩';
/** Wrap a value the same way contact-display.ts's bidi isolation does, for building expected strings. */
const iso = (s: string) => `${FSI}${s}${PDI}`;

/** Minimal i18next-shaped t() — interpolates {{var}} exactly like the real one. */
const fa: ContactDisplayT = (key, vars) => {
  const table: Record<string, string> = {
    'inbox.visitorAnonymous': 'بازدیدکننده · {{code}}',
    'inbox.visitorAnonymousFromCity': 'بازدیدکننده از {{city}} · {{code}}',
    'inbox.visitorAnonymousFromRegion': 'بازدیدکننده از استان {{region}} · {{code}}',
  };
  let s = table[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, v);
  return s;
};
const en: ContactDisplayT = (key, vars) => {
  const table: Record<string, string> = {
    'inbox.visitorAnonymous': 'Visitor · {{code}}',
    'inbox.visitorAnonymousFromCity': 'Visitor from {{city}} · {{code}}',
    'inbox.visitorAnonymousFromRegion': 'Visitor from {{region}} · {{code}}',
  };
  let s = table[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, v);
  return s;
};
const tr: ContactDisplayT = (key, vars) => {
  const table: Record<string, string> = {
    'inbox.visitorAnonymous': 'Ziyaretçi · {{code}}',
    'inbox.visitorAnonymousFromCity': '{{city}} ziyaretçi · {{code}}',
    'inbox.visitorAnonymousFromRegion': '{{region}} ziyaretçi · {{code}}',
  };
  let s = table[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{{${k}}}`, v);
  return s;
};

describe('contactDisplayName — anonymous fallback (no locale passed — canonical city, isolated code)', () => {
  it('CASE 1: anonymous + city → "Visitor from {city} · {code}" (fa)', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Tehran')).toBe(`بازدیدکننده از ${iso('Tehran')} · ${iso('K7M4')}`);
  });

  it('CASE 2: anonymous + no city → "Visitor · {code}"', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, null)).toBe(`بازدیدکننده · ${iso('K7M4')}`);
    expect(contactDisplayName(contact, 'c1', en, undefined)).toBe(`Visitor · ${iso('K7M4')}`);
  });

  it('CASE 3: named contact → real name wins over city/code', () => {
    const contact = { name: 'Ali Ahmadi', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Tehran')).toBe('Ali Ahmadi');
  });

  it('CASE 5: city changes, code stays the same', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    const before = contactDisplayName(contact, 'c1', fa, 'Tehran');
    const after = contactDisplayName(contact, 'c1', fa, 'Isfahan');
    expect(before).toBe(`بازدیدکننده از ${iso('Tehran')} · ${iso('K7M4')}`);
    expect(after).toBe(`بازدیدکننده از ${iso('Isfahan')} · ${iso('K7M4')}`);
    expect(before.split('· ')[1]).toBe(after.split('· ')[1]); // code unchanged
  });

  it('CASE 6: visitor becomes identified — same underlying contact, name now wins', () => {
    const anonymous = { name: 'Visitor', visitor_code: 'K7M4' };
    const identified = { name: 'Ali Ahmadi', visitor_code: 'K7M4' }; // same contact, same code
    expect(contactDisplayName(anonymous, 'c1', fa, 'Tehran')).toBe(`بازدیدکننده از ${iso('Tehran')} · ${iso('K7M4')}`);
    expect(contactDisplayName(identified, 'c1', fa, 'Tehran')).toBe('Ali Ahmadi');
  });

  it('CASE 8: Persian localization', () => {
    const contact = { name: null, visitor_code: 'P8X4' };
    expect(contactDisplayName(contact, 'c1', fa, 'Shiraz')).toBe(`بازدیدکننده از ${iso('Shiraz')} · ${iso('P8X4')}`);
  });

  it('CASE 9: English localization', () => {
    const contact = { name: null, visitor_code: 'P8X4' };
    expect(contactDisplayName(contact, 'c1', en, 'Shiraz')).toBe(`Visitor from ${iso('Shiraz')} · ${iso('P8X4')}`);
  });

  it('CASE 10: null city treated as unavailable', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe(`Visitor · ${iso('K7M4')}`);
  });

  it('CASE 11: empty/whitespace city treated as unavailable', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, '')).toBe(`Visitor · ${iso('K7M4')}`);
    expect(contactDisplayName(contact, 'c1', en, '   ')).toBe(`Visitor · ${iso('K7M4')}`);
  });

  it('CASE 12: malformed city values ("null"/"undefined"/"Unknown") never render literally', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    for (const bad of ['null', 'undefined', 'Unknown', 'N/A']) {
      const out = contactDisplayName(contact, 'c1', en, bad);
      expect(out).toBe(`Visitor · ${iso('K7M4')}`);
      expect(out).not.toMatch(/from (null|undefined|Unknown)/i);
    }
  });

  it('CASE 13: legacy contact with no visitor_code and no anon_code derives a stable fallback from the contact id, never crashes', () => {
    const contact = { name: 'Visitor' };
    const out1 = contactDisplayName(contact, 'contact-id-abc', en, null);
    const out2 = contactDisplayName(contact, 'contact-id-abc', en, null);
    expect(out1).toBe(out2); // stable, not re-randomized per render
    expect(out1).toMatch(new RegExp(`^Visitor · ${FSI}[A-Z0-9]{4}${PDI}$`));
  });

  it('legacy metadata.anon_code is used when visitor_code column is absent', () => {
    const contact = { name: 'Visitor', metadata: { anon_code: 'LEGA' } };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe(`Visitor · ${iso('LEGA')}`);
  });

  it('persisted visitor_code takes precedence over legacy metadata.anon_code', () => {
    const contact = { name: 'Visitor', visitor_code: 'NEWW', metadata: { anon_code: 'OLDD' } };
    expect(contactDisplayName(contact, 'c1', en, null)).toBe(`Visitor · ${iso('NEWW')}`);
  });

  it('email-only contact (no name) shows the localized anonymous label, NOT the email — email is metadata, not a display name', () => {
    const contact = { name: null, email: 'ali@example.com', visitor_code: 'K7M4' };
    expect(contactDisplayName(contact, 'c1', en, 'Tehran')).toBe(`Visitor from ${iso('Tehran')} · ${iso('K7M4')}`);
    expect(contactDisplayName(contact, 'c1', fa, 'Tehran')).toBe(`بازدیدکننده از ${iso('Tehran')} · ${iso('K7M4')}`);
  });

  it('phone-only contact (no name) shows the localized anonymous label, NOT the phone number', () => {
    const contact = { name: null, phone: '+15551234567' } as any;
    const out = contactDisplayName(contact, 'c1', en, null);
    expect(out).not.toContain('+15551234567');
    expect(out).toMatch(/^Visitor · /);
  });

  it('CASE 15: never renders the "Visitor" placeholder name string as-is even if city/code are present', () => {
    const contact = { name: 'Visitor', visitor_code: 'K7M4' };
    const out = contactDisplayName(contact, 'c1', en, 'Tehran');
    expect(out).not.toBe('Visitor');
    expect(out).toBe(`Visitor from ${iso('Tehran')} · ${iso('K7M4')}`);
  });

  it('null contact never crashes the resolver', () => {
    expect(() => contactDisplayName(null, 'c1', en, 'Tehran')).not.toThrow();
    expect(contactDisplayName(null, 'c1', en, null)).toMatch(/^Visitor · /);
  });
});

describe('contactDisplayName — Iran uses province, not city (region-based identity)', () => {
  it('fa + IR + region → "بازدیدکننده از استان {province} · {code}", city ignored even when present', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { city: 'Tehran', region: 'Tehran', country_code: 'IR' }, 'fa');
    expect(out).toBe(`بازدیدکننده از استان ${iso('تهران')} · ${iso('PTXJ')}`);
  });

  it('exact examples from the product spec — all 4 provinces', () => {
    const cases: Array<[string, string, string]> = [
      ['K7M4', 'Tehran', 'تهران'],
      ['K7M5', 'Fars', 'فارس'],
      ['R8Q2', 'Gilan', 'گیلان'],
      ['M4TZ', 'Razavi Khorasan', 'خراسان رضوی'],
    ];
    for (const [code, region, fa_] of cases) {
      const contact = { name: null, visitor_code: code };
      const out = contactDisplayName(contact, 'c1', fa, { region, country_code: 'IR' }, 'fa');
      expect(out).toBe(`بازدیدکننده از استان ${iso(fa_)} · ${iso(code)}`);
    }
  });

  it('city is NEVER used for an Iranian visitor, even when region is missing — falls to the no-place label, not city', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { city: 'Tehran', country_code: 'IR' }, 'fa'); // region omitted
    expect(out).toBe(`بازدیدکننده · ${iso('PTXJ')}`);
    expect(out).not.toContain('Tehran');
    expect(out).not.toContain('تهران');
  });

  it('fa + IR + no region at all → "بازدیدکننده · {code}"', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { country_code: 'IR' }, 'fa');
    expect(out).toBe(`بازدیدکننده · ${iso('PTXJ')}`);
  });

  it('real name still wins over an Iranian province', () => {
    const contact = { name: 'Ali Ahmadi', visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { region: 'Tehran', country_code: 'IR' }, 'fa');
    expect(out).toBe('Ali Ahmadi');
  });

  it('en locale never translates the province — stays canonical', () => {
    const contact = { name: null, visitor_code: 'K7M4' };
    const out = contactDisplayName(contact, 'c1', en, { region: 'Tehran', country_code: 'IR' }, 'en');
    expect(out).toBe(`Visitor from ${iso('Tehran')} · ${iso('K7M4')}`);
  });

  it('tr locale applies the Turkish ablative suffix to the canonical province name', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', tr, { region: 'Tehran', country_code: 'IR' }, 'tr');
    expect(out).toBe(`${iso("Tehran'dan")} ziyaretçi · ${iso('PTXJ')}`);
  });

  it('fa + IR + unrecognized region falls back to the canonical (English) name — never guesses a translation', () => {
    const contact = { name: null, visitor_code: 'ZZZZ' };
    const out = contactDisplayName(contact, 'c1', fa, { region: 'Not A Real Province', country_code: 'IR' }, 'fa');
    expect(out).toBe(`بازدیدکننده از استان ${iso('Not A Real Province')} · ${iso('ZZZZ')}`);
  });

  it('non-Iran visitors are unaffected — still use city, exactly as before', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { city: 'Istanbul', region: 'Istanbul', country_code: 'TR' }, 'fa');
    expect(out).toBe(`بازدیدکننده از ${iso('Istanbul')} · ${iso('PTXJ')}`);
  });

  it('bidi isolation keeps the code exactly as generated — never visually or textually reordered', () => {
    const contact = { name: null, visitor_code: 'PTXJ' };
    const out = contactDisplayName(contact, 'c1', fa, { region: 'Tehran', country_code: 'IR' }, 'fa');
    // The raw substring must be the untouched code, not a reversed "JXTP".
    expect(out).toContain('PTXJ');
    expect(out).not.toContain('JXTP');
    // And it must be wrapped in a bidi isolate, not bare.
    expect(out).toContain(iso('PTXJ'));
  });

  it('changing the active UI locale never touches the underlying contact/geo data — presentation only', () => {
    const contact = { name: null, visitor_code: 'K7M4' };
    const geo = { region: 'Tehran', country_code: 'IR' };
    contactDisplayName(contact, 'c1', fa, geo, 'fa');
    contactDisplayName(contact, 'c1', en, geo, 'en');
    // The geo object passed in is never mutated by localization.
    expect(geo).toEqual({ region: 'Tehran', country_code: 'IR' });
  });

  it('a bare city string (legacy call sites, no country_code) still works as a city — no way to know it is Iran without a country_code', () => {
    const contact = { name: null, visitor_code: 'K7M4' };
    const out = contactDisplayName(contact, 'c1', fa, 'Tehran', 'fa');
    expect(out).toBe(`بازدیدکننده از ${iso('Tehran')} · ${iso('K7M4')}`);
  });
});

describe('isAnonymousContact', () => {
  it('true whenever there is no real human name, regardless of email/phone', () => {
    expect(isAnonymousContact({ name: 'Visitor' })).toBe(true);
    expect(isAnonymousContact({ name: null })).toBe(true);
    expect(isAnonymousContact(null)).toBe(true);
    // Email/phone are metadata, not identity — an email-only contact is
    // still "anonymous" for display purposes (Fix #3).
    expect(isAnonymousContact({ name: 'Visitor', email: 'a@b.com' })).toBe(true);
    expect(isAnonymousContact({ name: null, email: 'a@b.com' })).toBe(true);
  });
  it('false only once a real human name exists', () => {
    expect(isAnonymousContact({ name: 'Ali Ahmadi' })).toBe(false);
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

describe('getDisplayName — Contacts city precedence (Inbox/Contacts consistency)', () => {
  it('a live network-profile city (Inbox\'s canonical source) wins over a stale/absent metadata.city', () => {
    const contact = {
      id: 'c1', name: 'Visitor', visitor_code: 'K7M4',
      metadata: { city: 'Isfahan' }, // stale snapshot
    } as any;
    // Anonymous contact created via ensureVisitorContact never got a
    // metadata.city write at all until identityMerge runs — but a live
    // session (networkCity) is available regardless.
    expect(getDisplayName(contact, en, 'Tehran')).toBe(`Visitor from ${iso('Tehran')} · ${iso('K7M4')}`);
  });

  it('falls back to metadata.city when no network profile is available (never crashes, never blocks on the extra fetch)', () => {
    const contact = {
      id: 'c1', name: 'Visitor', visitor_code: 'K7M4',
      metadata: { city: 'Isfahan' },
    } as any;
    expect(getDisplayName(contact, en, undefined)).toBe(`Visitor from ${iso('Isfahan')} · ${iso('K7M4')}`);
    expect(getDisplayName(contact, en, null)).toBe(`Visitor from ${iso('Isfahan')} · ${iso('K7M4')}`);
  });

  it('falls back to no-city label when neither a network profile nor metadata.city exists', () => {
    const contact = { id: 'c1', name: 'Visitor', visitor_code: 'K7M4', metadata: {} } as any;
    expect(getDisplayName(contact, en, undefined)).toBe(`Visitor · ${iso('K7M4')}`);
  });

  it('a real name still wins over any city source', () => {
    const contact = { id: 'c1', name: 'Ali Ahmadi', metadata: { city: 'Isfahan' } } as any;
    expect(getDisplayName(contact, en, 'Tehran')).toBe('Ali Ahmadi');
  });

  it('an Iranian contact known only from metadata.city (no region cached) shows the no-place label — city is never substituted for region', () => {
    const contact = {
      id: 'c1', name: 'Visitor', visitor_code: 'K7M4',
      metadata: { city: 'Tehran', country_code: 'IR' }, // no metadata.region
    } as any;
    expect(getDisplayName(contact, fa, undefined, 'fa')).toBe(`بازدیدکننده · ${iso('K7M4')}`);
  });

  it('locale param localizes the province from a live network-profile geo object (with region + country_code)', () => {
    const contact = { id: 'c1', name: 'Visitor', visitor_code: 'K7M4', metadata: {} } as any;
    const geo = { city: 'Mashhad', region: 'Razavi Khorasan', country_code: 'IR' };
    expect(getDisplayName(contact, fa, geo, 'fa')).toBe(`بازدیدکننده از استان ${iso('خراسان رضوی')} · ${iso('K7M4')}`);
  });

  it('non-Iranian city from a live network-profile geo object never localizes, even in fa', () => {
    const contact = { id: 'c1', name: 'Visitor', visitor_code: 'K7M4', metadata: {} } as any;
    const geo = { city: 'Istanbul', country_code: 'TR' };
    expect(getDisplayName(contact, fa, geo, 'fa')).toBe(`بازدیدکننده از ${iso('Istanbul')} · ${iso('K7M4')}`);
  });
});
