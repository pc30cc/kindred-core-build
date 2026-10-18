/**
 * Template variables are filled with their values as they are.
 *
 * `interpolate` used to hand each value to String.replace as a replacement
 * string, so `$&` (the match), `$'` / `` $` `` (the text after / before it)
 * and `$$` in a value were expanded: a visitor writing "$& off" in a chat
 * would have received the template's own placeholder, or a copy of the rest
 * of the mail, in their transcript. The real-database proof through
 * sendEmail is widgetChatFeatures276.pg.test.ts (T8).
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

  it('keeps today\'s order: a placeholder inside an earlier key\'s value is filled by a later key', () => {
    // brand, year and support_email come first, the caller's data after
    // them (renderEditionTemplate), so a caller value is never re-read for them.
    expect(interpolate('{brand}: {name}', { brand: 'Acme', name: '{brand} $1' })).toBe('Acme: {brand} $1');
  });
});
