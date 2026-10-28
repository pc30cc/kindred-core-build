/**
 * The server-rendered help center's article HTML (GET /help/:locale/a/:slug,
 * server/routes/kb.ts; server/services/knowledge-base/articleHtml.ts:
 * sanitize-html over shared/kbArticleHtml.ts). An article is its
 * workspace's writing, so what slipped through the old regex must come out
 * inert where a browser reads the page, and what the editor writes must come
 * out as it went in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeKbArticleHtml } from '../../../server/services/knowledge-base/articleHtml';
import { ARTICLES, XSS_PAYLOADS, executableParts, oldRegexSanitize, xhtmlVoids } from './kbArticleHtmlFixtures';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('the server-rendered help center sanitizes an article with sanitize-html', () => {
  it('the two payloads the old regex let through come out inert', () => {
    expect(executableParts(oldRegexSanitize('<svg/onload=alert(1)>'))).not.toEqual([]);
    expect(sanitizeKbArticleHtml('<svg/onload=alert(1)>')).toBe('');
    expect(sanitizeKbArticleHtml('<scr<script></script>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)');
  });

  it.each(XSS_PAYLOADS)('%s comes out inert', (_name, payload) => {
    expect(executableParts(sanitizeKbArticleHtml(payload))).toEqual([]);
  });

  it('a handler goes and the image stays; a link or an image with another scheme loses only its URL', () => {
    expect(sanitizeKbArticleHtml('<img src=x onerror=alert(1)>')).toBe('<img src="x" />');
    expect(sanitizeKbArticleHtml('<a href="jav&#x61;script:alert(1)">Open</a>')).toBe('<a rel="noopener noreferrer">Open</a>');
    expect(sanitizeKbArticleHtml('<img src="data:image/png;base64,AAAA" alt="A">')).toBe('<img alt="A" />');
    expect(sanitizeKbArticleHtml('<p style="color:red" class="fixed" id="root">x</p>')).toBe('<p>x</p>');
  });

  it('nothing the article holds closes the page\'s <article>', () => {
    expect(sanitizeKbArticleHtml('<div><p>Unclosed')).toBe('<div><p>Unclosed</p></div>');
    expect(sanitizeKbArticleHtml('</article></div><p>x</p>')).toBe('<p>x</p>');
  });

  it.each(Object.entries(ARTICLES))('%s survives unchanged', (_name, html) => {
    expect(sanitizeKbArticleHtml(html)).toBe(xhtmlVoids(html));
  });

  it('the editor\'s <br> and <hr> come out self-closed, the same elements', () => {
    expect(sanitizeKbArticleHtml('<p>a<br>b</p><hr>')).toBe('<p>a<br />b</p><hr />');
  });

  it('a link always has rel="noopener noreferrer", keeps nofollow, and a target only of _blank', () => {
    expect(sanitizeKbArticleHtml('<a href="https://example.com" target="_top" rel="opener">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer">x</a>');
    // The AI builder's links (server/services/ai-kb/htmlNormalize.ts).
    expect(sanitizeKbArticleHtml('<a href="https://example.com" rel="nofollow noopener" target="_blank">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">x</a>');
  });

  it('an attribute stays on its own tags only', () => {
    expect(sanitizeKbArticleHtml('<p href="https://example.com" src="/a.png" colspan="2">x</p>')).toBe('<p>x</p>');
  });

  it('no content is an empty string', () => {
    expect(sanitizeKbArticleHtml('')).toBe('');
    expect(sanitizeKbArticleHtml(null)).toBe('');
    expect(sanitizeKbArticleHtml(undefined)).toBe('');
  });

  it('both help centers draw the article through the shared allow-list, no regex', () => {
    const ssr = read('server/routes/kb.ts');
    expect(ssr).toContain('<article>${sanitizeKbArticleHtml(article.content)}</article>');
    expect(ssr).not.toMatch(/function sanitizeArticleHtml|<script\\b/);
    const spa = read('src/pages/public/kb/HelpArticlePage.tsx');
    expect(spa).toContain('dangerouslySetInnerHTML={{ __html: sanitizeKbHtml(article.content) }}');
    expect(spa).not.toMatch(/function sanitize\(/);
    for (const file of ['server/services/knowledge-base/articleHtml.ts', 'src/lib/sanitizeKbHtml.ts']) {
      expect(read(file)).toContain('shared/kbArticleHtml');
    }
  });
});
