/**
 * How the panel's build files are cut and delivered: vendor files
 * (scripts/build/vendorChunks.mjs), gzip copies (scripts/build/precompress.mjs),
 * caching headers (nginx.conf.template), the service worker's cache rule
 * (scripts/pwa/service-worker-template.js) and the hints in index.html.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { groupOfPackage, packageNameOf, vendorChunk } from '../../../scripts/build/vendorChunks.mjs';
import { precompressFiles } from '../../../scripts/build/precompress.mjs';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const NGINX = read('nginx.conf.template');

/** The body of a `location` block, by what it matches, comments stripped. */
function locationBlock(match: string): string {
  const start = NGINX.indexOf(`location ${match} {`);
  expect(start, `no "location ${match}" block in nginx.conf.template`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = NGINX.indexOf('{', start); i < NGINX.length; i++) {
    if (NGINX[i] === '{') depth++;
    else if (NGINX[i] === '}' && --depth === 0) return NGINX.slice(start, i + 1).replace(/^\s*#.*$/gm, '');
  }
  throw new Error(`unterminated "location ${match}" block`);
}

describe('nginx: hashed build files and the SPA document', () => {
  it('caches /assets/ for a year, immutable, from the precompressed copies', () => {
    const assets = locationBlock('^~ /assets/');
    expect(assets).toMatch(/add_header\s+Cache-Control\s+"public, max-age=31536000, immutable";/);
    expect(assets).toMatch(/gzip_static\s+on;/);
    expect(assets).toMatch(/try_files\s+\$uri\s+@missing_asset;/);
    // One Cache-Control only: `expires` would add a second one.
    expect(assets).not.toMatch(/\bexpires\b/);
    expect(assets).not.toContain('index.html');
    expect(NGINX).not.toMatch(/location \/assets\/ \{/);
  });

  it('never puts the year-long header on an error response', () => {
    // `always` would add it to the 404 too, and Cloudflare and browsers
    // would keep that 404 for a year (a rolling deploy produces them).
    const assets = locationBlock('^~ /assets/');
    expect(assets).not.toMatch(/immutable"\s+always/);
  });

  it('answers a missing build file with a 404 that nothing stores', () => {
    const missing = locationBlock('@missing_asset');
    expect(missing).toMatch(/add_header\s+Cache-Control\s+"no-store"\s+always;/);
    expect(missing).toMatch(/add_header\s+CDN-Cache-Control\s+"no-store"\s+always;/);
    expect(missing).toMatch(/add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"\s+always;/);
    expect(missing).toMatch(/return\s+404;/);
    expect(missing).not.toContain('immutable');
    expect(missing).not.toContain('index.html');
  });

  it('makes the browser revalidate index.html on every load', () => {
    const index = locationBlock('= /index.html');
    expect(index).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s+always;/);
    // A location with its own add_header drops the server-level ones.
    expect(index).toMatch(/add_header\s+X-Frame-Options\s+"SAMEORIGIN"\s+always;/);
    expect(index).toMatch(/add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/);
    expect(index).toMatch(/add_header\s+Referrer-Policy\s+"strict-origin-when-cross-origin"\s+always;/);
  });

  it('still falls back to index.html for every other path', () => {
    expect(locationBlock('/')).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });
});

describe('service worker', () => {
  const template = read('scripts/pwa/service-worker-template.js');

  it('stores only successful same-origin responses (never a 404 for a removed page file)', () => {
    const putInCache = template.slice(template.indexOf('function putInCache'), template.indexOf('self.addEventListener(\'fetch\''));
    expect(putInCache).toMatch(/if \(!response \|\| !response\.ok \|\| response\.type !== 'basic'\) return response;/);
  });

  it('is built with the core-only precache list and the build helpers', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('pwaBuild(),');
    expect(config).toContain('bootHints(),');
    expect(config).toContain('precompress(),');
    expect(config).toMatch(/manualChunks: \(id, meta\) => .*vendorChunk\(id, meta\)/);
    // Page files are not downloaded at install: they are listed apart.
    expect(config).toMatch(/if \(output\.isEntry\) addWithImports\(output\.fileName\);/);
    expect(config).toContain('(core.has(fileName) ? urls : lazyUrls).push(`/${fileName}`);');
    expect(config).toContain('.replace(/__LAZY_URLS__/g, JSON.stringify(lazyUrls));');
  });

  /**
   * Runs the template the way a browser runs dist/sw.js, with in-memory
   * stand-ins for the Cache Storage and the network.
   */
  function startWorker(options: { precache?: string[]; lazy?: string[]; failing?: string[] } = {}) {
    const source = template
      .replace(/__BUILD_ID__/g, 'test')
      .replace(/__PRECACHE_URLS__/g, JSON.stringify(options.precache ?? ['/', '/index.html']))
      .replace(/__LAZY_URLS__/g, JSON.stringify(options.lazy ?? []));
    const listeners: Record<string, (event: unknown) => void> = {};
    const stored = new Map<string, unknown>();
    const cache = {
      match: vi.fn(async (url: string) => stored.get(url)),
      put: vi.fn(async (url: string, response: unknown) => {
        stored.set(url, response);
      }),
      addAll: vi.fn(async () => {}),
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = vi.fn(async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight -= 1;
      const ok = !(options.failing ?? []).includes(url);
      return { ok, status: ok ? 200 : 404, type: 'basic', url, clone() { return this; } };
    });
    const self = {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = listener;
      },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    };
    const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => []), match: cache.match, delete: vi.fn() };
    new Function('self', 'caches', 'fetch', source)(self, caches, fetch);
    return { listeners, stored, cache, fetch, self, maxInFlight: () => maxInFlight };
  }

  it('caches the rest of the build when the app asks, a few files at a time', async () => {
    const lazy = Array.from({ length: 8 }, (_, i) => `/assets/Page${i}-abc.js`);
    const worker = startWorker({ lazy, failing: ['/assets/Page5-abc.js'] });
    // Already cached (opened earlier): not downloaded again.
    worker.stored.set('/assets/Page0-abc.js', { cached: true });

    let done: Promise<unknown> = Promise.resolve();
    worker.listeners.message({ data: 'WARM_CACHE', waitUntil: (promise: Promise<unknown>) => { done = promise; } });
    await done;

    const fetched = worker.fetch.mock.calls.map(([url]) => url).sort();
    expect(fetched).toEqual(lazy.slice(1).sort());
    expect([...worker.stored.keys()].sort()).toEqual(lazy.filter((url) => url !== '/assets/Page5-abc.js').sort());
    expect(worker.maxInFlight()).toBeLessThanOrEqual(3);

    // A second request in the same worker life does not start over.
    worker.listeners.message({ data: 'WARM_CACHE', waitUntil: (promise: Promise<unknown>) => { done = promise; } });
    await done;
    expect(worker.fetch).toHaveBeenCalledTimes(lazy.length - 1);
  });

  it('still applies an update only when the client asks for it', () => {
    const worker = startWorker();
    worker.listeners.message({ data: 'SKIP_WAITING', waitUntil: () => {} });
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('leaves an explicit no-store request to the network (the new-deploy check)', () => {
    const worker = startWorker();
    const respondWith = vi.fn();
    const request = (url: string, cache: string) => ({ method: 'GET', url, mode: 'cors', cache });
    worker.listeners.fetch({ request: request('https://app.example/index.html', 'no-store'), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    worker.listeners.fetch({ request: request('https://app.example/assets/Page-abc.js', 'default'), respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('picks the locale preload right after the runtime config, ahead of the stylesheet', () => {
    // An inline script after a stylesheet waits for it; bootHints inserts
    // the locale script next to this exact tag (vite.config.ts).
    const config = read('vite.config.ts');
    expect(config).toContain(`const RUNTIME_CONFIG_TAG = '<script src="/runtime-config.js"></script>';`);
    expect(config).toContain('html = html.replace(RUNTIME_CONFIG_TAG,');
    expect(html).toContain('<script src="/runtime-config.js"></script>');
  });

  it('preconnects to a cross-origin API right after the runtime config is read', () => {
    const config = html.indexOf('<script src="/runtime-config.js"></script>');
    const preconnect = html.indexOf("link.rel = 'preconnect';");
    expect(config).toBeGreaterThan(-1);
    expect(preconnect).toBeGreaterThan(config);
    expect(html).toContain('if (origin === location.origin) return;');
  });
});

describe('vendor files', () => {
  it('reads package names from module ids', () => {
    expect(packageNameOf('/app/node_modules/react/index.js')).toBe('react');
    expect(packageNameOf('/app/node_modules/@radix-ui/react-dialog/dist/index.mjs')).toBe('@radix-ui/react-dialog');
    expect(packageNameOf('/app/node_modules/.pnpm/d3-scale@4/node_modules/d3-scale/src/linear.js')).toBe('d3-scale');
    expect(packageNameOf('\0/app/node_modules/react/index.js?commonjs-module')).toBe('react');
    expect(packageNameOf('C:\\app\\node_modules\\recharts\\es6\\index.js')).toBe('recharts');
    expect(packageNameOf('/app/src/App.tsx')).toBeNull();
  });

  it('groups the libraries the plan names', () => {
    expect(groupOfPackage('react-dom')).toBe('vendor-react');
    expect(groupOfPackage('react-router-dom')).toBe('vendor-router');
    expect(groupOfPackage('@tanstack/react-query')).toBe('vendor-query');
    expect(groupOfPackage('@radix-ui/react-dialog')).toBe('vendor-ui');
    expect(groupOfPackage('tailwind-merge')).toBe('vendor-ui');
    expect(groupOfPackage('recharts')).toBe('vendor-charts');
    expect(groupOfPackage('d3-shape')).toBe('vendor-charts');
    expect(groupOfPackage('date-fns')).toBe('vendor-date');
    expect(groupOfPackage('@tiptap/react')).toBe('vendor-editor');
    expect(groupOfPackage('prosemirror-view')).toBe('vendor-editor');
    expect(groupOfPackage('livekit-client')).toBe('vendor-livekit');
    expect(groupOfPackage('leaflet')).toBe('vendor-maps');
    expect(groupOfPackage('lucide-react')).toBe('vendor-lucide');
    // Shared helpers are placed by who uses them, not named under one group.
    expect(groupOfPackage('fast-equals')).toBeNull();
    expect(groupOfPackage('lodash')).toBeNull();
  });

  /** A tiny module graph for manualChunks' `meta.getModuleInfo`. */
  function graph(modules: Record<string, { isEntry?: boolean; importers?: string[]; dynamicImporters?: string[] }>) {
    const getModuleInfo = (id: string) => {
      const m = modules[id];
      return m ? { isEntry: !!m.isEntry, importers: m.importers ?? [], dynamicImporters: m.dynamicImporters ?? [] } : null;
    };
    return { getModuleInfo, getModuleIds: () => Object.keys(modules)[Symbol.iterator]() } as unknown as Parameters<typeof vendorChunk>[1];
  }

  const NM = '/app/node_modules';

  it('keeps Rollup and Vite helpers out of the app entry', () => {
    const meta = graph({});
    expect(vendorChunk('\0commonjsHelpers.js', meta)).toBe('vendor-react');
    expect(vendorChunk(`${NM}/vite/preload-helper.js`, meta)).toBe('vendor-react');
    expect(vendorChunk('/app/src/pages/app/InboxPage.tsx', meta)).toBeUndefined();
  });

  it('places library helpers by who uses them', () => {
    const meta = graph({
      '/app/src/main.tsx': { isEntry: true },
      '/app/src/App.tsx': { importers: ['/app/src/main.tsx'] },
      '/app/src/pages/Chart.tsx': { dynamicImporters: ['/app/src/App.tsx'] },
      '/app/src/pages/Editor.tsx': { dynamicImporters: ['/app/src/App.tsx'] },
      [`${NM}/recharts/index.js`]: { importers: ['/app/src/pages/Chart.tsx'] },
      [`${NM}/@tiptap/react/index.js`]: { importers: ['/app/src/pages/Editor.tsx'] },
      // used by recharts and by TipTap → a file of its own
      [`${NM}/fast-equals/index.js`]: { importers: [`${NM}/recharts/index.js`, `${NM}/@tiptap/react/index.js`] },
      // used by recharts only (through another helper) → travels with charts
      [`${NM}/lodash/get.js`]: { importers: [`${NM}/recharts/index.js`] },
      [`${NM}/lodash/_baseGet.js`]: { importers: [`${NM}/lodash/get.js`] },
      // imported by the app's start-up code → the first-screen vendor file
      [`${NM}/tiny-lib/index.js`]: { importers: ['/app/src/App.tsx'] },
      // used by one lazy page only → left next to that page
      [`${NM}/page-only/index.js`]: { importers: ['/app/src/pages/Chart.tsx'] },
    });
    expect(vendorChunk(`${NM}/recharts/index.js`, meta)).toBe('vendor-charts');
    expect(vendorChunk(`${NM}/@tiptap/react/index.js`, meta)).toBe('vendor-editor');
    expect(vendorChunk(`${NM}/fast-equals/index.js`, meta)).toBe('vendor-fast-equals');
    expect(vendorChunk(`${NM}/lodash/_baseGet.js`, meta)).toBe('vendor-charts');
    expect(vendorChunk(`${NM}/tiny-lib/index.js`, meta)).toBe('vendor-misc');
    expect(vendorChunk(`${NM}/page-only/index.js`, meta)).toBeUndefined();
  });
});

describe('precompress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'precompress-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a smaller .gz beside each compressible file and skips the rest', async () => {
    const script = join(dir, 'index-abc.js');
    const source = 'export const value = "' + 'webyar '.repeat(2000) + '";\n';
    writeFileSync(script, source);
    const tiny = join(dir, 'tiny-abc.js');
    writeFileSync(tiny, 'export{}');
    const font = join(dir, 'iransans-400-abc.woff2');
    writeFileSync(font, new Uint8Array(4096).fill(7));

    const result = await precompressFiles([script, tiny, font]);
    expect(result.written).toBe(1);
    expect(existsSync(`${script}.gz`)).toBe(true);
    expect(gunzipSync(readFileSync(`${script}.gz`)).toString()).toBe(source);
    expect(existsSync(`${tiny}.gz`)).toBe(false);
    expect(existsSync(`${font}.gz`)).toBe(false);
  });
});
