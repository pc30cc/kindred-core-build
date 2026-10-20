/**
 * The call widget's visual QA harness (build contract 00-contract §8): drives
 * the live widget into each fixture state (e2e/harness/callScreensFixture.ts)
 * and compares it with the reference re-render (e2e/harness/callReference.ts)
 * made in the same Chromium at the same moment.
 *
 * The live widget boots exactly as on a customer's site: a page on the demo
 * store's host embeds the real loader from the platform's origin
 *
 *   <script async src="https://widget.test/call-widget/l.js" workspace-id="…">
 *
 * and every request is answered by page.route: the widget's files, the
 * bootstrap of the state, a resumed call's status, the fonts and brand files;
 * every other host is aborted and logged (the log must stay empty). Modes:
 *   --source        the raw files of public/call-widget (fast loop); the panel
 *                   module is put on the page only when the loader has no
 *                   panel hook yet;
 *   --shipped       each file as its brand ships it (scripts/build/widgetBrand.mjs);
 *   --built <dist>  a scratch hashed build (scripts/call-widget-hash.js), its
 *                   built loader with the hashed names.
 *
 * States are driven by controller fields + render(), renderer-local states by
 * real interactions (Continue, a field's focus, hover, the minimise button, a
 * star). Desktop shots move the widget 48px from the corner (the only change
 * made to the product: two custom properties on `.ccw-root`).
 *
 *   npx tsx e2e/harness/callScreens.ts --brand webyar --out /tmp/call-shots
 *   npx tsx e2e/harness/callScreens.ts --brand respok --states 05-01-home,09-13-rating --shipped
 *   npx tsx e2e/harness/callScreens.ts --brand webyar --built /tmp/build/dist --matrix
 *   npx tsx e2e/harness/callScreens.ts --brand webyar --compare-acceptance <handoff package>
 *
 * Outputs: <out>/<brand>/<state>[--<accent>][--<radius>].{live,ref,diff}.png
 * and <out>/<brand>/report.json; with --compare-acceptance, a Tier B sheet
 * per acceptance PNG (81 per brand) in <out>/<brand>/tier-b/: P/M/C as
 * acceptance PNG | live | heat map, G as acceptance | live closed | live
 * open, R as acceptance | the live state it shows (board 12's sheets alone).
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACCENT_PRESETS, BRAND_INFO, CALL_ID, DESKTOP_VIEWPORT, LIGHT_ACCENT, MEDIA, PANEL_PAD, PANEL_PROBES, PHONE_PROBES,
  PHONE_VIEWPORT, PIXEL_KINDS, SAFE_AREA, SHOT_OFFSET, SITE_ORIGIN, TIER_A, WIDGET_ORIGIN, WORKSPACE_ID,
  baseBootstrap, callStates, frozenNow, mergeJson,
  type Brand, type CallState, type FieldStep, type JsonObject, type Radius,
} from './callScreensFixture';
import { NAME_SHIM, ReferenceRenderer, resolveCallChromium, seekAnimations, type Box, type FeedFrames, type RefShot } from './callReference';
import { PngDiffer, describeDiff, type DiffResult, type Rect } from './pngDiff';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

export type Mode = 'source' | 'shipped' | 'built';

export interface LiveOptions {
  brand: Brand;
  mode?: Mode;
  /** --built: the scratch build's dist/ (holding call-widget/, and widget/ when the chat build ran). */
  dist?: string;
  accent?: string;
  radius?: Radius;
  /** Keep animations and seek them all to this time (ms) instead of reduced motion. */
  motionAt?: number;
  /**
   * Tier B of a G or R panel: drive the state and shoot the whole screen
   * (a placement closed, then open) instead of a crop matched to the reference.
   */
  review?: boolean;
}

export interface GeometryResult { ok: boolean; failures: string[]; measured: Record<string, number | string> }

export interface LiveShot {
  state: string;
  status: 'shot' | 'pending' | 'error' | 'geometry' | 'review';
  reason?: string;
  png?: Buffer;
  /** Crop size (CSS px). */
  width?: number;
  height?: number;
  /** Masks measured on the live side, relative to the crop (CSS px). */
  masks: Array<Box & { why: string }>;
  probes: Record<string, Box[]>;
  geometry?: GeometryResult;
  /** Requests to a host other than the site and the platform (aborted). */
  foreign: string[];
  /** pageerror and console.error messages. */
  errors: string[];
  /** Paths requested from the platform origin, in order (which files, hashed or fixed, the page loaded). */
  requests: string[];
  /** review: the whole screen, as the state shows it (a placement: closed, then open). */
  screens?: Buffer[];
}

// ─── Serving ─────────────────────────────────────────────────────────────
const TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
};
export const typeOf = (file: string) => TYPES[path.extname(file)] || 'application/octet-stream';

/** Demo images: the Sc business logo (a letter; masked) and the L8 operator photo (masked). */
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><circle cx="60" cy="60" r="34" fill="#0B7D6C"/></svg>';
const PHOTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#7E8C92"/><circle cx="64" cy="52" r="24" fill="#E6C3A6"/><path d="M20 128c0-30 20-46 44-46s44 16 44 46z" fill="#36556B"/></svg>';

type Transform = (name: string, input: Buffer, brand: 'iran' | 'respok') => string | Buffer;
let transformCache: Transform | null = null;
async function shippedTransform(): Promise<Transform> {
  if (!transformCache) {
    const mod = await import(path.join(ROOT, 'scripts/build/widgetBrand.mjs')) as { transformWidgetAsset: Transform };
    transformCache = mod.transformWidgetAsset;
  }
  return transformCache;
}

/** The files the platform origin serves, per mode (shipped bytes cached per brand). */
export class AssetServer {
  private readonly cache = new Map<string, Buffer>();
  constructor(private readonly mode: Mode, private readonly brand: Brand, private readonly dist?: string) {
    if (mode === 'built' && !(dist && existsSync(path.join(dist, 'call-widget', 'l.js')))) {
      throw new Error(`--built needs a dist folder holding call-widget/l.js (got ${dist})`);
    }
  }

  /** The bytes of `/call-widget/<name>` or `/widget/<path>`, or null (404). */
  async get(urlPath: string): Promise<Buffer | null> {
    const rel = path.posix.normalize(urlPath);
    if (rel.startsWith('/call-widget/')) {
      const name = rel.slice('/call-widget/'.length);
      if (this.mode === 'built') return readIf(path.join(this.dist!, 'call-widget', name));
      const file = path.join(PUBLIC, 'call-widget', name);
      if (!existsSync(file) || !file.startsWith(path.join(PUBLIC, 'call-widget'))) return null;
      if (this.mode === 'source' || !/^[^/]+\.(js|css)$/.test(name)) return readFileSync(file);
      const key = `${this.brand}:${name}`;
      if (!this.cache.has(key)) {
        const t = await shippedTransform();
        this.cache.set(key, Buffer.from(String(t(name, readFileSync(file), BRAND_INFO[this.brand].build)), 'utf8'));
      }
      return this.cache.get(key)!;
    }
    if (rel.startsWith('/widget/') || rel.startsWith('/brand/')) {
      if (this.mode === 'built' && rel.startsWith('/widget/')) {
        const built = readIf(path.join(this.dist!, rel));
        if (built) return built;
      }
      const file = path.join(PUBLIC, rel);
      return file.startsWith(PUBLIC) ? readIf(file) : null;
    }
    return null;
  }

  /** Whether the loader this mode serves has the panel hook (`loadPanel`, contract §4). */
  async loaderHasPanelHook(): Promise<boolean> {
    const l = await this.get('/call-widget/l.js');
    return !!l && l.toString('utf8').includes('loadPanel');
  }
}
function readIf(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null;
}

function hostPage(brand: Brand, canvas: string, prelude: string[]): string {
  const info = BRAND_INFO[brand];
  const pre = prelude.map((src) => `<script src="${src}"></script>`).join('');
  return `<!doctype html><html lang="${info.locale}" dir="${info.dir}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Nilufar Store</title>'
    + `<style>html,body{margin:0;min-height:100%;background:${canvas}}</style></head><body>${pre}`
    + `<script async src="${WIDGET_ORIGIN}/call-widget/l.js" workspace-id="${WORKSPACE_ID}"></script></body></html>`;
}

export const CORS = {
  'access-control-allow-origin': SITE_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-cc-session, x-cc-active-call',
  'cache-control': 'no-store',
};

/** The root classes of the boards' launcher components (01 L1–L9, 03 Se–Sh). */
const LAUNCHER_ROOTS = ['ln-cl', 'ln-f', 'ln-c', 'ln-p', 'ln-r', 'ln-s', 'ln-t', 'ln-q', 'mbar', 'mc', 'mvid', 'sched'] as const;

// ─── Live renderer ───────────────────────────────────────────────────────
export class LiveRenderer {
  private readonly assets: AssetServer;

  constructor(private readonly browser: Browser, readonly opts: LiveOptions) {
    this.assets = new AssetServer(opts.mode || 'source', opts.brand, opts.dist);
  }

  /** The bootstrap a state is served, with a --matrix run's accent and radius. */
  bootstrapFor(state: CallState, headerLogo: boolean): JsonObject {
    let boot = baseBootstrap(this.opts.brand);
    if (state.live.boot) boot = mergeJson(boot, state.live.boot);
    const theme: JsonObject = {};
    if (this.opts.accent) theme.primary = this.opts.accent;
    if (this.opts.radius && this.opts.radius !== 'md') theme.radius = this.opts.radius;
    if (Object.keys(theme).length) boot = mergeJson(boot, { config: { widget_theme: theme } });
    if (headerLogo) boot = mergeJson(boot, { config: { avatar_url: MEDIA.headerLogo } });
    return boot;
  }

  /**
   * Boots the widget on a fresh page and drives it into `state`. With `ref`
   * (P/M/C), shoots the crop that matches the reference; G states return
   * their geometry; a state whose screen or launcher the renderer has not
   * built yet returns `pending`.
   */
  async shoot(state: CallState, ref?: RefShot, feeds?: FeedFrames): Promise<LiveShot> {
    const { brand } = this.opts;
    const info = BRAND_INFO[brand];
    const mobile = !!state.live.mobile;
    const result: LiveShot = { state: state.id, status: 'error', masks: [], probes: {}, foreign: [], errors: [], requests: [] };
    const context: BrowserContext = await this.browser.newContext({
      viewport: state.live.viewport || (mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT),
      deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
      locale: info.contextLocale, timezoneId: info.timezoneId,
      reducedMotion: this.opts.motionAt === undefined ? 'reduce' : 'no-preference',
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(NAME_SHIM);
      page.on('pageerror', (e) => result.errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') result.errors.push(`console.error: ${m.text()}`); });
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { left: 0, right: 0, ...SAFE_AREA } } as never);
      }
      await page.clock.setFixedTime(frozenNow(brand));
      const boot = this.bootstrapFor(state, !!(state.live.headerLogo && ref?.headerLogo));
      const prelude: string[] = [];
      // --source without the loader's panel hook (contract §8.1): the module must already be on the page.
      if ((this.opts.mode || 'source') !== 'built' && !(await this.assets.loaderHasPanelHook())
        && existsSync(path.join(PUBLIC, 'call-widget/presentation-default-panel.js'))) {
        prelude.push(`${WIDGET_ORIGIN}/call-widget/presentation-default-panel.js`);
      }
      await page.route('**/*', (route) => this.serve(route, state, boot, ref, result, prelude));
      await page.goto(`${SITE_ORIGIN}/`);
      await page.waitForFunction(() => {
        const w = window as unknown as { CallCenterWidget?: { root?: unknown } };
        const host = document.getElementById('call-center-widget-host');
        return !!(w.CallCenterWidget && w.CallCenterWidget.root && host && getComputedStyle(host).display !== 'none');
      }, undefined, { timeout: 15_000 });
      if (state.live.shotOffset && !mobile) {
        await page.evaluate((px) => {
          const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
          const st = document.createElement('style');
          st.setAttribute('data-qa', 'offsets');
          st.textContent = `.ccw-root{--ccw-offset-x:${px}px;--ccw-offset-y:${px}px}`;
          sr.appendChild(st);
        }, SHOT_OFFSET);
      }
      if (state.live.media) await attachFakeMedia(page, state.live.media, feeds, state.live.feed || 'desktop');
      for (const step of state.live.steps || []) await page.evaluate(applyStep, step as Record<string, unknown>);
      const want = state.live.open;
      await page.evaluate((open) => {
        const c = (window as unknown as { CallCenterWidget: { open: boolean; toggleOpen: () => void } }).CallCenterWidget;
        if (!!c.open !== open) c.toggleOpen();
      }, want);
      if (want) {
        const opened = await page.waitForFunction(() => {
          const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
          return !!sr?.querySelector('.ccw-root.ccw-is-open');
        }, undefined, { timeout: 8_000 }).then(() => true, () => false);
        if (!opened) return { ...result, status: 'pending', reason: 'the panel did not open (.ccw-root.ccw-is-open)' };
      }
      // A launcher anchored to the right and bottom edges starts wherever its
      // width ends: put its top-left on whole CSS pixels (as the reference
      // puts its component), before any hover moves it; a minimised bar after
      // the settle below.
      const align = state.kind === 'C' && state.live.shotOffset && !mobile && state.anchor
        ? () => page.evaluate(alignLauncher, { anchor: state.anchor!, px: SHOT_OFFSET }) : null;
      if (align && !want) await align();
      for (const a of state.live.actions || []) {
        const err = await runAction(page, a);
        if (err) {
          const pend = await this.pendingReason(page, state);
          return pend ? { ...result, status: 'pending', reason: pend } : { ...result, status: 'error', reason: err };
        }
      }
      await settle(page, !!state.live.keepFocus, this.opts.motionAt);
      // A minimised bar: once the panel's fade is over and nothing moves any more.
      if (align && want) await align();
      const pending = await this.pendingReason(page, state);
      if (pending) return { ...result, status: 'pending', reason: pending };
      if (this.opts.review) {
        const screens = [await page.screenshot({ animations: 'allow', caret: 'hide' })];
        if (state.kind === 'G') {
          await page.evaluate(() => {
            const c = (window as unknown as { CallCenterWidget: { open: boolean; toggleOpen: () => void } }).CallCenterWidget;
            if (!c.open) c.toggleOpen();
          });
          await page.waitForFunction(() => !!document.getElementById('call-center-widget-host')?.shadowRoot?.querySelector('.ccw-root.ccw-is-open'),
            undefined, { timeout: 8_000 }).catch(() => undefined);
          await settle(page, false, this.opts.motionAt);
          screens.push(await page.screenshot({ animations: 'allow', caret: 'hide' }));
        }
        return { ...result, status: 'review', screens };
      }
      if (state.kind === 'G') return { ...result, status: 'geometry', geometry: await measureGeometry(page, state) };
      if (!ref) return { ...result, status: 'error', reason: 'no reference shot' };
      return await this.capture(page, state, ref, result);
    } catch (e) {
      return { ...result, status: 'error', reason: e instanceof Error ? e.message.split('\n')[0] : String(e) };
    } finally {
      await context.close();
    }
  }

  private async serve(route: Route, state: CallState, boot: JsonObject, ref: RefShot | undefined, result: LiveShot, prelude: string[]): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === SITE_ORIGIN) {
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostPage(this.opts.brand, ref?.canvas || '#ffffff', prelude) });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.origin !== WIDGET_ORIGIN) {
      result.foreign.push(req.url());
      return route.abort();
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    result.requests.push(url.pathname + url.search);
    const json = (body: unknown) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/api/call-widget/bootstrap') return json(boot);
    if (p === `/api/call-widget/calls/${CALL_ID}/status`) return json(state.live.status || {});
    if (p.startsWith('/api/')) return json({});
    if (p === new URL(MEDIA.businessLogo).pathname) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/svg+xml' }, body: LOGO_SVG });
    if (p === new URL(MEDIA.operatorPhoto).pathname) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/svg+xml' }, body: PHOTO_SVG });
    if (p === new URL(MEDIA.headerLogo).pathname && ref?.headerLogo) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: ref.headerLogo });
    const bytes = await this.assets.get(p);
    if (!bytes) return route.fulfill({ status: 404, headers: CORS, body: '' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': typeOf(p) }, body: bytes });
  }

  /** Why a state cannot be compared yet (its screen or launcher is not built), or null. */
  private async pendingReason(page: Page, state: CallState): Promise<string | null> {
    return page.evaluate(({ kind, screen, root, geometry, LAUNCHER_ROOTS }) => {
      const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
      if (!sr) return 'no widget host';
      const shown = (el: Element | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      if (kind === 'M' && !sr.querySelector('.ccw-root.is-mobile')) return 'phone layout not built (.ccw-root.is-mobile)';
      if (kind === 'M' && screen) {
        // The phone's sheet and full-screen panels span the screen's width.
        const panel = sr.querySelector('.ccw-panel');
        if (!panel || panel.getBoundingClientRect().width < innerWidth - 0.5) return 'phone layout not built (the panel does not span the screen)';
      }
      if ((kind === 'P' || kind === 'M') && screen) {
        const scr = sr.querySelector(`.ccw-panel .scr.on[data-screen="${screen}"]`);
        if (!scr) return `screen "${screen}" not shown (.ccw-panel .scr.on[data-screen])`;
        if (!scr.firstElementChild) return `screen "${screen}" not built yet (empty)`;
      }
      // The board's component is the launcher itself, not a part of another style (a round button inside a label launcher).
      const nestedIn = (el: Element, own: string) => {
        for (let p = el.parentElement; p && !p.classList.contains('ccw-launcher-wrap'); p = p.parentElement) {
          const other = LAUNCHER_ROOTS.find((c) => c !== own && p!.classList.contains(c));
          if (other) return other;
        }
        return null;
      };
      if (root) {
        const el = sr.querySelector(`.ccw-launcher-wrap .${root}`);
        if (!shown(el)) return `launcher .${root} not drawn`;
        const other = nestedIn(el!, root);
        if (other) return `launcher .${root} drawn inside .${other} (style not built yet)`;
      }
      if (geometry) {
        const wrap = sr.querySelector('.ccw-launcher-wrap');
        const missing = geometry.wrapClasses.filter((c: string) => !wrap?.classList.contains(c));
        if (missing.length) return `placement classes missing on the wrap: ${missing.join(', ')}`;
        const el = sr.querySelector(`.ccw-launcher-wrap ${geometry.launcher}`);
        if (!shown(el)) return `launcher ${geometry.launcher} not drawn`;
        // A placement is measured on its own style's launcher, not on the same class inside another style.
        const own = geometry.launcher.replace(/^\./, '');
        const other = LAUNCHER_ROOTS.includes(own) ? nestedIn(el!, own) : null;
        if (other) return `launcher ${geometry.launcher} drawn inside .${other} (style not built yet)`;
      }
      return null;
    }, { kind: state.kind, screen: state.screen || '', root: state.root || '', geometry: state.geometry || null, LAUNCHER_ROOTS: [...LAUNCHER_ROOTS] as string[] });
  }

  private async capture(page: Page, state: CallState, ref: RefShot, result: LiveShot): Promise<LiveShot> {
    const where = await page.evaluate(measureLive, {
      kind: state.kind, screen: state.screen || '', anchor: state.anchor || '', pad: PANEL_PAD,
      refSize: { width: ref.width, height: ref.height }, refAnchor: ref.anchor || null,
      masks: [...(state.masks || []), ...(state.liveMasks || [])].map((m) => m.sel),
      probes: state.kind === 'C' ? [] : [...(state.kind === 'M' ? PHONE_PROBES : PANEL_PROBES)],
    });
    if ('error' in where) return { ...result, status: 'error', reason: where.error };
    const viewport = page.viewportSize()!;
    const c = where.clip;
    if (c.x < 0 || c.y < 0 || c.x + c.width > viewport.width + 0.01 || c.y + c.height > viewport.height + 0.01) {
      return { ...result, status: 'error', reason: `crop ${JSON.stringify(c)} leaves the ${viewport.width}×${viewport.height} viewport` };
    }
    const png = await page.screenshot({ clip: c, animations: 'allow', caret: 'hide' });
    const why = new Map([...(state.masks || []), ...(state.liveMasks || [])].map((m) => [m.sel, m.why]));
    return {
      ...result, status: 'shot', png, width: c.width, height: c.height, probes: where.probes,
      masks: where.masks.map((m) => ({ ...m.box, why: why.get(m.sel) || m.sel })),
    };
  }
}

// ─── In-page helpers (serialized by page.evaluate) ───────────────────────

/**
 * Nudges the shot offsets (the only thing the harness changes in the product)
 * by the fraction of a pixel that puts the launcher's anchor on whole CSS
 * pixels, so its text and edges anti-alias as the reference's do. Then the
 * launcher is painted afresh: it was first painted at production's offsets,
 * and a composited fixed layer that only moves keeps the sub-pixel phase of
 * its first paint (text drawn from a fractional start would differ by
 * anti-aliasing alone).
 */
async function alignLauncher(args: { anchor: string; px: number }): Promise<void> {
  const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
  const st = sr.querySelector('style[data-qa="offsets"]');
  if (!st) return;
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let ox = args.px;
  let oy = args.px;
  const offsets = () => `.ccw-root{--ccw-offset-x:${ox}px;--ccw-offset-y:${oy}px}`;
  // Until the anchor sits on whole pixels and stays there (a bar's words may still change its width).
  for (let i = 0, last = ''; i < 8; i++) {
    const a = sr.querySelector(`.ccw-launcher-wrap ${args.anchor}`);
    if (!a) return;
    const r = a.getBoundingClientRect();
    const fx = r.left - Math.floor(r.left);
    const fy = r.top - Math.floor(r.top);
    const key = `${r.left} ${r.top} ${r.width} ${r.height}`;
    if (fx < 0.001 && fy < 0.001 && key === last) break;
    last = key;
    // Right and bottom anchored: a larger offset moves it left and up.
    if (fx >= 0.001) ox += fx;
    if (fy >= 0.001) oy += fy;
    st.textContent = offsets();
    await frames();
  }
  st.textContent = `${offsets()}.ccw-launcher-wrap{visibility:hidden!important}`;
  await frames();
  st.textContent = offsets();
  await frames();
}

/** Assigns one step of controller fields (formData merges; $ago and $t resolve here), then renders. */
export function applyStep(step: Record<string, unknown>): void {
  const c = (window as unknown as { CallCenterWidget: Record<string, unknown> & { render: () => void; t: (k: string) => string } }).CallCenterWidget;
  const resolve = (v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o.$ago === 'number') return Date.now() - o.$ago;
      if (typeof o.$t === 'string') return c.t(o.$t);
    }
    return v;
  };
  for (const [k, v] of Object.entries(step)) {
    if (k === 'formData' && v && typeof v === 'object') Object.assign(c.formData as object, v);
    else c[k] = resolve(v);
  }
  c.render();
}

/** Real `<video>`/`<audio>` elements fed by canvas streams of the reference's own pictures. */
export async function attachFakeMedia(page: Page, media: 'voice' | 'video', feeds: FeedFrames | undefined, feed: 'desktop' | 'mobile' | 'mvid'): Promise<void> {
  if (media === 'video' && !feeds) throw new Error('video states need the reference feed frames');
  await page.evaluate(async ({ video, remote, self }) => {
    const c = (window as unknown as { CallCenterWidget: Record<string, unknown> }).CallCenterWidget;
    const fromPng = async (b64: string, sid: string, local: boolean) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const cx = cv.getContext('2d')!;
      const draw = () => cx.drawImage(bmp, 0, 0);
      draw();
      const stream = cv.captureStream(30);
      setInterval(draw, 100);
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.setAttribute('data-track-sid', sid);
      v.srcObject = stream;
      v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
      if (local) v.setAttribute('data-qa-local', '');
      await v.play().catch(() => undefined);
      return v;
    };
    const audio = document.createElement('audio');
    audio.setAttribute('data-track-sid', 'TR_audio_harness');
    const tracks: Record<string, HTMLMediaElement> = { TR_audio_harness: audio };
    if (video) {
      tracks.TR_video_harness = await fromPng(remote!, 'TR_video_harness', false);
      c._localVideoEl = await fromPng(self!, 'TR_local_harness', true);
    }
    c._attachedTracks = tracks;
  }, {
    video: media === 'video',
    remote: media === 'video' ? feeds![feed].toString('base64') : null,
    // The phone's self-view is its own picture (board 11's pip is larger, its person is not scaled).
    self: media === 'video' ? feeds![feed === 'mobile' ? 'selfMobile' : 'self'].toString('base64') : null,
  });
}

/** One fixture action; returns an error message or null. */
export async function runAction(page: Page, a: { do: string; sel?: string; nth?: number; method?: string; ifUnchecked?: boolean; optional?: boolean }): Promise<string | null> {
  if (a.do === 'call') {
    const ok = await page.evaluate((m) => {
      const c = (window as unknown as { CallCenterWidget: Record<string, unknown> }).CallCenterWidget;
      if (typeof c[m] !== 'function') return false;
      (c[m] as () => void).call(c);
      return true;
    }, a.method || '');
    return ok ? null : `controller.${a.method} is not a function`;
  }
  const host = page.locator('#call-center-widget-host');
  const loc = host.locator(a.sel || '').nth(a.nth || 0);
  if (!(await loc.count())) return a.optional ? null : `action ${a.do}: ${a.sel} not found`;
  if (a.ifUnchecked) {
    const on = await loc.evaluate((el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true');
    if (on) return null;
  }
  try {
    if (a.do === 'click') await loc.click({ timeout: 3_000 });
    else if (a.do === 'hover') await loc.hover({ timeout: 3_000 });
    else if (a.do === 'focus') await loc.focus({ timeout: 3_000 });
  } catch (e) {
    return a.optional ? null : `action ${a.do} ${a.sel}: ${e instanceof Error ? e.message.split('\n')[0] : e}`;
  }
  await page.waitForTimeout(120);
  return null;
}

/** Fonts, images and videos ready; the auto-focus blurred unless the state keeps it; animations seeked in a motion run. */
async function settle(page: Page, keepFocus: boolean, motionAt?: number): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => {
    const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
    if (!sr) return true;
    const imgs = [...sr.querySelectorAll('img')].every((i) => i.complete);
    const vids = [...sr.querySelectorAll('video')].every((v) => v.readyState >= 2);
    return imgs && vids;
  }, undefined, { timeout: 5_000 }).catch(() => undefined);
  if (!keepFocus) {
    await page.evaluate(() => {
      const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
      const a = sr?.activeElement as HTMLElement | null;
      if (a && typeof a.blur === 'function') a.blur();
    });
  }
  await page.waitForTimeout(400);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (motionAt !== undefined) await seekAnimations(page, motionAt);
}

interface LiveMeasureArgs {
  kind: string; screen: string; anchor: string; pad: number;
  refSize: { width: number; height: number };
  refAnchor: { dx: number; dy: number; width: number; height: number } | null;
  masks: string[]; probes: string[];
}
type LiveMeasured = { error: string } | {
  clip: { x: number; y: number; width: number; height: number };
  masks: Array<{ sel: string; box: { x: number; y: number; width: number; height: number } }>;
  probes: Record<string, Array<{ x: number; y: number; width: number; height: number }>>;
};

function measureLive(args: LiveMeasureArgs): LiveMeasured {
  const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
  const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let e: Element | null = el; e; e = e.parentElement || ((e.getRootNode() as ShadowRoot).host ?? null)) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (e === document.documentElement) break;
    }
    return true;
  };
  const snap = (v: number) => Math.round(v * 2) / 2;
  let clip: { x: number; y: number; width: number; height: number };
  let scope: ParentNode = sr;
  let origin = { x: 0, y: 0 };
  if (args.kind === 'C') {
    const wrap = sr.querySelector('.ccw-launcher-wrap');
    const a = wrap?.querySelector(args.anchor);
    if (!a || !args.refAnchor) return { error: `anchor ${args.anchor} not found in the launcher` };
    const r = rectOf(a);
    clip = { x: snap(r.x + args.refAnchor.dx), y: snap(r.y + args.refAnchor.dy), width: args.refSize.width, height: args.refSize.height };
    scope = wrap!;
  } else if (args.kind === 'M') {
    clip = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    scope = sr;
  } else {
    const panel = sr.querySelector('.ccw-panel');
    if (!panel) return { error: 'no .ccw-panel' };
    const r = rectOf(panel);
    origin = { x: r.x, y: r.y };
    clip = { x: snap(r.x - args.pad), y: snap(r.y - args.pad), width: args.refSize.width, height: args.refSize.height };
    scope = sr.querySelector(`.ccw-panel .scr.on[data-screen="${args.screen}"]`) || panel;
  }
  const rel = (b: { x: number; y: number; width: number; height: number }, o: { x: number; y: number }) => ({ x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height });
  const masks: Array<{ sel: string; box: { x: number; y: number; width: number; height: number } }> = [];
  for (const sel of args.masks) {
    // `<sel> ::text`: only the element's text line (its contents' box, 2px around), not the element (fixture CallState.masks).
    const text = sel.endsWith(' ::text');
    for (const el of scope.querySelectorAll(text ? sel.slice(0, -7) : sel)) {
      if (!visible(el)) continue;
      let box = rectOf(el);
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        box = { x: t.left - 2, y: t.top - 2, width: t.width + 4, height: t.height + 4 };
      }
      masks.push({ sel, box: rel(box, clip) });
    }
  }
  const probes: Record<string, Array<{ x: number; y: number; width: number; height: number }>> = {};
  const probeScope: ParentNode = args.kind === 'M' ? sr : scope;
  for (const sel of args.probes) {
    probes[sel] = [...probeScope.querySelectorAll(sel)].filter(visible).map((el) => rel(rectOf(el), origin));
  }
  return { clip, masks, probes };
}

/** Placement checks of a G state (contract §8.2: offsets 22/20, edge, centre, origin per corner). */
async function measureGeometry(page: Page, state: CallState): Promise<GeometryResult> {
  const g = state.geometry!;
  const m = await page.evaluate((launcher) => {
    const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
    const el = sr.querySelector(`.ccw-launcher-wrap ${launcher}`)!;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, width: r.width, vw: innerWidth, vh: innerHeight };
  }, g.launcher);
  const failures: string[] = [];
  const near = (name: string, got: number, want: number) => { if (Math.abs(got - want) > TIER_A.boxTolerance) failures.push(`${name} ${got.toFixed(2)} (expected ${want})`); };
  const e = g.expect;
  if (e.right !== undefined) near('right', m.right, e.right);
  if (e.left !== undefined) near('left', m.left, e.left);
  if (e.bottom !== undefined) near('bottom', m.bottom, e.bottom);
  if (e.top !== undefined) near('top', m.top, e.top);
  if (e.centerX) near('centre offset', m.left + m.width / 2 - m.vw / 2, 0);
  if (e.middleY) near('top (50% − 80px)', m.top, m.vh / 2 - 80);
  if (e.fullWidth) { near('left', m.left, 0); near('right', m.right, 0); }
  const measured: Record<string, number | string> = { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
  if (g.origin) {
    await page.evaluate(() => (window as unknown as { CallCenterWidget: { toggleOpen: () => void } }).CallCenterWidget.toggleOpen());
    const o = await page.waitForFunction(() => {
      const sr = document.getElementById('call-center-widget-host')!.shadowRoot!;
      if (!sr.querySelector('.ccw-root.ccw-is-open')) return null;
      const p = sr.querySelector('.ccw-panel') as HTMLElement;
      const [x, y] = getComputedStyle(p).transformOrigin.split(' ').map(parseFloat);
      // Reduced motion: the open transform applies at once (only opacity fades), so the box is final.
      const r = p.getBoundingClientRect();
      return { x, y, w: p.offsetWidth, h: p.offsetHeight, left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, vw: innerWidth, vh: innerHeight };
    }, undefined, { timeout: 8_000 }).then((h) => h.jsonValue(), () => null);
    if (!o) failures.push('the panel did not open');
    else {
      measured.origin = `${o.x}px ${o.y}px of ${o.w}×${o.h}`;
      near('origin x', o.x, g.origin[0] * o.w);
      near('origin y', o.y, g.origin[1] * o.h);
      const pe = g.panel;
      if (pe) {
        measured.panel = `left ${o.left} top ${o.top} right ${o.right} bottom ${o.bottom}`;
        near('panel width', o.w, 400);
        near('panel height', o.h, 660);
        if (pe.right !== undefined) near('panel right', o.right, pe.right);
        if (pe.left !== undefined) near('panel left', o.left, pe.left);
        if (pe.bottom !== undefined) near('panel bottom', o.bottom, pe.bottom);
        if (pe.top !== undefined) near('panel top', o.top, pe.top);
        if (pe.centerX) near('panel centre offset', o.left + o.w / 2 - o.vw / 2, 0);
        if (pe.edgeTop) near('panel top (max(20px, 50% − 330px))', o.top, Math.max(20, o.vh / 2 - 330));
      }
    }
  }
  return { ok: failures.length === 0, failures, measured };
}

// ─── Comparison ──────────────────────────────────────────────────────────
export type Verdict = 'pass' | 'review' | 'fail' | 'pending' | 'error' | 'geometry-pass' | 'geometry-fail' | 'review-only';

export interface StateResult {
  id: string;
  panel: string;
  kind: CallState['kind'];
  verdict: Verdict;
  share?: number;
  diff?: string;
  probeFailures?: string[];
  reason?: string;
  due: CallState['due'];
  errors?: string[];
  files?: string[];
}

export interface Report {
  brand: Brand;
  mode: Mode;
  accent: string | null;
  radius: Radius | null;
  results: StateResult[];
  /** Foreign requests over the whole run (must stay empty). */
  foreign: string[];
}

export interface CompareOptions extends LiveOptions {
  /** State ids (default: every state). */
  states?: string[];
  /** Write PNGs and report.json here (default: nothing written). */
  out?: string;
  handoff?: string;
  /** A full handoff package (with screens/panels): Tier B sheets against the acceptance PNGs. */
  compareAcceptance?: string;
  chromiumPath?: string;
  browser?: Browser;
}

/** Box probes: same selectors, same count, rects within ±0.5px; a failure names the element and the delta. */
export function compareProbes(ref: Record<string, Box[]>, live: Record<string, Box[]>, tol: number = TIER_A.boxTolerance): string[] {
  const out: string[] = [];
  for (const sel of Object.keys(ref)) {
    const a = ref[sel] || [];
    const b = live[sel] || [];
    if (a.length !== b.length) { out.push(`${sel}: ${b.length} on the live side, ${a.length} on the reference`); continue; }
    a.forEach((r, i) => {
      const l = b[i];
      const d = { x: l.x - r.x, y: l.y - r.y, w: l.width - r.width, h: l.height - r.height };
      const bad = Object.entries(d).filter(([, v]) => Math.abs(v) > tol);
      if (bad.length) out.push(`${sel}${a.length > 1 ? `[${i}]` : ''} ${bad.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v.toFixed(1)}px`).join(', ')}`);
    });
  }
  return out;
}

const scaleRect = (b: Box, s: number): Rect => ({ x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s });

/** Tier A for one brand (and one accent/radius): reference + live + diff per state. */
export async function compareCallScreens(opts: CompareOptions): Promise<Report> {
  const browser = opts.browser || await chromium.launch({
    executablePath: resolveCallChromium(opts.chromiumPath),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const own = !opts.browser;
  const { brand } = opts;
  const all = callStates(brand);
  const wanted = opts.states ? all.filter((s) => opts.states!.includes(s.id)) : all;
  const unknown = (opts.states || []).filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown state(s): ${unknown.join(', ')}`);
  const report: Report = { brand, mode: opts.mode || 'source', accent: opts.accent || null, radius: opts.radius || null, results: [], foreign: [] };
  const suffix = `${opts.accent ? `--${opts.accent.replace('#', '').toLowerCase()}` : ''}${opts.radius ? `--${opts.radius}` : ''}`;
  const dir = opts.out ? path.join(path.resolve(opts.out), brand) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  try {
    const refR = new ReferenceRenderer(browser, brand, opts.handoff);
    const live = new LiveRenderer(browser, opts);
    const review = new LiveRenderer(browser, { ...opts, review: true });
    const differ = await PngDiffer.open(browser);
    const feeds = wanted.some((s) => s.live.media === 'video') ? await refR.exportFeeds() : undefined;
    for (const s of wanted) {
      const base: StateResult = { id: s.id, panel: s.panel, kind: s.kind, verdict: 'review-only', due: s.due };
      if (s.kind === 'R') {
        const files = dir && opts.compareAcceptance ? await tierBScreens(differ, review, opts.compareAcceptance, brand, s, feeds, dir) : [];
        report.results.push({ ...base, reason: s.note, files: files.length ? files : undefined });
        continue;
      }
      let ref: RefShot | undefined;
      if (PIXEL_KINDS.has(s.kind)) {
        try { ref = await refR.render(s, { accent: opts.accent, radius: opts.radius, motionAt: opts.motionAt, feeds }); }
        catch (e) { report.results.push({ ...base, verdict: 'error', reason: `reference: ${e instanceof Error ? e.message : e}` }); continue; }
      }
      const shot = await live.shoot(s, ref, feeds);
      report.foreign.push(...shot.foreign);
      const res: StateResult = { ...base, errors: shot.errors.length ? shot.errors : undefined };
      if (shot.status === 'pending' || shot.status === 'error') {
        report.results.push({ ...res, verdict: shot.status, reason: shot.reason });
        continue;
      }
      if (shot.status === 'geometry') {
        const g = shot.geometry!;
        const files = dir && opts.compareAcceptance ? await tierBScreens(differ, review, opts.compareAcceptance, brand, s, feeds, dir) : [];
        report.results.push({
          ...res, verdict: g.ok ? 'geometry-pass' : 'geometry-fail', reason: g.ok ? JSON.stringify(g.measured) : g.failures.join('; '),
          files: files.length ? files : undefined,
        });
        continue;
      }
      const masks = [...ref!.masks, ...shot.masks].map((m) => scaleRect(m, 2));
      const r: DiffResult = await differ.diff(ref!.png, shot.png!, { masks, heatmap: !!dir, threshold: TIER_A.channelThreshold });
      const probeFailures = compareProbes(ref!.probes, shot.probes);
      const verdict: Verdict = r.share > TIER_A.maxShare || !r.sizeMatch || probeFailures.length || shot.errors.length
        ? 'fail' : r.share >= TIER_A.reviewShare ? 'review' : 'pass';
      const files: string[] = [];
      if (dir) {
        const stem = path.join(dir, `${s.id}${suffix}`);
        writeFileSync(`${stem}.ref.png`, ref!.png);
        writeFileSync(`${stem}.live.png`, shot.png!);
        if (r.heatmap) writeFileSync(`${stem}.diff.png`, r.heatmap);
        files.push(`${stem}.ref.png`, `${stem}.live.png`, `${stem}.diff.png`);
        if (opts.compareAcceptance) files.push(...await tierB(differ, opts.compareAcceptance, brand, s, ref!, shot.png!, dir));
      }
      report.results.push({ ...res, verdict, share: r.share, diff: describeDiff(r), probeFailures: probeFailures.length ? probeFailures : undefined, files });
    }
    await differ.close();
  } finally {
    if (own) await browser.close();
  }
  if (dir) writeFileSync(path.join(dir, `report${suffix}.json`), JSON.stringify(report, null, 2));
  return report;
}

/** Tier B: the owner's acceptance PNG, the live shot and their heat map side by side. */
async function tierB(differ: PngDiffer, pkg: string, brand: Brand, s: CallState, ref: RefShot, live: Buffer, dir: string): Promise<string[]> {
  const file = path.join(path.resolve(pkg), brand, 'template-1-call-center/screens/panels', `${s.panel}.png`);
  if (!existsSync(file)) return [];
  const acceptance = readFileSync(file);
  // The acceptance PNG is the frame ± 24px: P crops are that already; M and C sit inside it.
  const cropA = s.kind === 'P' ? undefined : scaleRect({ x: ref.inFrame.x + PANEL_PAD, y: ref.inFrame.y + PANEL_PAD, width: ref.width, height: ref.height }, 2);
  const r = await differ.diff(acceptance, live, { cropA, heatmap: true });
  const out = path.join(dir, 'tier-b');
  mkdirSync(out, { recursive: true });
  const target = path.join(out, `${s.panel}.png`);
  const accepted = cropA ? await differ.crop(acceptance, cropA) : acceptance;
  writeFileSync(target, await differ.sheet([accepted, live, r.heatmap!], ['acceptance PNG', 'live', `heat map: ${(r.share * 100).toFixed(2)}%`]));
  return [target];
}

/** Width and height of a PNG (its IHDR chunk). */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Tier B of a G or R panel: the owner's PNG beside what the live widget
 * shows for the state, the whole screen scaled to the PNG's height (a
 * placement closed, then open). A specification sheet (board 12) stands
 * alone: its tokens are probed by callWidgetScreens.spec.ts and its
 * components are gated on the P screens that draw them.
 */
async function tierBScreens(differ: PngDiffer, review: LiveRenderer, pkg: string, brand: Brand, s: CallState, feeds: FeedFrames | undefined, dir: string): Promise<string[]> {
  const file = path.join(path.resolve(pkg), brand, 'template-1-call-center/screens/panels', `${s.panel}.png`);
  if (!existsSync(file)) return [];
  const acceptance = readFileSync(file);
  const images = [acceptance];
  const labels = [s.specSheet ? 'acceptance PNG (specification sheet: tokens probed, components on the P screens)' : 'acceptance PNG'];
  if (!s.specSheet) {
    const shot = await review.shoot(s, undefined, feeds);
    if (shot.status === 'review' && shot.screens) {
      shot.screens.forEach((png, i) => {
        images.push(png);
        labels.push(shot.screens!.length > 1 ? (i ? 'live, open' : 'live, closed') : 'live');
      });
    } else {
      labels[0] = `acceptance PNG (live: ${shot.status} ${shot.reason || ''})`;
    }
  }
  const out = path.join(dir, 'tier-b');
  mkdirSync(out, { recursive: true });
  const target = path.join(out, `${s.panel}.png`);
  writeFileSync(target, await differ.sheet(images, labels, { height: pngSize(acceptance).height }));
  return [target];
}

/** A scratch hashed build of one brand (scripts/call-widget-hash.js on a copy of public/call-widget). */
export function buildCallWidgetScratch(brand: Brand): { dist: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `call-screens-build-${brand}-`));
  cpSync(path.join(PUBLIC, 'call-widget'), path.join(dir, 'public/call-widget'), { recursive: true });
  cpSync(path.join(PUBLIC, 'call-widget'), path.join(dir, 'dist/call-widget'), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CALL_WIDGET_BUILD_ROOT: dir, VITE_BRAND: BRAND_INFO[brand].build };
  delete env.VITE_API_BASE_URL;
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/call-widget-hash.js')], { cwd: ROOT, env, stdio: 'pipe' });
  return { dist: path.join(dir, 'dist'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Summary line per state, for the CLI and the spec's messages. */
export function formatResult(r: StateResult): string {
  const share = r.share !== undefined ? ` ${(r.share * 100).toFixed(3)}%` : '';
  const extra = r.probeFailures ? ` probes: ${r.probeFailures.slice(0, 4).join(' | ')}` : '';
  const why = r.reason && r.verdict !== 'pass' ? ` (${r.reason})` : '';
  const errs = r.errors ? ` errors: ${r.errors.slice(0, 2).join(' | ')}` : '';
  return `${r.verdict.padEnd(13)} ${r.id}${share}${why}${extra}${errs}`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('harness', 'callScreens.ts')); } catch { return false; }
})();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const brands: Brand[] = args.brand === 'respok' ? ['respok'] : args.brand === 'webyar' ? ['webyar'] : ['webyar', 'respok'];
  if (args.list) {
    for (const b of brands) for (const s of callStates(b)) console.log(`${b} ${s.kind} ${s.id}  (${s.panel})`);
    return;
  }
  const mode: Mode = typeof args.built === 'string' ? 'built' : args.shipped ? 'shipped' : 'source';
  // Outside the checkout unless --out says otherwise (the PNGs are never committed).
  const out = typeof args.out === 'string' ? args.out : path.join(tmpdir(), 'call-screens-out');
  const browser = await chromium.launch({
    executablePath: resolveCallChromium(typeof args.chromium === 'string' ? args.chromium : undefined),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  let failed = false;
  try {
    for (const brand of brands) {
      const runs: Array<{ accent?: string; radius?: Radius }> = [{
        accent: typeof args.accent === 'string' ? args.accent : undefined,
        radius: typeof args.radius === 'string' ? args.radius as Radius : undefined,
      }];
      if (args.matrix) {
        for (const a of [...ACCENT_PRESETS[brand].slice(1), LIGHT_ACCENT]) runs.push({ accent: a });
        runs.push({ radius: 'sm' }, { radius: 'lg' });
      }
      for (const run of runs) {
        const report = await compareCallScreens({
          brand, mode, dist: typeof args.built === 'string' ? path.resolve(args.built) : undefined, ...run,
          states: typeof args.states === 'string' ? args.states.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
          out, handoff: typeof args.handoff === 'string' ? args.handoff : undefined,
          compareAcceptance: typeof args['compare-acceptance'] === 'string' ? args['compare-acceptance'] : undefined,
          motionAt: args.motion ? 1200 : undefined, browser,
        });
        console.log(`\n${brand} ${mode}${run.accent ? ` accent ${run.accent}` : ''}${run.radius ? ` radius ${run.radius}` : ''}`);
        for (const r of report.results) console.log(formatResult(r));
        if (report.foreign.length) console.log(`foreign requests: ${report.foreign.join(', ')}`);
        failed = failed || report.foreign.length > 0 || report.results.some((r) => ['fail', 'error', 'geometry-fail'].includes(r.verdict));
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
}

if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
