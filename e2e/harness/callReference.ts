/**
 * Re-renders the handoff's reference pages (docs/call-widget-handoff/<brand>/
 * template-1-call-center/reference/*.html) in Chromium at 2x and crops the
 * frame a fixture state names (e2e/harness/callScreensFixture.ts), so the
 * live widget is compared with a picture made by the same browser at the same
 * moment (contract D2, §8): no stored baselines, no drift across Chromium
 * versions.
 *
 * Two modes:
 *   - production (the Tier A target): production's fonts and every documented
 *     deviation (e2e/harness/callReferenceOverrides.css), board chrome hidden
 *     around the frame, accent and radius of a --matrix run applied inline;
 *     returns the crop, the masks, the box probes, the canvas colour the live
 *     page takes, and, for C kinds, where the crop sits relative to the
 *     element both sides align on;
 *   - pristine (reproduction of the acceptance PNGs, digest-infra §0.1): the
 *     design's own fonts from a full handoff package, nothing hidden, every
 *     frame cropped with its 24px board margin (exactly the PNGs' crops).
 *
 * The pages hold no script. Every request goes through page.route: the
 * handoff folder and repo/public/widget (fonts) are served from disk, the
 * rest is aborted.
 *
 *   npx tsx e2e/harness/callReference.ts --brand webyar --out /tmp/ref
 *   npx tsx e2e/harness/callReference.ts --brand respok --out /tmp/ref --reproduce <handoff package>
 */
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BRAND_INFO, COMPONENT_PAD, PANEL_PAD, PANEL_PROBES, PHONE_PROBES, callStates, onAccent, stageHoldK, stageTintK, INK,
  type Brand, type CallState, type Pads, type Radius,
} from './callScreensFixture';
import { PngDiffer, describeDiff } from './pngDiff';

const ROOT = process.cwd();
export const DEFAULT_HANDOFF = path.join(ROOT, 'docs/call-widget-handoff');
const REF_ORIGIN = 'https://ref.test';
const OVERRIDES = path.join(ROOT, 'e2e/harness/callReferenceOverrides.css');

/** A rectangle in CSS px. */
export interface Box { x: number; y: number; width: number; height: number }

export interface RefOptions {
  /** Handoff root (default docs/call-widget-handoff). */
  handoff?: string;
  /** Accent for a --matrix run (inline `--a`, `--on-a`, `--a-ink` for a light accent, Respok's `tint` + `--a-k` off Ink, WebYar's `hold` + `--a-k` above .195). */
  accent?: string;
  /** Radius for a --matrix run (`data-r` on `.cc`). */
  radius?: Radius;
  /** Keep animations and seek them all to this time (ms) instead of reduced motion. */
  motionAt?: number;
  /**
   * The exported feed frames (exportFeeds): a video state's illustrated feed and self-view are
   * replaced by the same pictures played through a real `<video>`, as on the live side (§8.3 #5),
   * so both go through the browser's video path (its colour conversion softens edges alike).
   */
  feeds?: FeedFrames;
}

export interface RefShot {
  state: string;
  png: Buffer;
  /** Crop size (CSS px); the PNG is twice that. */
  width: number;
  height: number;
  /** Masks, relative to the crop (CSS px), with their reasons. */
  masks: Array<Box & { why: string }>;
  /** P/M: rects of each probe selector relative to the panel (CSS px). */
  probes: Record<string, Box[]>;
  /** The colour the live page's background takes (the board canvas, the card, the mock page). */
  canvas: string;
  /** C: the crop's top-left relative to the anchor element's top-left, and the anchor's size. */
  anchor?: { dx: number; dy: number; width: number; height: number };
  /** WebYar P/M: the reference's header tile (the board's logo), served to the live widget as its avatar. */
  headerLogo?: Buffer;
  /** The crop's top-left relative to the frame's top-left (CSS px): where it sits in the acceptance PNG (frame ± 24). */
  inFrame: { x: number; y: number };
}

export interface FeedFrames {
  desktop: Buffer;
  mobile: Buffer;
  mvid: Buffer;
  /** The desktop self-view (98×136). */
  self: Buffer;
  /** The phone's self-view (board 11 draws it 108×150, its person at the same size: not a scaled `self`). */
  selfMobile: Buffer;
}

/** `window.__name` for functions esbuild (tsx) names; evaluated callbacks otherwise throw. */
export const NAME_SHIM = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json',
};
const contentType = (file: string) => CONTENT_TYPES[path.extname(file)] || 'application/octet-stream';

export function resolveCallChromium(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  for (const dir of ['/opt/pw-browsers', '/opt/ms-playwright']) {
    if (!existsSync(dir)) continue;
    for (const sub of readdirSafe(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const candidate = path.join(dir, sub, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Board chrome the production crops never contain: the caret stand-in (a real input's caret is hidden in screenshots). */
const BOARD_STANDINS = '.cc .caret::after{display:none!important}';
/** Component crops: the card behind the component becomes one flat colour. */
const FLAT_CSS = '.qa-flat{background:var(--qa-flat)!important;box-shadow:none!important;border-color:transparent!important;border-radius:0!important}'
  + '.qa-flat::before,.qa-flat::after,.qa-clear::before,.qa-clear::after{display:none!important}'
  + '.qa-clear{background:transparent!important;box-shadow:none!important}';
/** Feed export: the picture alone, without the product's vignette, the grain, or the panel's corners. */
/* Only the exported element and its ancestors lose their corners (the panel's, the feed's, the
   self-view's): the picture inside keeps its own rounded shapes. */
const EXPORT_CSS = '.qa-export-r{border-radius:0!important}.qa-export::after,.qa-export .feed::after{display:none!important}'
  + '.qa-export .pip .person{transform:none!important}.qa-export .pip .me-l{visibility:hidden!important}';

export class ReferenceRenderer {
  private context: BrowserContext | null = null;
  private readonly handoff: string;

  constructor(private readonly browser: Browser, readonly brand: Brand, handoff?: string) {
    this.handoff = path.resolve(handoff || DEFAULT_HANDOFF);
  }

  private refPath(file: string): string {
    return path.join(this.handoff, this.brand, 'template-1-call-center/reference', file);
  }

  /** A fresh context per page (motion settings and viewport differ by run). */
  private async open(file: string, opts: { pristine: boolean; motion: boolean }): Promise<Page> {
    if (!existsSync(this.refPath(file))) throw new Error(`reference page missing: ${this.refPath(file)}`);
    this.context = await this.browser.newContext({
      viewport: { width: 1800, height: 1400 }, deviceScaleFactor: 2,
      reducedMotion: opts.motion ? 'no-preference' : 'reduce',
      locale: BRAND_INFO[this.brand].contextLocale, timezoneId: BRAND_INFO[this.brand].timezoneId,
    });
    const page = await this.context.newPage();
    await page.addInitScript(NAME_SHIM);
    const handoff = this.handoff;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== REF_ORIGIN) return route.abort();
      const rel = decodeURIComponent(url.pathname);
      if (rel.startsWith('/widget/')) {
        const file = path.join(ROOT, 'public', path.normalize(rel));
        if (!file.startsWith(path.join(ROOT, 'public/widget')) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ status: 200, contentType: contentType(file), body: readFileSync(file) });
      }
      const file = path.join(handoff, path.normalize(rel));
      if (!file.startsWith(handoff) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
      // Production fonts replace the design's (§8.3 #1): the page's own @font-face sheet is emptied.
      if (!opts.pristine && rel.endsWith('/reference/css/fonts.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      return route.fulfill({ status: 200, contentType: contentType(file), body: readFileSync(file) });
    });
    await page.goto(`${REF_ORIGIN}/${this.brand}/template-1-call-center/reference/${file}`);
    if (!opts.pristine) {
      await page.evaluate(async (href) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        const loaded = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; });
        document.head.appendChild(link);
        await loaded;
      }, `${REF_ORIGIN}/widget/presentation-default-fonts.css`);
      await page.addStyleTag({ content: readFileSync(OVERRIDES, 'utf8') });
      await page.addStyleTag({ content: BOARD_STANDINS + FLAT_CSS + EXPORT_CSS });
    }
    // The page's size with its faces in: a frame at the page's foot is cropped where the page ends.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const full = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    await page.setViewportSize({ width: Math.max(1800, Math.ceil(full.w)), height: Math.max(1400, Math.ceil(full.h)) });
    return page;
  }

  private async closePage(): Promise<void> {
    if (this.context) await this.context.close();
    this.context = null;
  }

  private static async settle(page: Page, motionAt?: number): Promise<void> {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (motionAt !== undefined) await seekAnimations(page, motionAt);
  }

  /** The Tier A target of one fixture state (P, M or C). */
  async render(state: CallState, opts: RefOptions = {}): Promise<RefShot> {
    if (!['P', 'M', 'C'].includes(state.kind)) throw new Error(`${state.id}: kind ${state.kind} has no pixel target`);
    const page = await this.open(state.ref.page, { pristine: false, motion: opts.motionAt !== undefined });
    try {
      const accent = opts.accent ? { a: opts.accent, onA: onAccent(opts.accent) } : null;
      const prep = await page.evaluate(prepareFrame, {
        frame: state.ref.frame, index: state.ref.index, kind: state.kind,
        component: state.ref.component || null, addClass: state.ref.addClass || null,
        accent: accent ? {
          a: accent.a, onA: accent.onA, inkOnA: accent.onA === INK,
          tintK: stageTintK(this.brand, accent.a), holdK: stageHoldK(this.brand, accent.a),
        } : null,
        radius: opts.radius && opts.radius !== 'md' ? opts.radius : null,
      });
      if (opts.feeds && state.live.media === 'video') {
        const feed = state.live.feed || 'desktop';
        await page.evaluate(installFeeds, {
          remote: opts.feeds[feed].toString('base64'),
          self: feed === 'mvid' ? null : opts.feeds[feed === 'mobile' ? 'selfMobile' : 'self'].toString('base64'),
          target: feed === 'mvid' ? '.mvid .feed' : '.feed',
        });
      }
      // Both sides on the same pixel grid: the frame (or, for a component, its anchor) on whole CSS px.
      await page.evaluate(alignFrame, { kind: state.kind, anchor: state.anchor || null });
      if (state.ref.hover) {
        const box = await page.evaluate(markedRect, `[data-qa-frame] ${state.ref.hover}`);
        if (!box) throw new Error(`${state.id}: hover target ${state.ref.hover} missing`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // The hover lift scales the button; a 3D layer inside it (the logo's turned face) keeps
        // the raster of its first paint, drawn scaled (soft). Paint the frame afresh at the
        // hovered scale, as the live widget's launcher is (callScreens.ts alignLauncher).
        await page.evaluate(repaintFrame);
      }
      await ReferenceRenderer.settle(page, opts.motionAt);
      const geo = await page.evaluate(measureFrame, {
        kind: state.kind, anchor: state.anchor || null,
        pad: { top: COMPONENT_PAD, right: COMPONENT_PAD, bottom: COMPONENT_PAD, left: COMPONENT_PAD, ...(state.pad || {}) } as Pads,
        panelPad: PANEL_PAD,
        masks: (state.masks || []).map((m) => m.sel),
        probes: state.kind === 'C' ? [] : [...(state.kind === 'M' ? PHONE_PROBES : PANEL_PROBES)],
      });
      const png = await page.screenshot({ clip: geo.clip, animations: 'allow', caret: 'hide' });
      let headerLogo: Buffer | undefined;
      if (state.live.headerLogo && geo.logo) headerLogo = await page.screenshot({ clip: geo.logo, caret: 'hide' });
      const whyOf = new Map((state.masks || []).map((m) => [m.sel, m.why]));
      const masks = geo.masks.map((m) => ({ ...m.box, why: m.sel === '@corner' ? 'board chrome: the phone frame\'s rounded corner' : whyOf.get(m.sel) || m.sel }));
      return {
        state: state.id, png, width: geo.clip.width, height: geo.clip.height, masks, probes: geo.probes,
        canvas: prep.canvas, anchor: geo.anchor || undefined, headerLogo, inFrame: geo.inFrame,
      };
    } finally {
      await this.closePage();
    }
  }

  /** The reference's own video pictures, played by the live widget's fake `<video>` elements (§8.3 #5). */
  async exportFeeds(): Promise<FeedFrames> {
    const shot = async (file: string, frame: string, index: number, target: string): Promise<Buffer> => {
      const page = await this.open(file, { pristine: false, motion: false });
      try {
        const clip = await page.evaluate(prepareExport, { frame, index, target });
        await ReferenceRenderer.settle(page);
        return await page.screenshot({ clip, caret: 'hide' });
      } finally {
        await this.closePage();
      }
    };
    return {
      desktop: await shot('07-on-a-call.html', 'section.cp', 2, '.feed'),
      self: await shot('07-on-a-call.html', 'section.cp', 2, '.pip'),
      mobile: await shot('11-mobile.html', 'section.cp', 3, '.feed'),
      selfMobile: await shot('11-mobile.html', 'section.cp', 3, '.pip'),
      mvid: await shot('03-button-states-and-motion.html', '.stc', 6, '.mvid .feed'),
    };
  }

  /** Pristine crop of one frame with its 24px board margin: what the acceptance PNG shows. */
  async reproduce(state: CallState): Promise<Buffer> {
    const page = await this.open(state.ref.page, { pristine: true, motion: false });
    try {
      if (state.ref.addClass) {
        await page.evaluate(({ frame, index, addClass }) => {
          const all = [...document.querySelectorAll(frame)];
          const top = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
          top[index]?.querySelector(addClass[0])?.classList.add(addClass[1]);
        }, { frame: state.ref.frame, index: state.ref.index, addClass: state.ref.addClass });
      }
      await page.waitForTimeout(400);
      await ReferenceRenderer.settle(page);
      const clip = await page.evaluate(({ frame, index, pad }) => {
        const all = [...document.querySelectorAll(frame)];
        const top = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
        const r = top[index].getBoundingClientRect();
        return { x: r.left + scrollX - pad, y: r.top + scrollY - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
      }, { frame: state.ref.frame, index: state.ref.index, pad: PANEL_PAD });
      return await page.screenshot({ clip, caret: 'hide' });
    } finally {
      await this.closePage();
    }
  }
}

// ─── In-page helpers (serialized by page.evaluate: no outer references) ──

interface PrepArgs {
  frame: string; index: number; kind: string; component: string | null; addClass: [string, string] | null;
  accent: { a: string; onA: string; inkOnA: boolean; tintK: string | null; holdK: string | null } | null; radius: string | null;
}

/** Marks the frame, hides the board around it, applies accent/radius; returns the canvas colour for the live page. */
function prepareFrame(args: PrepArgs): { canvas: string } {
  const all = [...document.querySelectorAll(args.frame)];
  const frames = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  const frame = frames[args.index] as HTMLElement | undefined;
  if (!frame) throw new Error(`frame ${args.frame} #${args.index} not found (${frames.length})`);
  frame.setAttribute('data-qa-frame', '');
  for (const cc of document.querySelectorAll<HTMLElement>('.cc')) {
    if (args.accent) {
      cc.style.setProperty('--a', args.accent.a);
      cc.style.setProperty('--on-a', args.accent.onA);
      if (args.accent.inkOnA) cc.style.setProperty('--a-ink', 'var(--ink)');
      // Respok's stage in a colour other than Ink (callReferenceOverrides.css, owner 2026-10-19).
      if (args.accent.tintK) {
        cc.style.setProperty('--a-k', args.accent.tintK);
        cc.classList.add('tint');
      }
      // WebYar's stage held for a colour lighter than its lightest preset (callReferenceOverrides.css, §8.3 #12).
      if (args.accent.holdK) {
        cc.style.setProperty('--a-k', args.accent.holdK);
        cc.classList.add('hold');
      }
    }
    if (args.radius) cc.setAttribute('data-r', args.radius);
  }
  if (args.addClass) frame.querySelector(args.addClass[0])?.classList.add(args.addClass[1]);
  const hideAround = (target: Element, stop: Element | null) => {
    let el: Element | null = target;
    while (el && el !== stop && el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib !== el) (sib as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
      }
      el = el.parentElement;
    }
  };
  let canvas = getComputedStyle(frame.closest('.cc') || document.body).backgroundColor;
  if (args.kind === 'C') {
    const comp = args.component ? frame.querySelector(args.component) : null;
    if (!comp) throw new Error(`component ${args.component} not found in ${args.frame} #${args.index}`);
    comp.setAttribute('data-qa-comp', '');
    canvas = getComputedStyle(frame).backgroundColor;
    frame.style.setProperty('--qa-flat', canvas);
    frame.classList.add('qa-flat');
    for (let el = comp.parentElement; el && el !== frame; el = el.parentElement) el.classList.add('qa-clear');
    hideAround(comp, frame);
    hideAround(frame, null);
  } else {
    hideAround(frame, null);
    if (args.kind === 'M') {
      const mpage = frame.querySelector('.mpage') as HTMLElement | null;
      if (mpage) {
        canvas = getComputedStyle(mpage).backgroundColor;
        for (const c of mpage.children) (c as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
      }
      for (const c of frame.querySelectorAll<HTMLElement>('.notch, .homebar')) c.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  return { canvas };
}

/**
 * Moves the marked frame by less than a pixel (relative offset, no layout
 * change) so the element both sides align on starts on whole CSS pixels, as
 * the live panel and launchers do: otherwise every edge differs by
 * anti-aliasing alone.
 */
function alignFrame(args: { kind: string; anchor: string | null }): void {
  const frame = document.querySelector('[data-qa-frame]') as HTMLElement;
  let target: Element | null = frame;
  if (args.kind === 'C') {
    const comp = frame.querySelector('[data-qa-comp]');
    target = comp && args.anchor && !comp.matches(args.anchor) ? comp.querySelector(args.anchor) : comp;
  }
  if (!target) return;
  const r = target.getBoundingClientRect();
  const dx = Math.round(r.left) - r.left;
  const dy = Math.round(r.top) - r.top;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
  const cs = getComputedStyle(frame);
  if (cs.position === 'static') frame.style.position = 'relative';
  frame.style.left = `${(parseFloat(cs.left) || 0) + dx}px`;
  frame.style.top = `${(parseFloat(cs.top) || 0) + dy}px`;
}

/**
 * §8.3 #5 on the reference side: the marked frame's illustrated feed (and self-view, mirrored as
 * the live widget mirrors the local camera) become `<video>` elements playing the exported frames.
 */
async function installFeeds(args: { remote: string; self: string | null; target: string }): Promise<void> {
  const frame = document.querySelector('[data-qa-frame]') as HTMLElement;
  const video = async (b64: string, mirror: boolean): Promise<HTMLVideoElement> => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const cx = cv.getContext('2d')!;
    const draw = () => cx.drawImage(bmp, 0, 0);
    draw();
    setInterval(draw, 100);
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = cv.captureStream(30);
    v.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block${mirror ? ';transform:scaleX(-1)' : ''}`;
    await v.play().catch(() => undefined);
    return v;
  };
  const feed = frame.querySelector(args.target) as HTMLElement | null;
  if (feed) {
    for (const c of feed.children) (c as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
    feed.appendChild(await video(args.remote, false));
  }
  const pip = args.self ? frame.querySelector('.pip') as HTMLElement | null : null;
  if (pip && args.self) {
    for (const c of pip.querySelectorAll('.person')) (c as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
    pip.insertBefore(await video(args.self, true), pip.firstChild);
  }
  const vids = [...frame.querySelectorAll('video')];
  const end = Date.now() + 5000;
  while (vids.some((v) => v.readyState < 2) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
}

/** Hides the marked frame for two frames and shows it again: its layers are rasterised anew. */
async function repaintFrame(): Promise<void> {
  const frame = document.querySelector('[data-qa-frame]') as HTMLElement | null;
  if (!frame) return;
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  frame.style.visibility = 'hidden';
  await frames();
  frame.style.visibility = '';
  await frames();
}

interface MeasureArgs {
  kind: string; anchor: string | null; pad: { top: number; right: number; bottom: number; left: number };
  panelPad: number; masks: string[]; probes: string[];
}
interface Measured {
  clip: { x: number; y: number; width: number; height: number };
  masks: Array<{ sel: string; box: { x: number; y: number; width: number; height: number } }>;
  probes: Record<string, Array<{ x: number; y: number; width: number; height: number }>>;
  anchor: { dx: number; dy: number; width: number; height: number } | null;
  logo: { x: number; y: number; width: number; height: number } | null;
  inFrame: { x: number; y: number };
}

/** Crop, masks, probes and the alignment anchor of the marked frame. */
function measureFrame(args: MeasureArgs): Measured {
  const frame = document.querySelector('[data-qa-frame]') as HTMLElement;
  const page = (r: DOMRect) => ({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height });
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  };
  const fr = page(frame.getBoundingClientRect());
  let clip: Measured['clip'];
  let anchor: Measured['anchor'] = null;
  if (args.kind === 'C') {
    const comp = frame.querySelector('[data-qa-comp]') as HTMLElement;
    const c = page(comp.getBoundingClientRect());
    // Margins never reach past the card (its edge, border and rounded corner are chrome).
    const room = {
      top: c.y - fr.y - 1, right: fr.x + fr.width - (c.x + c.width) - 1,
      bottom: fr.y + fr.height - (c.y + c.height) - 1, left: c.x - fr.x - 1,
    };
    const p = {
      top: Math.max(0, Math.min(args.pad.top, room.top)), right: Math.max(0, Math.min(args.pad.right, room.right)),
      bottom: Math.max(0, Math.min(args.pad.bottom, room.bottom)), left: Math.max(0, Math.min(args.pad.left, room.left)),
    };
    clip = { x: c.x - p.left, y: c.y - p.top, width: c.width + p.left + p.right, height: c.height + p.top + p.bottom };
    const a = args.anchor ? (comp.matches(args.anchor) ? comp : comp.querySelector(args.anchor)) : comp;
    if (!a) throw new Error(`anchor ${args.anchor} not found`);
    const ar = page(a.getBoundingClientRect());
    anchor = { dx: clip.x - ar.x, dy: clip.y - ar.y, width: ar.width, height: ar.height };
  } else if (args.kind === 'M') {
    clip = { ...fr };
  } else {
    clip = { x: fr.x - args.panelPad, y: fr.y - args.panelPad, width: fr.width + args.panelPad * 2, height: fr.height + args.panelPad * 2 };
  }
  // Whole device pixels (2x): both sides crop on the same grid.
  const snap = (v: number) => Math.round(v * 2) / 2;
  clip = { x: snap(clip.x), y: snap(clip.y), width: snap(clip.width), height: snap(clip.height) };
  if (anchor) anchor = { ...anchor, dx: snap(anchor.dx), dy: snap(anchor.dy) };
  const rel = (b: { x: number; y: number; width: number; height: number }, o: { x: number; y: number }) => ({ x: b.x - o.x, y: b.y - o.y, width: b.width, height: b.height });
  const masks: Measured['masks'] = [];
  for (const sel of args.masks) {
    // `<sel> ::text`: only the element's text line (its contents' box, 2px around), not the element (fixture CallState.masks).
    const text = sel.endsWith(' ::text');
    for (const el of frame.querySelectorAll(text ? sel.slice(0, -7) : sel)) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      let box = page(r);
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = page(range.getBoundingClientRect());
        box = { x: t.x - 2, y: t.y - 2, width: t.width + 4, height: t.height + 4 };
      }
      masks.push({ sel, box: rel(box, clip) });
    }
  }
  if (args.kind === 'M') {
    const rad = parseFloat(getComputedStyle(frame).borderTopLeftRadius) || 0;
    if (rad > 0) {
      for (const [x, y] of [[0, 0], [fr.width - rad, 0], [0, fr.height - rad], [fr.width - rad, fr.height - rad]]) {
        masks.push({ sel: '@corner', box: { x, y, width: rad, height: rad } });
      }
    }
  }
  const probes: Measured['probes'] = {};
  for (const sel of args.probes) {
    probes[sel] = [...frame.querySelectorAll(sel)].filter(visible).map((el) => rel(page(el.getBoundingClientRect()), fr));
  }
  const lg = frame.querySelector('.hd .lg');
  const logo = lg && visible(lg) ? page(lg.getBoundingClientRect()) : null;
  return { clip, masks, probes, anchor, logo, inFrame: { x: clip.x - fr.x, y: clip.y - fr.y } };
}

/** The page rect of the first match of a selector (null when missing). */
function markedRect(sel: string): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Isolates one element of a frame for a feed export; returns its page rect. */
function prepareExport(args: { frame: string; index: number; target: string }): { x: number; y: number; width: number; height: number } {
  const all = [...document.querySelectorAll(args.frame)];
  const frames = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  const frame = frames[args.index] as HTMLElement;
  const target = frame.querySelector(args.target) as HTMLElement;
  if (!target) throw new Error(`export target ${args.target} missing`);
  frame.classList.add('qa-export');
  for (let up: Element | null = target; up && up !== frame.parentElement; up = up.parentElement) up.classList.add('qa-export-r');
  let el: Element | null = target;
  while (el && el.parentElement) {
    for (const sib of el.parentElement.children) if (sib !== el) (sib as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
    el = el.parentElement;
  }
  const r = target.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
}

/** Pauses every running animation (shadow trees included) at the same time. */
export async function seekAnimations(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => {
    // document.getAnimations() leaves out shadow trees: the widget's live there.
    const all = [...document.getAnimations()];
    for (const el of document.querySelectorAll('*')) if (el.shadowRoot) all.push(...el.shadowRoot.getAnimations());
    for (const a of all) { a.pause(); a.currentTime = t; }
  }, ms);
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
  try { return !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('harness', 'callReference.ts')); } catch { return false; }
})();

/**
 * --reproduce <package>: the pristine re-render of every frame against the
 * package's screens/panels PNGs (the reference must reproduce them, digest-
 * infra §0.1). Otherwise: the production-mode targets of the P/M/C states.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const brand = (args.brand === 'respok' ? 'respok' : 'webyar') as Brand;
  // Outside the checkout unless --out says otherwise (the PNGs are never committed).
  const out = path.resolve(typeof args.out === 'string' ? args.out : path.join(tmpdir(), 'call-reference-out'));
  mkdirSync(out, { recursive: true });
  const only = typeof args.states === 'string' ? new Set(args.states.split(',')) : null;
  const browser = await chromium.launch({ executablePath: resolveCallChromium(typeof args.chromium === 'string' ? args.chromium : undefined) });
  try {
    const states = callStates(brand).filter((s) => !only || only.has(s.id));
    if (typeof args.reproduce === 'string') {
      const pkg = path.resolve(args.reproduce);
      const renderer = new ReferenceRenderer(browser, brand, pkg);
      const differ = await PngDiffer.open(browser);
      const rows: Array<{ panel: string; share: number; text: string }> = [];
      for (const s of states) {
        const png = await renderer.reproduce(s);
        writeFileSync(path.join(out, `${s.panel}.ref.png`), png);
        const accepted = path.join(pkg, brand, 'template-1-call-center/screens/panels', `${s.panel}.png`);
        if (!existsSync(accepted)) { console.log(`-- ${s.panel}: no acceptance PNG`); continue; }
        const r = await differ.diff(readFileSync(accepted), png);
        rows.push({ panel: s.panel, share: r.share, text: describeDiff(r) });
        console.log(`${(r.share * 100).toFixed(2).padStart(6)}%  ${s.panel}  ${describeDiff(r)}`);
      }
      await differ.close();
      writeFileSync(path.join(out, 'reproduce.json'), JSON.stringify(rows, null, 2));
      const exact = rows.filter((r) => r.share < 0.0005).length;
      console.log(`${rows.length} panels, ${exact} under 0.05%, worst ${Math.max(...rows.map((r) => r.share * 100)).toFixed(2)}%`);
      return;
    }
    const renderer = new ReferenceRenderer(browser, brand, typeof args.handoff === 'string' ? args.handoff : undefined);
    for (const s of states.filter((x) => ['P', 'M', 'C'].includes(x.kind))) {
      const shot = await renderer.render(s);
      writeFileSync(path.join(out, `${s.id}.ref.png`), shot.png);
      console.log(`${s.id}: ${shot.width}×${shot.height}, canvas ${shot.canvas}, ${shot.masks.length} masks`);
    }
    if (args.feeds) {
      const feeds = await renderer.exportFeeds();
      for (const [k, v] of Object.entries(feeds)) writeFileSync(path.join(out, `feed-${k}.png`), v);
    }
  } finally {
    await browser.close();
  }
}

if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

