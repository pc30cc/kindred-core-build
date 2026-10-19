/**
 * The name a notification gives a customer is the name the operator's app
 * gives them in its list — `Format.contactName` on Android and iOS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { contactDisplayName, contactOwnName } from '../../../server/services/push/contactName';

describe('contactDisplayName', () => {
  it('a name first', () => {
    expect(contactDisplayName({ name: 'Sara', email: 'sara@example.com', visitor_code: '4ZTK' }, 'fa')).toBe('Sara');
  });

  it('then the email before the @', () => {
    expect(contactDisplayName({ name: '  ', email: 'ali@example.com', visitor_code: '4ZTK' }, 'en')).toBe('ali');
    expect(contactDisplayName({ email: '@odd' }, 'en')).toBe('@odd');
  });

  it('then "Visitor" and the code, in the operator\'s language', () => {
    expect(contactDisplayName({ visitor_code: '4ZTK' }, 'fa')).toBe('بازدیدکننده 4ZTK');
    expect(contactDisplayName({ visitor_code: '4ZTK' }, 'en')).toBe('Visitor 4ZTK');
    expect(contactDisplayName({ visitor_code: '4ZTK' }, 'tr-TR')).toBe('Ziyaretçi 4ZTK');
  });

  it('and "Visitor" alone when there is nothing at all', () => {
    expect(contactDisplayName(null, 'fa')).toBe('بازدیدکننده');
    expect(contactDisplayName({}, 'de')).toBe('Visitor');
  });

  it('the literal "Visitor" older rows carry as a name is no name (anonymousContact.ts ANON_CONTACT_NAME)', () => {
    expect(contactDisplayName({ name: 'Visitor', visitor_code: '4ZTK' }, 'fa')).toBe('بازدیدکننده 4ZTK');
    expect(contactDisplayName({ name: ' visitor ', email: 'ali@example.com' }, 'fa')).toBe('ali');
    expect(contactDisplayName({ name: 'Visitor' }, 'tr')).toBe('Ziyaretçi');
    expect(contactOwnName({ name: 'Visitor', visitor_code: '4ZTK' })).toBeNull();
    // A real name that merely contains the word stays.
    expect(contactDisplayName({ name: 'Visitor Center' }, 'fa')).toBe('Visitor Center');
    // The apps' own list says the same (their next release; not built here).
    expect(readFileSync('ios/Webyar/Sources/DesignSystem/Formatting.swift', 'utf8')).toContain('trimmed.lowercased() != "visitor"');
    expect(readFileSync('android/app/src/main/kotlin/com/platform/app/i18n/Format.kt', 'utf8')).toContain('!name.trim().equals("visitor", ignoreCase = true)');
  });

  it('the part that is the same in every language, or nothing for an anonymous visitor', () => {
    expect(contactOwnName({ name: 'Sara' })).toBe('Sara');
    expect(contactOwnName({ email: 'ali@example.com' })).toBe('ali');
    expect(contactOwnName({ visitor_code: '4ZTK' })).toBeNull();
  });
});
