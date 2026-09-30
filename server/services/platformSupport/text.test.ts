import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_LENGTH,
  normalizeBody,
  normalizeClientMessageId,
  normalizeSubject,
  SlidingWindowLimiter,
  subjectFromBody,
  templateValue,
} from './text.js';
import { normalizeEmails, normalizeSettings } from './settings.js';
import { emailLocale } from './emails.js';

describe('what an operator may send', () => {
  it('trims a message and refuses an empty or oversized one', () => {
    expect(normalizeBody('  hello\r\nthere  ')).toBe('hello\nthere');
    expect(normalizeBody('   ')).toBeNull();
    expect(normalizeBody(42)).toBeNull();
    expect(normalizeBody('x'.repeat(MAX_BODY_LENGTH + 1))).toBeNull();
  });

  it('keeps a subject on one line', () => {
    expect(normalizeSubject(' Invoice \n question ')).toBe('Invoice question');
    expect(normalizeSubject('')).toBeNull();
    expect(normalizeSubject('x'.repeat(201))).toBeNull();
  });

  it('accepts only an opaque client id', () => {
    expect(normalizeClientMessageId('3f2b9c1e-0000-4000-8000-000000000001')).toBe('3f2b9c1e-0000-4000-8000-000000000001');
    expect(normalizeClientMessageId('short')).toBeNull();
    expect(normalizeClientMessageId('has space in it')).toBeNull();
  });

  it('makes a conversation subject of the first line', () => {
    expect(subjectFromBody('\nFirst line\nsecond')).toBe('First line');
    expect(subjectFromBody('x'.repeat(100))).toHaveLength(80);
  });
});

describe('a mail value', () => {
  it('is escaped as HTML and safe inside String.replace', () => {
    expect(templateValue('<b>"hi"</b> & \'you\'')).toBe('&lt;b&gt;&quot;hi&quot;&lt;/b&gt; &amp; &#39;you&#39;');
    // `replace` keeps each `$` literal instead of reading a back-reference.
    expect('{v}'.replace(/\{v\}/g, templateValue('costs $1 and $&'))).toBe('costs $1 and $&amp;');
  });
});

describe('the rate limit', () => {
  it('allows the limit in a window, then refuses until the window moves on', () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.take('u', 0)).toBe(true);
    expect(limiter.take('u', 10)).toBe(true);
    expect(limiter.take('u', 20)).toBe(false);
    expect(limiter.take('other', 20)).toBe(true);
    expect(limiter.take('u', 1011)).toBe(true);
  });
});

describe('settings', () => {
  it('reads a missing row as off', () => {
    expect(normalizeSettings(null)).toMatchObject({ enabled: false, workspaceId: null, ticketsEnabled: true });
  });

  it('keeps only valid, unique, lower-cased emails', () => {
    expect(normalizeEmails([' Ops@Example.com', 'ops@example.com', 'not-an-email', 7, 'b@x.io'])).toEqual([
      'ops@example.com',
      'b@x.io',
    ]);
  });

  it('mails in the three languages the templates exist in', () => {
    expect(emailLocale('fa-IR')).toBe('fa');
    expect(emailLocale('TR')).toBe('tr');
    expect(emailLocale('de', 'fa')).toBe('fa');
    expect(emailLocale(null)).toBe('en');
  });
});
