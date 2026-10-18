/**
 * Template variables are filled with their values as they are.
 *
 * `interpolate` used to hand each value to String.replace as a replacement
 * string, so `$&` (the match), `$'` / `` $` `` (the text after / before it)
 * and `$$` in a value were expanded: a visitor writing "$& off" in a chat
 * would have received the template's own placeholder, or a copy of the rest
 * of the mail, in their transcript. It also replaced key after key over the
 * whole result, so a placeholder typed inside one value was filled by a later
 * key (and a key was compiled into a regular expression). The real-database
 * proof through sendEmail is widgetChatFeatures276.pg.test.ts (T8).
 */
import { describe, expect, it } from 'vitest';
import { interpolate } from '../../../server/services/email/index';

describe('email interpolate', () => {
  it('inserts replacement patterns in a value literally', () => {
    for (const value of ['$&', "$'", '$`', '$1', '$$', '$<name>', 'a $& b $\' c $` d $$ e']) {
      expect(interpolate('<p>{v}</p>', { v: value }), value).toBe(`<p>${value}</p>`);
      expect(interpolate('<p>{{v}}</p>', { v: value }), value).toBe(`<p>${value}</p>`);
    }
  });

  it('fills every occurrence, both {key} and {{key}}', () => {
    expect(interpolate('{a} {{a}} {a}', { a: '$&' })).toBe('$& $& $&');
  });

  it('leaves an unknown placeholder alone', () => {
    expect(interpolate('{a} {b}', { a: 'x' })).toBe('x {b}');
  });

  it('never reads an inserted value again: a placeholder typed inside it stays as typed, whichever key comes first', () => {
    expect(interpolate('{brand}: {name}', { brand: 'Acme', name: '{brand} $1' })).toBe('Acme: {brand} $1');
    expect(interpolate('{name}: {brand}', { name: '{brand} {{brand}}', brand: 'Acme' })).toBe('{brand} {{brand}}: Acme');
  });

  it('keeps a visitor\'s "{transcript_text}" in the HTML transcript from pulling the unescaped text transcript in', () => {
    const html = '<table>{transcript}</table>';
    const data = {
      // The HTML rows escape the visitor's text, braces and all;
      transcript: '<tr><td>&lt;img src=x onerror=alert(1)&gt;</td></tr><tr><td>{transcript_text}</td></tr>',
      // the text transcript is the same messages, unescaped.
      transcript_text: '<img src=x onerror=alert(1)>\n{transcript_text}',
    };
    const out = interpolate(html, data);
    expect(out).toBe(`<table>${data.transcript}</table>`);
    expect(out).not.toContain('<img');
  });

  it('takes a key by its own name only, and takes no key as a pattern', () => {
    expect(interpolate('{constructor} {toString} {__proto__}', {})).toBe('{constructor} {toString} {__proto__}');
    // Keys come from the caller (POST /api/email/send-channel takes any): none
    // is compiled into a regular expression.
    expect(interpolate('{a} {b} {(}', { '.*': 'x', '(': 'paren' })).toBe('{a} {b} paren');
  });

  it('leaves braces that are not a placeholder alone (CSS in a template)', () => {
    expect(interpolate('<style>.b { color: red }</style>{year}', { year: '2026' })).toBe('<style>.b { color: red }</style>2026');
  });
});
