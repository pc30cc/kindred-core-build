/**
 * The chat widget's "powered by" credit in `default` (and `intl`, the same
 * renderer): a link only for an http(s) address, as t1 and t2 draw it. The
 * address is the platform's setting (Super Admin); anything else (a
 * `javascript:` or relative address) draws the credit as plain text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

function footer(url: unknown, id: 'default' | 'intl' = 'default'): HTMLElement {
  new Function(read('public/widget/presentation-registry.js')).call(window);
  new Function(read('public/widget/presentation-default.js')).call(window);
  const reg = (window as unknown as { __gs_presentation_registry: { resolve: (id: string) => { globalKey: string } } }).__gs_presentation_registry;
  const mod = (window as unknown as Record<string, { create: (env: unknown) => Record<string, (...a: unknown[]) => string> }>)[reg.resolve(id).globalKey];
  const r = mod.create({
    t: (k: string) => k,
    escapeHtml: (v: unknown) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string),
    config: { attachments: { enabled: false }, composer: {}, readReceipts: { enabled: true }, poweredBy: { text: 'Powered by', brand: 'Platform', url }, showPoweredBy: true },
    locale: 'en',
    primaryColor: '#3B82F6',
  });
  const html = r.homeHtml({
    rtl: false, isOnline: true, teamMembers: [], categories: [], articles: [], conversations: [],
    kbEnabled: false, chatEnabled: true, primaryColor: '#3B82F6', welcomeMessage: 'Hi', smartSurface: null,
  });
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.querySelector('.wy-footer') as HTMLElement;
}

describe('the powered-by credit in default', () => {
  it.each(['https://platform.test/', 'http://platform.test/', 'HTTPS://platform.test/x'])('%j is a link', (url) => {
    for (const id of ['default', 'intl'] as const) {
      const a = footer(url, id).querySelector('a.wy-powered');
      expect(a, id).not.toBeNull();
      expect(a!.getAttribute('href')).toBe(url);
      expect(a!.getAttribute('rel')).toBe('noopener nofollow');
    }
  });

  it.each(['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', '/about', '//platform.test', '', null, 5])('%j is plain text', (url) => {
    const f = footer(url);
    expect(f.querySelector('a')).toBeNull();
    expect(f.querySelector('span.wy-powered')).not.toBeNull();
  });
});
