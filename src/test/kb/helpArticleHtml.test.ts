/**
 * The SPA help center's article HTML (src/lib/sanitizeKbHtml.ts: DOMPurify
 * over shared/kbArticleHtml.ts). An article is its workspace's writing, so
 * what slipped through the old regex must come out inert, and what the
 * editor writes must come out as it went in.
 */
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { sanitizeKbHtml } from '@/lib/sanitizeKbHtml';
import { ARTICLES, XSS_PAYLOADS, executableParts, oldRegexSanitize } from './kbArticleHtmlFixtures';

describe('the SPA help center sanitizes an article with DOMPurify', () => {
  it('the two payloads the old regex let through come out inert', () => {
    expect(executableParts(oldRegexSanitize('<svg/onload=alert(1)>'))).not.toEqual([]);
    expect(oldRegexSanitize('<scr<script></script>ipt>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(sanitizeKbHtml('<svg/onload=alert(1)>')).toBe('');
    expect(sanitizeKbHtml('<scr<script></script>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)');
  });

  it('every payload is runnable as written or once the old regex is through with it (the check sees it)', () => {
    for (const [name, payload] of XSS_PAYLOADS) {
      expect([...executableParts(payload), ...executableParts(oldRegexSanitize(payload))], name).not.toEqual([]);
    }
  });

  it.each(XSS_PAYLOADS)('%s comes out inert', (_name, payload) => {
    expect(executableParts(sanitizeKbHtml(payload))).toEqual([]);
  });

  it('a handler goes and the image stays; a link or an image with another scheme loses only its URL', () => {
    expect(sanitizeKbHtml('<img src=x onerror=alert(1)>')).toBe('<img src="x">');
    expect(sanitizeKbHtml('<a href="jav&#x61;script:alert(1)">Open</a>')).toBe('<a rel="noopener noreferrer">Open</a>');
    expect(sanitizeKbHtml('<img src="data:image/png;base64,AAAA" alt="A">')).toBe('<img alt="A">');
    expect(sanitizeKbHtml('<p style="color:red" class="fixed" id="root">x</p>')).toBe('<p>x</p>');
  });

  it.each(Object.entries(ARTICLES))('%s survives unchanged', (_name, html) => {
    expect(sanitizeKbHtml(html)).toBe(html);
    expect(executableParts(html)).toEqual([]);
  });

  it('a link always has rel="noopener noreferrer", keeps nofollow, and a target only of _blank', () => {
    expect(sanitizeKbHtml('<a href="https://example.com" target="_top" rel="opener">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer">x</a>');
    // The AI builder's links (server/services/ai-kb/htmlNormalize.ts).
    expect(sanitizeKbHtml('<a href="https://example.com" rel="nofollow noopener" target="_blank">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">x</a>');
  });

  it('an attribute stays on its own tags only', () => {
    expect(sanitizeKbHtml('<p href="https://example.com" src="/a.png" colspan="2">x</p>')).toBe('<p>x</p>');
  });

  it('no content is an empty string', () => {
    expect(sanitizeKbHtml('')).toBe('');
    expect(sanitizeKbHtml(null)).toBe('');
    expect(sanitizeKbHtml(undefined)).toBe('');
  });

  it('its hooks stay on its own DOMPurify (the email reader uses the default one)', () => {
    sanitizeKbHtml('<a href="https://example.com">x</a>');
    expect(DOMPurify.sanitize('<a href="https://example.com">x</a>')).toBe('<a href="https://example.com">x</a>');
  });
});
