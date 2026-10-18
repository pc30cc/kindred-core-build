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
    // Besides the faces, only an OFL face's licence text, for a family a stylesheet names.
    const families = new Set(all.map((f) => f.family));
    for (const f of readdirSync('public/widget/fonts')) {
      const licence = /^OFL-([A-Za-z]+)\.txt$/.exec(f);
      if (licence) expect(families.has(licence[1]), `${f}: no stylesheet names ${licence[1]}`).toBe(true);
      else expect(used.has(f), `${f} is shipped but no stylesheet names it`).toBe(true);
    }
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

  // The International skins' Latin face (t1-intl, t2-intl).
  const figtree = all.filter((f) => f.family === 'Figtree');

  it('declares Figtree in the weights the International skins use, two disjoint files per weight, the Latin one last', () => {
    expect([...new Set(figtree.map((f) => f.weight))]).toEqual(['400', '500', '600', '700', '800']);
    for (const w of ['400', '500', '600', '700', '800']) {
      const faces = figtree.filter((f) => f.weight === w);
      expect(faces.map((f) => f.src), w).toEqual(['fonts/figtree-tr.woff2', 'fonts/figtree-latin.woff2']);
      for (const [a, b] of faces[0].range) {
        for (const [c, d] of faces[1].range) expect(a <= d && c <= b, `${w}: the Figtree files overlap`).toBe(false);
      }
    }
  });

  it('draws English from the Latin Figtree file only, and Turkish from the two', () => {
    const latin = figtree.find((f) => f.src === 'fonts/figtree-latin.woff2')!;
    const tr = figtree.find((f) => f.src === 'fonts/figtree-tr.woff2')!;
    for (const ch of 'Hello, how can we help you today? “Quotes” – … € ™ · ÇÖÜçöüı') expect(covers(latin, ch.codePointAt(0)!), ch).toBe(true);
    for (const ch of 'ĞğŞşİ') {
      expect(covers(tr, ch.codePointAt(0)!), ch).toBe(true);
      expect(covers(latin, ch.codePointAt(0)!), ch).toBe(false);
    }
    // No Arabic script, no zero-width joiners: Persian text never asks for it.
    for (const f of figtree) for (const cp of [0x0633, 0x06cc, 0x06f1, 0x200c, 0x200d]) expect(covers(f, cp), `${f.src} U+${cp.toString(16)}`).toBe(false);
  });

  it('keeps Figtree to the International skins: no other stylesheet, no other renderer names it', () => {
    const named = readdirSync('public/widget').filter((f) => /\.(css|js)$/.test(f) && !/-fonts\.css$/.test(f) && read(`public/widget/${f}`).includes('Figtree'));
    expect(named.sort()).toEqual(['presentation-t1-intl.css', 'presentation-t1.js', 'presentation-t2-intl.css', 'presentation-t2.js']);
    // The licence travels with the files.
    expect(read('public/widget/fonts/OFL-Figtree.txt')).toMatch(/Copyright 2022 The Figtree Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
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

describe('prepare() of t1 and t2: Inter for their own ids, Figtree for the International skins over them', () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: vi.fn((font: string) => { calls.push(font); return Promise.resolve([]); }) },
    });
  });
  afterEach(() => { delete (document as unknown as Record<string, unknown>).fonts; });
  const PERSIAN = ['400 16px IRANSans', '500 16px IRANSans', '600 16px IRANSans'];

  for (const base of ['t1', 't2']) {
    it.each([
      ['en', base, ['500 16px InterWY']],
      ['tr', base, ['500 16px InterWY']],
      ['en', `${base}-intl`, ['500 16px Figtree']],
      ['tr', `${base}-intl`, ['500 16px Figtree']],
      ['fa', `${base}-intl`, PERSIAN],
      ['fa', base, PERSIAN],
    ])(`${base}: %s / %s`, async (locale, templateId, expected) => {
      new Function(read(`public/widget/presentation-${base}.js`)).call(window);
      const mod = (window as unknown as Record<string, { prepare: (c?: unknown) => Promise<void> }>)[`__gs_presentation_${base}`];
      await mod.prepare({ locale, templateId });
      expect(calls).toEqual(expected);
    });
  }
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
    await Promise.resolve(); await Promise.resolve(); // past the (empty) font-stylesheet gate
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({ locale: 'en', templateId: 'default' });
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    expect(init).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  /** Boots the loader with a font stylesheet in config and opens the panel; the
   *  registry, the renderer and the font stylesheet are held for the test to fire. */
  async function openWithFonts() {
    document.getElementById('gs-presentation-fonts')?.remove(); // a page that has none yet
    const w = window as unknown as Record<string, unknown>;
    w.__gs_id = 'ws-test';
    w.__gs_api_base = 'https://api.test';
    const auto = (node: HTMLElement) => {
      const tag = node.getAttribute && node.getAttribute('data-gs-template');
      if (tag === 'registry' || tag === 'renderer' || node.id === 'gs-presentation-fonts') { held.push(node); return; }
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
          enabled: true, features: { chat: true }, primaryColor: '#3B82F6', templateId: 'default', locale: 'fa',
          styleUrl: 'https://cdn.test/runtime.css', runtimeUrl: 'https://cdn.test/runtime.js',
          presentationRegistryUrl: 'https://cdn.test/presentation-registry.js',
          presentationUrl: 'https://cdn.test/presentation-default.js', presentationStyleUrl: 'https://cdn.test/presentation.css',
          presentationFontsUrl: 'https://cdn.test/presentation-default-fonts.css',
        })
        : json({}));
    new Function(read('public/widget/loader.js')).call(window);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    patch(document.querySelector('gs-widget')!.shadowRoot!);
    const prepare = vi.fn(() => Promise.resolve());
    w.__gs_runtime = { init: vi.fn(() => ({ open() {}, close() {}, toggle() {}, isOpen: () => true })) };
    (document.querySelector('gs-widget')!.shadowRoot!.querySelector('.launcher') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    w.__gs_presentation_default = { prepare, create: () => ({}) };
    w.__gs_presentation_registry = { resolve: () => ({ globalKey: '__gs_presentation_default' }) };
    for (const tag of ['renderer', 'registry']) {
      (held.find((n) => n.getAttribute('data-gs-template') === tag) as unknown as { onload: () => void }).onload();
    }
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    const fontsLink = held.find((n) => n.id === 'gs-presentation-fonts')!;
    expect(fontsLink, 'the font stylesheet is injected at document level').toBeTruthy();
    return { prepare, fontsLink };
  }

  it('runs prepare() only once the font stylesheet has loaded, so its faces are declared', async () => {
    const { prepare, fontsLink } = await openWithFonts();
    expect(prepare).not.toHaveBeenCalled();
    fontsLink.dispatchEvent(new Event('load'));
    await Promise.resolve(); await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({ locale: 'fa', templateId: 'default' });
  });

  it('a font stylesheet that fails or never arrives costs only the typeface: prepare() still runs (error, or 800 ms)', async () => {
    const failed = await openWithFonts();
    failed.fontsLink.dispatchEvent(new Event('error'));
    await Promise.resolve(); await Promise.resolve();
    expect(failed.prepare).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks(); held.length = 0;
    document.head.innerHTML = ''; document.body.innerHTML = '';
    for (const key of Object.keys(window)) if (key.indexOf('__gs') === 0) delete (window as unknown as Record<string, unknown>)[key];
    const hung = await openWithFonts();
    expect(hung.prepare).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 850));
    expect(hung.prepare).toHaveBeenCalledTimes(1);
  });
});
