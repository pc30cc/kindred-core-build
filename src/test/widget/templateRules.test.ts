/**
 * The widget template rules (docs/operations/WIDGET_TEMPLATE_RULES.md), run
 * against EVERY template the descriptors list: the chat widget's
 * CHAT_WIDGET_TEMPLATES and the call widget's CALL_WIDGET_TEMPLATES
 * (shared/widgetTemplates.ts). A new template is checked the moment it is
 * described there; nothing in this file names a template.
 *
 * What the rules keep out, each one a problem the widget once had:
 *   - font bytes inside a stylesheet (the 231 KB base64 fonts stylesheet),
 *     faces fetched whether or not the text needs them, the same font file
 *     shipped twice, font files nobody names;
 *   - faces declared inside a shadow-root stylesheet (never fetched in
 *     Chromium; elsewhere they pulled unhashed, uncached files);
 *   - a template that reaches the network, storage or another host;
 *   - templates, launchers and loaders that grow without anyone noticing:
 *     every shipped file has a size budget, measured as production ships it
 *     (minified by scripts/build/widgetBrand.mjs, gzip level 5 like nginx).
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { CALL_WIDGET_TEMPLATES, CHAT_WIDGET_TEMPLATES, EDITION_CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';
import { transformWidgetAsset } from '../../../scripts/build/widgetBrand.mjs';

const ROOT = process.cwd();
const CHAT_DIR = 'public/widget';
const CALL_DIR = 'public/call-widget';
const FONT_DIR = `${CHAT_DIR}/fonts`;

/**
 * Budgets, in bytes. JS/CSS: minified as shipped, then gzip level 5 (what a
 * visitor downloads). Fonts: the woff2 file itself (already compressed).
 * Raising one is a decision, not a fix: say why in the commit and in
 * docs/operations/WIDGET_TEMPLATE_RULES.md.
 */
export const BUDGETS = {
  chat: {
    /** Downloaded on EVERY page view of every customer site. */
    loader: 24_000,
    renderer: 20_000,
    stylesheet: 18_000,
    skin: 6_000,
    fontsStylesheet: 3_000,
    /** renderer + stylesheet + skin + fonts stylesheet, on the first open. */
    templateTotal: 40_000,
    /** Core's renderer features (runtime-ext.js), with a t1/t2 template's files. */
    ext: 8_000,
    /** Core's late features (runtime-late.js), after the first paint. */
    late: 12_000,
    /** One renderer's extras (presentation-<renderer>-x.js), after the first paint; not in templateTotal. */
    extras: 12_000,
    /** The launcher styles' stylesheet (runtime-fab.css), only for a workspace wearing one. */
    fab: 2_000,
    /** The emoji search's keywords (runtime-emoji.js), on the search's first use (issue #340). */
    emoji: 4_000,
  },
  call: {
    /** The call widget mounts at page load, so all of these are page-view bytes. */
    loader: 3_000,
    runtimeCss: 5_000,
    presentation: 10_000,
    stylesheet: 3_000,
  },
  fonts: {
    file: 45_000,
    /** What a template's prepare() makes a Persian first paint download. */
    persianFirstPaint: 120_000,
    /** The same for an English or a Turkish first paint. */
    latinFirstPaint: 50_000,
  },
  /** One inline SVG in a template stylesheet, encoded. */
  inlineSvg: 2_048,
} as const;

const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const exists = (path: string) => existsSync(resolve(ROOT, path));
const unique = <T,>(xs: Iterable<T>) => [...new Set(xs)];
type Brand = 'iran' | 'respok';
const shippedGzip = (path: string, brand: Brand = 'iran') => {
  const name = path.split('/').pop()!;
  const out = transformWidgetAsset(name, readFileSync(resolve(ROOT, path)), brand);
  return gzipSync(Buffer.from(out, 'utf8'), { level: 5 }).length;
};
/** The build brand of each edition's deployment (scripts/build/brand.mjs). */
const EDITION_BRAND = { iran: 'iran', international: 'respok' } as const satisfies Record<keyof typeof EDITION_CHAT_WIDGET_TEMPLATES, Brand>;
/** The brands whose builds ship a chat template to an edition that offers it. */
const brandsOf = (id: string) => unique((Object.keys(EDITION_CHAT_WIDGET_TEMPLATES) as Array<keyof typeof EDITION_CHAT_WIDGET_TEMPLATES>)
  .filter((e) => (EDITION_CHAT_WIDGET_TEMPLATES[e].offered as readonly string[]).includes(id))
  .map((e) => EDITION_BRAND[e]));

type ChatTemplate = { id: string; script: string; style: string; skin: string | null; fonts: string | null; extras: string | null };
type CallTemplate = { id: string; script: string; style: string };
const chatTemplates = Object.values(CHAT_WIDGET_TEMPLATES) as ChatTemplate[];
const callTemplates = Object.values(CALL_WIDGET_TEMPLATES) as CallTemplate[];

// ─── Fonts stylesheet parsing ─────────────────────────────────────────────

interface Face { family: string; weight: number; file: string; ranges: Array<[number, number]> | null; block: string }

function parseRanges(value: string): Array<[number, number]> {
  return value.split(',').map((part) => {
    const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
    if (!m) throw new Error(`unparseable unicode-range part "${part.trim()}"`);
    if (m[1].includes('?')) {
      return [parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)] as [number, number];
    }
    const lo = parseInt(m[1], 16);
    return [lo, m[2] ? parseInt(m[2], 16) : lo] as [number, number];
  });
}

function parseFaces(css: string): Face[] {
  const blocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  return blocks.map((block) => {
    const family = (block.match(/font-family:\s*['"]?([^;'"]+)['"]?\s*;/) || [])[1];
    const weight = Number((block.match(/font-weight:\s*(\d+)\s*;/) || [])[1]);
    const file = (block.match(/url\((['"]?)fonts\/([a-z0-9-]+\.woff2)\1\)/) || [])[2];
    const range = (block.match(/unicode-range:\s*([^;]+);/) || [])[1];
    return { family, weight, file, ranges: range ? parseRanges(range) : null, block };
  });
}

const covers = (face: Face, cp: number) => !face.ranges || face.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const fontsStylesheets = unique(chatTemplates.map((t) => t.fonts).filter((f): f is string => !!f));

// ─── Every template's files ───────────────────────────────────────────────

describe('template files: named by the convention, present, discoverable by the build', () => {
  for (const t of chatTemplates) {
    it(`chat template "${t.id}"`, () => {
      expect(t.script).toMatch(/^presentation-[a-z0-9-]+\.js$/);
      expect(t.style).toMatch(/^presentation-[a-z0-9-]+\.css$/);
      if (t.skin) expect(t.skin).toMatch(/^presentation-[a-z0-9-]+\.css$/);
      if (t.fonts) expect(t.fonts).toMatch(/^presentation-[a-z0-9-]+-fonts\.css$/);
      // A renderer's extras: its own name with -x (a skin names its renderer's).
      if (t.extras) expect(t.extras).toBe(t.script.replace(/\.js$/, '-x.js'));
      for (const f of [t.script, t.style, t.skin, t.fonts, t.extras].filter(Boolean) as string[]) {
        expect(exists(`${CHAT_DIR}/${f}`), `${CHAT_DIR}/${f}`).toBe(true);
      }
    });
  }
  for (const t of callTemplates) {
    it(`call template "${t.id}"`, () => {
      expect(t.script).toMatch(/^presentation-[a-z0-9-]+\.js$/);
      expect(t.style).toMatch(/^presentation-[a-z0-9-]+\.css$/);
      expect(exists(`${CALL_DIR}/${t.script}`), `${CALL_DIR}/${t.script}`).toBe(true);
      expect(exists(`${CALL_DIR}/${t.style}`), `${CALL_DIR}/${t.style}`).toBe(true);
    });
  }
});

/**
 * Every url() of a stylesheet, comments left out, each value whole: a quoted
 * one may hold its SVG's own parentheses (rotate(45), url(%23g)), and none
 * ends at an escaped quote or parenthesis (\" \' \)). `rest` is the sheet
 * without them, so a url( or a data: the reading missed shows there.
 */
function cssUrls(css: string): { urls: string[]; rest: string } {
  const urls: string[] = [];
  const rest = css.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^"'()\s\\]|\\[\s\S])*))\s*\)/gi, (_m, dq?: string, sq?: string, bare?: string) => {
      urls.push(dq ?? sq ?? bare ?? '');
      return '';
    });
  return { urls, rest };
}

describe('template stylesheets carry no fonts and fetch nothing', () => {
  const FAB = `${CHAT_DIR}/runtime-fab.css`;
  const sheets = unique([
    ...chatTemplates.flatMap((t) => [t.style, t.skin].filter(Boolean).map((f) => `${CHAT_DIR}/${f}`)),
    ...callTemplates.map((t) => `${CALL_DIR}/${t.style}`),
    `${CALL_DIR}/runtime.css`,
    `${CHAT_DIR}/runtime.css`,
    // The launcher styles (the loader's shadow root, like runtime.css).
    FAB,
  ]);
  for (const sheet of sheets) {
    it(sheet, () => {
      const css = read(sheet);
      // Faces belong to the template's document-level fonts stylesheet only:
      // a stylesheet in a shadow root never gets its faces fetched (Chromium),
      // and font bytes inline are downloaded by every visitor.
      expect(css).not.toMatch(/@font-face/);
      expect(css).not.toMatch(/\.woff2?\b|\.ttf\b|\.otf\b/);
      expect(css).not.toMatch(/data:(?:font|application\/(?:x-)?font)/i);
      // No other host, no extra request.
      expect(css).not.toMatch(/@import/);
      expect(css).not.toMatch(/https?:\/\//);
      // Only small inline SVGs may sit in url(), every one of them measured.
      const { urls, rest } = cssUrls(css);
      expect(rest, `a url() or data: in ${sheet} that was not measured`).not.toMatch(/url\(|data:/i);
      for (const u of urls) {
        expect(u, `url() in ${sheet}`).toMatch(/^data:image\/svg\+xml[,;]/);
        expect(Buffer.byteLength(u, 'utf8'), `inline SVG in ${sheet}`).toBeLessThanOrEqual(BUDGETS.inlineSvg);
      }
    });
  }

  it(`${FAB}: its glyphs are inline SVGs, so the ${BUDGETS.inlineSvg} B rule above measures each one`, () => {
    expect(sheets).toContain(FAB);
    const { urls } = cssUrls(read(FAB));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^data:image\/svg\+xml,/);
  });

  it('the url() reading takes each value whole: quoted SVGs with their own parentheses, escapes, URL(, comments', () => {
    const big = `data:image/svg+xml,%3Csvg viewBox='0 0 24 24'%3E%3Cpath transform='rotate(45 12 12)' fill='url(%23g)' d='M0 0h${'1'.repeat(BUDGETS.inlineSvg)}'/%3E%3C/svg%3E`;
    const small = 'data:image/svg+xml,%3Csvg/%3E';
    const { urls, rest } = cssUrls(`/* url(a.png) */ .a { --i: url("${big}"); } .b { background: URL( ${small} ) } .c { mask: url('${small}') }`);
    expect(urls).toEqual([big, small, small]);
    expect(rest).not.toMatch(/url\(|data:/i);
    expect(Buffer.byteLength(urls[0], 'utf8')).toBeGreaterThan(BUDGETS.inlineSvg);
    // An escaped quote or parenthesis does not end the value: the big tail after it is measured.
    const tail = `%2F%3E${'1'.repeat(BUDGETS.inlineSvg)}`;
    const dq = `data:image/svg+xml,%3Csvg d='\\")${tail}'`;
    const sq = `data:image/svg+xml,%3Csvg d="\\')${tail}"`;
    const bare = `data:image/svg+xml,%3Csvg\\)${tail}`;
    const escaped = cssUrls(`.e { --i: url("${dq}"); --j: url('${sq}'); --k: url( ${bare} ) }`);
    expect(escaped.urls).toEqual([dq, sq, bare]);
    for (const u of escaped.urls) expect(Buffer.byteLength(u, 'utf8')).toBeGreaterThan(BUDGETS.inlineSvg);
    expect(escaped.rest).not.toMatch(/url\(|data:/i);
    // A url() the reading cannot take whole stays in `rest`, where the rule sees it.
    expect(cssUrls('.d { background: url("data:image/svg+xml,x) }').rest).toMatch(/url\(/);
  });
});

describe('fonts: one document-level stylesheet per template, each face fetched only when its text is on screen', () => {
  for (const sheet of fontsStylesheets) {
    it(`${sheet}: every face is a hashed-by-build woff2 file with swap and a unicode-range`, () => {
      const css = read(`${CHAT_DIR}/${sheet}`);
      expect(css).not.toMatch(/data:|base64,/);
      expect(css).not.toMatch(/https?:\/\/|@import/);
      const faces = parseFaces(css);
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) {
        expect(face.family, face.block).toBeTruthy();
        expect(Number.isInteger(face.weight), face.block).toBe(true);
        expect(face.block).toMatch(/font-display:\s*swap\s*;/);
        expect(face.block).toMatch(/font-style:\s*normal\s*;/);
        // Exactly one source, a woff2 file under fonts/ that exists.
        expect((face.block.match(/url\(/g) || []).length, face.block).toBe(1);
        expect(face.file, face.block).toBeTruthy();
        expect(exists(`${FONT_DIR}/${face.file}`), `${FONT_DIR}/${face.file}`).toBe(true);
        // A face without a range is fetched for any character: only a family's
        // LAST face (the fallback a browser without unicode-range uses) may
        // omit it, and only when an earlier face of the same family has one.
        if (!face.ranges) {
          const same = faces.filter((f) => f.family === face.family && f.weight === face.weight);
          expect(same[same.length - 1], `${face.family} ${face.weight}: only the last face may omit unicode-range`).toBe(face);
        }
      }
    });

    it(`${sheet}: no emoji or symbol block claimed, so they never download a face`, () => {
      for (const face of parseFaces(read(`${CHAT_DIR}/${sheet}`))) {
        if (!face.ranges) continue;
        for (const cp of [0x1f600, 0x1f44b, 0x2764, 0x2600]) {
          expect(covers(face, cp), `${face.family} ${face.weight} claims U+${cp.toString(16)}`).toBe(false);
        }
      }
    });
  }

  it('every font file is named by a fonts stylesheet, and no two files are the same bytes', () => {
    const faces = fontsStylesheets.flatMap((s) => parseFaces(read(`${CHAT_DIR}/${s}`)));
    const named = new Set(faces.map((f) => f.file));
    // An OFL face's licence text may sit next to its files (for a family a stylesheet names).
    const all = readdirSync(resolve(ROOT, FONT_DIR));
    for (const f of all.filter((n) => n.endsWith('.txt'))) {
      const family = (f.match(/^OFL-([A-Za-z]+)\.txt$/) || [])[1];
      expect(family && faces.some((face) => face.family === family), `${FONT_DIR}/${f}: not the licence of a shipped family`).toBe(true);
    }
    const files = all.filter((n) => !n.endsWith('.txt'));
    for (const f of files) {
      expect(f).toMatch(/^[a-z0-9-]+\.woff2$/);
      expect(named.has(f), `${FONT_DIR}/${f} is shipped but no fonts stylesheet names it`).toBe(true);
    }
    const digests = files.map((f) => createHash('sha256').update(readFileSync(resolve(ROOT, FONT_DIR, f))).digest('hex'));
    expect(new Set(digests).size, 'two font files hold the same bytes: point both faces at one file').toBe(files.length);
  });

  it(`every font file is at most ${BUDGETS.fonts.file} bytes`, () => {
    for (const f of readdirSync(resolve(ROOT, FONT_DIR)).filter((n) => n.endsWith('.woff2'))) {
      const size = readFileSync(resolve(ROOT, FONT_DIR, f)).length;
      expect(size, `${FONT_DIR}/${f}`).toBeLessThanOrEqual(BUDGETS.fonts.file);
    }
  });
});

// ─── prepare(): what a first paint downloads ─────────────────────────────

/**
 * Boots the registry and the template's renderer in a bare window, calls
 * prepare(context) with a recording document.fonts.load, and returns the
 * font files the browser would fetch for those loads (the faces whose
 * family and weight match and whose unicode-range meets the sample text).
 */
async function firstPaintFonts(t: ChatTemplate, locale: string, opts: { hang?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const win = dom.window as unknown as Window & Record<string, unknown> & { eval: (s: string) => void };
  const loads: Array<{ spec: string; text: string }> = [];
  Object.defineProperty(win.document, 'fonts', {
    configurable: true,
    value: {
      load: (spec: string, text = 'BESbswy') => {
        loads.push({ spec, text });
        return opts.hang ? new Promise(() => {}) : Promise.resolve([]);
      },
    },
  });
  win.eval(read(`${CHAT_DIR}/presentation-registry.js`));
  win.eval(read(`${CHAT_DIR}/${t.script}`));
  const registry = win.__gs_presentation_registry as { resolve: (id: string) => { globalKey: string } } | undefined;
  const descriptor = registry?.resolve(t.id);
  const mod = descriptor ? (win[descriptor.globalKey] as { prepare?: (c?: unknown) => unknown }) : undefined;
  expect(mod, `renderer of "${t.id}" registers under its descriptor's globalKey`).toBeTruthy();

  const started = Date.now();
  let threw: unknown = null;
  let ready: unknown = null;
  try {
    ready = typeof mod!.prepare === 'function' ? mod!.prepare({ locale, templateId: t.id }) : null;
  } catch (e) { threw = e; }
  await Promise.resolve(ready);
  const elapsed = Date.now() - started;

  const faces = t.fonts ? parseFaces(read(`${CHAT_DIR}/${t.fonts}`)) : [];
  const files = new Set<string>();
  for (const { spec, text } of loads) {
    const m = spec.match(/^\s*(\d+)\s+\S+\s+['"]?([^'"]+?)['"]?\s*$/);
    expect(m, `document.fonts.load("${spec}")`).toBeTruthy();
    const weight = Number(m![1]);
    const family = m![2];
    const matching = faces.filter((f) => f.family === family && f.weight === weight);
    expect(matching.length, `prepare() asks for ${family} ${weight}, which ${t.fonts} does not declare`).toBeGreaterThan(0);
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      for (const f of matching) if (covers(f, cp)) files.add(f.file);
    }
  }
  const bytes = [...files].reduce((n, f) => n + readFileSync(resolve(ROOT, FONT_DIR, f)).length, 0);
  dom.window.close();
  return { threw, elapsed, files: [...files], bytes };
}

describe('prepare(): bounded, never throws, warms only what the first paint draws', () => {
  for (const t of chatTemplates) {
    for (const locale of ['fa', 'en', 'tr']) {
      it(`"${t.id}" in ${locale}`, async () => {
        const r = await firstPaintFonts(t, locale);
        expect(r.threw).toBeNull();
        const budget = locale === 'fa' ? BUDGETS.fonts.persianFirstPaint : BUDGETS.fonts.latinFirstPaint;
        expect(r.bytes, `first paint fonts ${r.files.join(', ')}`).toBeLessThanOrEqual(budget);
      });
    }

    it(`"${t.id}" settles within 600 ms even if a font never arrives`, async () => {
      const r = await firstPaintFonts(t, 'fa', { hang: true });
      expect(r.threw).toBeNull();
      expect(r.elapsed).toBeLessThan(600);
    });
  }

  // The International skins draw Latin text in Figtree, whose Turkish letters
  // (ğ ş İ, on every Turkish first paint) are a file of their own; Template 1
  // and 2 keep Inter's one Latin file, Turkish included.
  const byId = (id: string) => chatTemplates.find((t) => t.id === id)!;
  for (const id of ['t1-intl', 't2-intl']) {
    it(`"${id}": Figtree's Latin file in English, both Figtree files in Turkish, IRANSans only in Persian`, async () => {
      expect((await firstPaintFonts(byId(id), 'en')).files).toEqual(['figtree-latin.woff2']);
      expect((await firstPaintFonts(byId(id), 'tr')).files.sort()).toEqual(['figtree-latin.woff2', 'figtree-tr.woff2']);
      expect((await firstPaintFonts(byId(id), 'fa')).files.every((f) => f.startsWith('iransans-'))).toBe(true);
    });
  }
  for (const id of ['t1', 't2']) {
    it(`"${id}": Inter's Latin file in English and in Turkish, never Figtree`, async () => {
      expect((await firstPaintFonts(byId(id), 'en')).files).toEqual(['inter-500-latin.woff2']);
      expect((await firstPaintFonts(byId(id), 'tr')).files).toEqual(['inter-500-latin.woff2']);
    });
  }
});

// ─── Renderers: pure presentation ─────────────────────────────────────────

describe('renderers reach no network, no storage and no other host', () => {
  const scripts = unique([
    ...chatTemplates.map((t) => `${CHAT_DIR}/${t.script}`),
    // A renderer's extras are renderer markup too.
    ...chatTemplates.flatMap((t) => (t.extras ? [`${CHAT_DIR}/${t.extras}`] : [])),
    ...callTemplates.map((t) => `${CALL_DIR}/${t.script}`),
    `${CHAT_DIR}/presentation-registry.js`,
    `${CALL_DIR}/presentation-registry.js`,
    // Core's emoji keywords: pure data, held to the same rules.
    `${CHAT_DIR}/runtime-emoji.js`,
  ]);
  for (const script of scripts) {
    it(script, () => {
      const src = read(script);
      for (const banned of [
        /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/,
        /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /document\.cookie/,
        /\bimport\s*\(/, /importScripts/, /\beval\s*\(/, /new\s+Function\s*\(/,
      ]) {
        expect(src, `${script} must not contain ${banned}`).not.toMatch(banned);
      }
      // No address of any host. XML namespace names (createElementNS) are
      // identifiers, not requests.
      const urls = src.match(/https?:\/\/[^\s'"`)]+/g) || [];
      const NAMESPACES = /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML)$/;
      for (const url of urls) expect(url, `${script} names a host`).toMatch(NAMESPACES);
    });
  }
});

// ─── Size budgets, as shipped ─────────────────────────────────────────────

describe('size budgets (minified as shipped, gzip level 5)', () => {
  // Each brand's build ships its own loader (the RESPOK one without the Iran
  // region's kit): both are page-view bytes.
  for (const brand of ['iran', 'respok'] as const) {
    it(`chat loader.js ≤ ${BUDGETS.chat.loader} B in the ${brand} build: every page view of every site downloads it`, () => {
      expect(shippedGzip(`${CHAT_DIR}/loader.js`, brand)).toBeLessThanOrEqual(BUDGETS.chat.loader);
    });
  }

  // Each template in the build of every edition that offers it.
  for (const t of chatTemplates) {
    const brands = brandsOf(t.id);
    it(`chat template "${t.id}" (${brands.join(', ')})`, () => {
      expect(brands.length, 'a template no edition offers').toBeGreaterThan(0);
      for (const brand of brands) {
        const renderer = shippedGzip(`${CHAT_DIR}/${t.script}`, brand);
        const style = shippedGzip(`${CHAT_DIR}/${t.style}`, brand);
        const skin = t.skin ? shippedGzip(`${CHAT_DIR}/${t.skin}`, brand) : 0;
        const fonts = t.fonts ? shippedGzip(`${CHAT_DIR}/${t.fonts}`, brand) : 0;
        expect(renderer, `${t.script} (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.renderer);
        expect(style, `${t.style} (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.stylesheet);
        expect(skin, `${t.skin} (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.skin);
        expect(fonts, `${t.fonts} (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.fontsStylesheet);
        // The extras come after the first paint: not first-open bytes.
        expect(renderer + style + skin + fonts, `first-open template bytes (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.templateTotal);
        if (t.extras) expect(shippedGzip(`${CHAT_DIR}/${t.extras}`, brand), `${t.extras} (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.extras);
      }
    });
  }

  it(`Core's renderer features ≤ ${BUDGETS.chat.ext} B, late features ≤ ${BUDGETS.chat.late} B and emoji keywords ≤ ${BUDGETS.chat.emoji} B, in both builds`, () => {
    for (const brand of ['iran', 'respok'] as const) {
      expect(shippedGzip(`${CHAT_DIR}/runtime-ext.js`, brand), `runtime-ext.js (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.ext);
      expect(shippedGzip(`${CHAT_DIR}/runtime-late.js`, brand), `runtime-late.js (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.late);
      expect(shippedGzip(`${CHAT_DIR}/runtime-emoji.js`, brand), `runtime-emoji.js (${brand})`).toBeLessThanOrEqual(BUDGETS.chat.emoji);
    }
  });

  // The launcher styles' stylesheet (issue #340): only a workspace wearing one downloads it.
  it(`chat runtime-fab.css ≤ ${BUDGETS.chat.fab} B, in both builds`, () => {
    for (const brand of ['iran', 'respok'] as const) {
      expect(shippedGzip(`${CHAT_DIR}/runtime-fab.css`, brand)).toBeLessThanOrEqual(BUDGETS.chat.fab);
    }
  });

  it(`call l.js ≤ ${BUDGETS.call.loader} B and runtime.css ≤ ${BUDGETS.call.runtimeCss} B`, () => {
    expect(shippedGzip(`${CALL_DIR}/l.js`)).toBeLessThanOrEqual(BUDGETS.call.loader);
    expect(shippedGzip(`${CALL_DIR}/runtime.css`)).toBeLessThanOrEqual(BUDGETS.call.runtimeCss);
  });

  for (const t of callTemplates) {
    it(`call template "${t.id}"`, () => {
      expect(shippedGzip(`${CALL_DIR}/${t.script}`), t.script).toBeLessThanOrEqual(BUDGETS.call.presentation);
      expect(shippedGzip(`${CALL_DIR}/${t.style}`), t.style).toBeLessThanOrEqual(BUDGETS.call.stylesheet);
    });
  }
});
