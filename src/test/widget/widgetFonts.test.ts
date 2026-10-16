/**
 * How the widgets get their typefaces (public/widget/presentation-default-fonts.css):
 * one small stylesheet of @font-face rules; each face its own build-hashed
 * woff2 file that the browser downloads only when text on screen needs one of
 * its characters (unicode-range); the template's prepare() warming only what
 * the locale's first paint draws with; and the loader handing prepare() that
 * context while loading the registry and the renderer side by side.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rewriteWidgetFontUrls, widgetFontNames } from '../../../scripts/build/widgetFonts.mjs';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const FONTS_CSS = read('public/widget/presentation-default-fonts.css');

interface Face { family: string; weight: string; src: string; display: string; range: Array<[number, number]> }
function faces(css: string): Face[] {
  return (css.match(/@font-face\s*\{[^}]*\}/g) || []).map((rule) => {
    const get = (prop: string) => (rule.match(new RegExp(`${prop}:\\s*([^;}]+)`)) || [])[1]?.trim() ?? '';
    const range = get('unicode-range').split(',').map((part) => {
      const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
      return [parseInt(a, 16), parseInt(b ?? a, 16)] as [number, number];
    });
    return {
      family: get('font-family').replace(/['"]/g, ''),
      weight: get('font-weight'),
      src: (rule.match(/url\(([^)]+)\)/) || [])[1] ?? '',
      display: get('font-display'),
      range,
    };
  });
}
const covers = (f: Face, cp: number) => f.range.some(([a, b]) => cp >= a && cp <= b);

describe('the font stylesheet', () => {
  const all = faces(FONTS_CSS);
  const inter = all.filter((f) => f.family === 'InterWY');

  it('holds no font bytes: every face is a file under fonts/, swapped in, with a unicode-range', () => {
    expect(FONTS_CSS).not.toMatch(/data:|base64,/);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const f of all) {
      expect(f.src, f.src).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/);
      expect(f.display).toBe('swap');
      expect(f.range.length, `${f.src} has no unicode-range`).toBeGreaterThan(0);
      for (const [a, b] of f.range) expect(Number.isNaN(a) || Number.isNaN(b) || a > b, `${f.src}: bad range`).toBe(false);
    }
  });

  it('names only files that exist, and every shipped font file is named (no dead bytes)', () => {
    const named = new Set(all.map((f) => f.src.slice('fonts/'.length)));
    for (const n of named) expect(existsSync(`public/widget/fonts/${n}`), n).toBe(true);
    const sheets = readdirSync('public/widget').filter((f) => /^presentation-[a-z0-9-]+-fonts\.css$/.test(f));
    const used = new Set(sheets.flatMap((s) => widgetFontNames(read(`public/widget/${s}`))));
    for (const f of readdirSync('public/widget/fonts')) expect(used.has(f), `${f} is shipped but no stylesheet names it`).toBe(true);
  });

  it('ships IRANSans as the licensed bytes, unmodified', () => {
    for (const w of [400, 500, 700]) {
      const widget = readFileSync(`public/widget/fonts/iransans-${w}.woff2`);
      expect(widget.equals(readFileSync(`src/assets/fonts/iransans-${w}.woff2`)), `iransans-${w}`).toBe(true);
    }
  });

  it('keeps emoji out of every range, so emoji-only text downloads nothing', () => {
    for (const cp of [0x1f44b, 0x1f600, 0x2764, 0x2705, 0x2b50]) {
      for (const f of all) expect(covers(f, cp), `${f.src} claims U+${cp.toString(16)}`).toBe(false);
    }
  });

  it('splits Inter into disjoint ranges, the Latin file last', () => {
    for (let i = 0; i < inter.length; i++) {
      for (let j = i + 1; j < inter.length; j++) {
        for (const [a, b] of inter[i].range) {
          for (const [c, d] of inter[j].range) expect(a <= d && c <= b, `${inter[i].src} / ${inter[j].src} overlap`).toBe(false);
        }
      }
    }
    expect(inter[inter.length - 1].src).toBe('fonts/inter-500-latin.woff2');
  });

  it('draws English and Turkish UI text from the one Latin file', () => {
    const latin = inter.find((f) => f.src === 'fonts/inter-500-latin.woff2')!;
    const text = 'Hello, how can we help? Bağlanıyor — İyi günler, Şükrü! Çok güzel… ÖÜ öü ’·×→↗●✓ ₺€';
    for (const ch of text) expect(covers(latin, ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)} ${ch}`).toBe(true);
  });

  it('leaves Persian to IRANSans: no Inter face claims Arabic script', () => {
    for (const f of inter) for (const cp of [0x0633, 0x06cc, 0x06f1, 0xfeb3, 0x200c]) expect(covers(f, cp)).toBe(false);
    const iran = all.filter((f) => f.family === 'IRANSans');
    for (const f of iran) for (const cp of [0x0633, 0x06cc, 0x06f1, 0x200c, 0x0041]) expect(covers(f, cp)).toBe(true);
  });
});

describe('the build rewrites font urls to hashed files', () => {
  it('rewrites every named font, and a missing one fails', () => {
    const hashed = rewriteWidgetFontUrls(FONTS_CSS, (n: string) => `fonts/${n.replace(/\.woff2$/, '')}.0123abcd.woff2`);
    expect(hashed).not.toMatch(/url\(fonts\/[a-z0-9-]+\.woff2\)/);
    expect(hashed.match(/url\(fonts\/[a-z0-9-]+\.0123abcd\.woff2\)/g)!.length).toBe(faces(FONTS_CSS).length);
    expect(() => rewriteWidgetFontUrls('a{src:url(fonts/nope.woff2)}', () => { throw new Error('missing'); })).toThrow('missing');
  });
});

describe('prepare(): only the faces the first paint draws with', () => {
  let calls: string[];
  let prepare: (ctx?: Record<string, unknown>) => Promise<void>;
  beforeEach(() => {
    calls = [];
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn((font: string) => { calls.push(font); return Promise.resolve([]); }) },
    });
    new Function(read('public/widget/presentation-default.js')).call(window);
    prepare = (window as unknown as { __gs_presentation_default: { prepare: typeof prepare } }).__gs_presentation_default.prepare;
  });
  afterEach(() => { delete (document as unknown as Record<string, unknown>).fonts; });

  it.each([
    ['fa / default', { locale: 'fa', templateId: 'default' }, ['400 16px IRANSans', '500 16px IRANSans', '600 16px IRANSans']],
    ['en / default', { locale: 'en', templateId: 'default' }, ['500 16px InterWY']],
    ['tr / intl', { locale: 'tr', templateId: 'intl' }, ['500 16px InterWY']],
    ['fa / intl (Inter first in every direction)', { locale: 'fa', templateId: 'intl' }, ['400 16px IRANSans', '500 16px IRANSans', '600 16px IRANSans', '500 16px InterWY']],
    ['no context (an older loader): the Persian set', undefined, ['400 16px IRANSans', '500 16px IRANSans', '600 16px IRANSans']],
  ])('%s', async (_name, ctx, expected) => {
    await prepare(ctx as Record<string, unknown> | undefined);
    expect(calls).toEqual(expected);
  });
});

describe('the loader: registry and renderer side by side, prepare() with the locale', () => {
  const held: HTMLElement[] = [];
  beforeEach(() => {
    document.body.innerHTML = '';
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
  });
  afterEach(() => { vi.restoreAllMocks(); held.length = 0; });

  it('requests both template scripts before either has loaded, and passes { locale, templateId }', async () => {
    const w = window as unknown as Record<string, unknown>;
    w.__gs_id = 'ws-test';
    w.__gs_api_base = 'https://api.test';
    const auto = (node: HTMLElement) => {
      const tag = node.getAttribute && node.getAttribute('data-gs-template');
      if (tag === 'registry' || tag === 'renderer') { held.push(node); return; } // fired by hand below
      if (node.tagName === 'SCRIPT' || node.tagName === 'LINK') {
        if (node.getAttribute('data-gs-runtime-call') === 'true') return;
        setTimeout(() => { const n = node as unknown as { onload?: () => void }; if (typeof n.onload === 'function') n.onload(); }, 0);
      }
    };
    const patch = (target: Node) => {
      const real = target.appendChild.bind(target);
      vi.spyOn(target, 'appendChild').mockImplementation(((node: HTMLElement) => { auto(node); return real(node); }) as never);
    };
    patch(document.head);
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), headers: { get: () => null } });
    w.fetch = vi.fn((url: string) => String(url).includes('/api/widget/bootstrap')
      ? json({ session_token: 't', workspace_id: 'ws-test', availability: { state: 'online' } })
      : String(url).includes('/api/widget/config')
        ? json({
          enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'en',
          styleUrl: 'https://cdn.test/runtime.css', runtimeUrl: 'https://cdn.test/runtime.js',
          presentationRegistryUrl: 'https://cdn.test/presentation-registry.js',
          presentationUrl: 'https://cdn.test/presentation-default.js', presentationStyleUrl: 'https://cdn.test/presentation.css',
        })
        : json({}));
    new Function(read('public/widget/loader.js')).call(window);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    patch(document.querySelector('gs-widget')!.shadowRoot!);
    const prepare = vi.fn(() => Promise.resolve());
    const init = vi.fn(() => ({ open() {}, close() {}, toggle() {}, isOpen: () => true }));
    w.__gs_runtime = { init };

    (document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const kinds = held.map((n) => n.getAttribute('data-gs-template'));
    expect(kinds).toContain('registry');
    expect(kinds).toContain('renderer'); // requested before the registry loaded

    // The renderer arrives first, then the registry.
    w.__gs_presentation_default = { prepare, create: () => ({}) };
    (held.find((n) => n.getAttribute('data-gs-template') === 'renderer') as unknown as { onload: () => void }).onload();
    expect(prepare).not.toHaveBeenCalled();
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_default' }) };
    (held.find((n) => n.getAttribute('data-gs-template') === 'registry') as unknown as { onload: () => void }).onload();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({ locale: 'en', templateId: 'default' });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    expect(init).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
