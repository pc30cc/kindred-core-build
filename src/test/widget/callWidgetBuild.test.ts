/**
 * scripts/call-widget-hash.js: the call widget as the frontend image ships it.
 *
 *  - every JS/CSS file under a content-hashed name (`<name>.<sha256/12>.<ext>`,
 *    served immutable by nginx.conf.template) AND under its fixed name, the
 *    same bytes (old loaders, the operator preview, the loader's fallback);
 *  - the LiveKit SDK by the chat widget's hashed name (the same file: one
 *    download and cache entry for both widgets), so an upgrade reaches
 *    returning visitors; the fixed name stays for older loaders;
 *  - level-9 .gz copies of the hashed files for nginx's gzip_static;
 *  - those names written INTO l.js (an esbuild `define` of a JSON string,
 *    parsed inside the IIFE), so a loader only ever names files of its own
 *    build, and l.js declares nothing on the customer's page;
 *  - for every build brand, the RESPOK one without the Iran region's kit.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import { buildCallWidget, FONTS_NAME, LIVEKIT_NAME, ROOT, type CallWidgetBuild } from './callWidgetBuildFixture';

const sha12 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const SOURCES = readdirSync(join(ROOT, 'public/call-widget'))
  .filter((n) => n === 'runtime.js' || n === 'runtime.css' || /^presentation-[a-z0-9-]+\.(js|css)$/.test(n))
  .sort();

describe.each([
  ['VITE_BRAND unset', null],
  ['iran', 'iran'],
  ['respok', 'respok'],
] as const)('the call widget build (%s)', (_label, brand) => {
  let build: CallWidgetBuild;
  beforeAll(() => { build = buildCallWidget(brand); }, 60_000);
  afterAll(() => build?.cleanup());

  it('hashes every runtime and presentation file and keeps its fixed name as the same bytes', () => {
    expect(Object.keys(build.manifest.files).sort()).toEqual(SOURCES);
    for (const [name, hashed] of Object.entries(build.manifest.files)) {
      const bytes = build.read(hashed);
      const dot = name.lastIndexOf('.');
      expect(hashed).toBe(`${name.slice(0, dot)}.${sha12(bytes)}${name.slice(dot)}`);
      expect(hashed).toMatch(/^[a-z0-9.-]+\.[a-f0-9]{12}\.(?:js|css)$/); // nginx's hashed rule
      expect(build.read(name).equals(bytes), `${name} differs from ${hashed}`).toBe(true);
      // Minified (the shipped bytes), not the source.
      expect(bytes.length).toBeLessThan(readFileSync(join(ROOT, 'public/call-widget', name)).length);
      expect(bytes.toString('utf8')).not.toMatch(/^\/\*[^!]/);
    }
  });

  it('names the chat widget\'s hashed LiveKit SDK and fonts stylesheet of the same image', () => {
    expect(build.manifest.livekit).toBe(`/widget/${LIVEKIT_NAME}`);
    expect(build.manifest.fonts).toBe(`/widget/${FONTS_NAME}`);
    // No second hashed copy under /call-widget/; the fixed name stays.
    expect(readdirSync(join(build.dist, 'vendor'))).toEqual(['livekit-client.umd.min.js']);
    // The very same SDK bytes as the chat widget's (so sharing its copy is right).
    expect(readFileSync(join(ROOT, 'public/call-widget/vendor/livekit-client.umd.min.js'))
      .equals(readFileSync(join(ROOT, 'public/widget/vendor/livekit-client.umd.min.js')))).toBe(true);
  });

  it('writes a level-9 .gz beside each hashed file worth compressing', () => {
    for (const name of Object.values(build.manifest.files)) {
      const bytes = build.read(name);
      const gz = join(build.dist, `${name}.gz`);
      if (bytes.length < 1024) continue;
      expect(existsSync(gz), `${name}.gz`).toBe(true);
      expect(gunzipSync(build.read(`${name}.gz`)).equals(bytes)).toBe(true);
    }
  });

  it('l.js carries every name of this build, and nothing else of it', () => {
    const { loader, manifest } = build;
    expect(loader).not.toContain('__CALL_WIDGET_BUILD__');
    for (const hashed of Object.values(manifest.files)) expect(loader).toContain(hashed);
    expect(loader).toContain(manifest.livekit!);
    expect(loader).toContain(manifest.fonts!);
    // One IIFE: no top-level declaration (an object `define` would hoist a
    // `var` onto the customer's page).
    expect(loader.trimStart()).toMatch(/^\(function\(\)\{/);
    expect(loader.trimEnd()).toMatch(/\}\)\(\);?$/);
  });

  it('l.js defines no global but its once-only flag, even when it runs fully', () => {
    const dom = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://shop.example/', runScripts: 'outside-only' });
    const win = dom.window as unknown as Window & { eval(code: string): unknown };
    const tag = win.document.createElement('script');
    tag.setAttribute('src', 'https://app.example/call-widget/l.js');
    tag.setAttribute('workspace-id', '22222222-2222-4222-8222-222222222222');
    win.document.head.appendChild(tag);
    (win as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});
    const before = new Set(Object.keys(win));
    win.eval(build.loader);
    expect(Object.keys(win).filter((k) => !before.has(k))).toEqual(['__CC_WIDGET_LOADED__']);
    dom.window.close();
  });

  it('parses as a script', () => {
    // Compiling is parsing; it does not run.
    expect(() => new Function(build.loader)).not.toThrow();
  });

  if (brand === 'respok') {
    it('carries nothing of the Iran brand in any shipped file', () => {
      const names = [...Object.values(build.manifest.files), 'l.js'];
      for (const name of names) {
        const text = build.read(name).toString('utf8');
        for (const re of IRAN_BRAND_PATTERNS) {
          expect(re.test(name), `${name}: file name matches ${re}`).toBe(false);
          const m = re.exec(text);
          expect(m && text.slice(Math.max(0, m.index - 60), m.index + 60), `${name} matches ${re}`).toBeNull();
        }
      }
    });
  }
});

describe('a build without the chat widget\'s manifest', () => {
  it('ships l.js without a fonts or LiveKit URL (the bootstrap\'s font_style_url and the fixed SDK name are used)', () => {
    const build = buildCallWidget(null, false);
    try {
      expect(build.manifest.fonts).toBeNull();
      expect(build.manifest.livekit).toBeNull();
      expect(build.loader).toContain('"fonts":null');
      expect(build.loader).toContain('"livekit":null');
      for (const hashed of Object.values(build.manifest.files)) expect(build.loader).toContain(hashed);
    } finally {
      build.cleanup();
    }
  }, 60_000);
});
