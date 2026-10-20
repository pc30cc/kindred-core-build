/**
 * Pixel diff of two PNGs, computed in a Chromium page (canvas + getImageData),
 * so the call widget's visual gate needs no image library: the browser that
 * took the screenshots decodes and compares them.
 *
 * A pixel counts as different when any channel differs by more than the
 * threshold (28, as the hand-held scratchpad tool compare.py). Masked
 * rectangles (image pixels) are left out of both the count and the total.
 * Images of different sizes are compared on their overlap and every pixel
 * outside it counts as different (a size change is never "close enough").
 *
 *   const differ = await PngDiffer.open(browser);
 *   const r = await differ.diff(refPng, livePng, { masks, heatmap: true });
 *   r.share  // 0..1, e.g. 0.0012 = 0.12 %
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';

/** A rectangle in image pixels (device pixels of the screenshot). */
export interface Rect { x: number; y: number; width: number; height: number }

export interface DiffOptions {
  /** A channel difference above this makes the pixel different (default 28). */
  threshold?: number;
  /** Rectangles left out of the comparison. */
  masks?: Rect[];
  /** Also return a heat map PNG (the second image dimmed, differences red, masks blue). */
  heatmap?: boolean;
  /** Compare only this part of the first image (e.g. an acceptance PNG's margin-less phone, or a component's place on its card). */
  cropA?: Rect;
}

export interface DiffResult {
  width: number;
  height: number;
  sizeA: [number, number];
  sizeB: [number, number];
  sizeMatch: boolean;
  /** Pixels compared (the union of both sizes minus the masked ones). */
  counted: number;
  different: number;
  /** different / counted. */
  share: number;
  /** Bounding box of the different pixels, or null. */
  bbox: Rect | null;
  /** Different pixels per row and per column (the larger size). */
  rows: number[];
  cols: number[];
  heatmap?: Buffer;
}

interface PageArgs { a: string; b: string; threshold: number; masks: Rect[]; heatmap: boolean; cropA: Rect | null }
interface PageResult extends Omit<DiffResult, 'heatmap'> { heatmap?: string }

/** Runs inside the page: decode both PNGs (no colour conversion) and count. */
async function diffInPage(args: PageArgs): Promise<PageResult> {
  const decode = async (b64: string, crop: Rect | null) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const w = crop ? Math.round(crop.width) : bmp.width, h = crop ? Math.round(crop.height) : bmp.height;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(bmp, crop ? -Math.round(crop.x) : 0, crop ? -Math.round(crop.y) : 0);
    return { w, h, data: cx.getImageData(0, 0, w, h).data };
  };
  const A = await decode(args.a, args.cropA);
  const B = await decode(args.b, null);
  const W = Math.max(A.w, B.w);
  const H = Math.max(A.h, B.h);
  const masked = new Uint8Array(W * H);
  for (const m of args.masks) {
    const x0 = Math.max(0, Math.floor(m.x)), y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(W, Math.ceil(m.x + m.width)), y1 = Math.min(H, Math.ceil(m.y + m.height));
    for (let y = y0; y < y1; y++) masked.fill(1, y * W + x0, y * W + x1);
  }
  const rows = new Array<number>(H).fill(0);
  const cols = new Array<number>(W).fill(0);
  const diff = new Uint8Array(W * H);
  let counted = 0, different = 0;
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (masked[i]) continue;
      counted++;
      let bad: boolean;
      if (x >= A.w || y >= A.h || x >= B.w || y >= B.h) bad = true;
      else {
        const ia = (y * A.w + x) * 4, ib = (y * B.w + x) * 4;
        bad = Math.abs(A.data[ia] - B.data[ib]) > args.threshold
          || Math.abs(A.data[ia + 1] - B.data[ib + 1]) > args.threshold
          || Math.abs(A.data[ia + 2] - B.data[ib + 2]) > args.threshold
          || Math.abs(A.data[ia + 3] - B.data[ib + 3]) > args.threshold;
      }
      if (!bad) continue;
      diff[i] = 1; different++; rows[y]++; cols[x]++;
      if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
    }
  }
  let heat: string | undefined;
  if (args.heatmap) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d')!;
    const out = cx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        let g = 255;
        if (x < B.w && y < B.h) {
          const ib = (y * B.w + x) * 4;
          g = Math.round(0.299 * B.data[ib] + 0.587 * B.data[ib + 1] + 0.114 * B.data[ib + 2]);
        }
        const dim = Math.round(160 + g * 0.37);
        if (diff[i]) { out.data[o] = 230; out.data[o + 1] = 20; out.data[o + 2] = 40; }
        else if (masked[i]) { out.data[o] = Math.round(dim * 0.6); out.data[o + 1] = Math.round(dim * 0.7); out.data[o + 2] = 255; }
        else { out.data[o] = dim; out.data[o + 1] = dim; out.data[o + 2] = dim; }
        out.data[o + 3] = 255;
      }
    }
    cx.putImageData(out, 0, 0);
    heat = cv.toDataURL('image/png').split(',')[1];
  }
  return {
    width: W, height: H, sizeA: [A.w, A.h], sizeB: [B.w, B.h], sizeMatch: A.w === B.w && A.h === B.h,
    counted, different, share: counted ? different / counted : 0,
    bbox: bx1 < 0 ? null : { x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 },
    rows, cols, heatmap: heat,
  };
}

/** Runs inside the page: images side by side on a neutral sheet, each under its label. */
async function sheetInPage(args: { images: string[]; labels: string[]; height: number | null }): Promise<string> {
  const decoded = await Promise.all(args.images.map(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
  }));
  // With a height, every picture is scaled to it (a whole screen beside a board's smaller PNG).
  const bmps = decoded.map((b) => {
    const k = args.height ? args.height / b.height : 1;
    return { img: b, width: Math.round(b.width * k), height: Math.round(b.height * k) };
  });
  const gap = 24, head = 44;
  const fit = (cx: CanvasRenderingContext2D, text: string, width: number) => {
    let t = text;
    while (t.length > 1 && cx.measureText(t).width > width) t = t.slice(0, -2);
    return t === text ? t : `${t}…`;
  };
  const W = bmps.reduce((s, b) => s + b.width, 0) + gap * (bmps.length + 1);
  const H = Math.max(...bmps.map((b) => b.height)) + head + gap;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d')!;
  cx.fillStyle = '#F2F3F5'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '#20232A'; cx.font = '600 22px system-ui, sans-serif';
  let x = gap;
  bmps.forEach((b, i) => {
    cx.fillText(fit(cx, args.labels[i] || '', b.width), x, 30);
    cx.drawImage(b.img, x, head, b.width, b.height);
    x += b.width + gap;
  });
  return cv.toDataURL('image/png').split(',')[1];
}

export class PngDiffer {
  private constructor(private readonly context: BrowserContext, private readonly page: Page) {}

  /** A blank page in its own context of `browser`, kept for many diffs. */
  static async open(browser: Browser): Promise<PngDiffer> {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    // esbuild (tsx) wraps named inner functions in `__name(…)`; evaluated code needs it defined.
    await page.setContent('<!doctype html><title>diff</title>');
    await page.evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };');
    return new PngDiffer(context, page);
  }

  async diff(a: Buffer, b: Buffer, opts: DiffOptions = {}): Promise<DiffResult> {
    const r = await this.page.evaluate(diffInPage, {
      a: a.toString('base64'), b: b.toString('base64'),
      threshold: opts.threshold ?? 28, masks: opts.masks || [], heatmap: !!opts.heatmap, cropA: opts.cropA || null,
    });
    return { ...r, heatmap: r.heatmap ? Buffer.from(r.heatmap, 'base64') : undefined };
  }

  /** A part of a PNG (image pixels), as a PNG. */
  async crop(png: Buffer, rect: Rect): Promise<Buffer> {
    const b64 = await this.page.evaluate(async ({ b64, r }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const cv = document.createElement('canvas');
      cv.width = Math.round(r.width); cv.height = Math.round(r.height);
      cv.getContext('2d')!.drawImage(bmp, -Math.round(r.x), -Math.round(r.y));
      return cv.toDataURL('image/png').split(',')[1];
    }, { b64: png.toString('base64'), r: rect });
    return Buffer.from(b64, 'base64');
  }

  /** Several PNGs side by side with labels (Tier B review sheets), optionally all scaled to one height. */
  async sheet(images: Buffer[], labels: string[], opts: { height?: number } = {}): Promise<Buffer> {
    const b64 = await this.page.evaluate(sheetInPage, { images: images.map((i) => i.toString('base64')), labels, height: opts.height || null });
    return Buffer.from(b64, 'base64');
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Short description of where the differences sit: "142 px (0.011%) in 412×38 at 240,880". */
export function describeDiff(r: DiffResult): string {
  const pct = (r.share * 100).toFixed(3);
  const where = r.bbox ? ` in ${r.bbox.width}×${r.bbox.height} at ${r.bbox.x},${r.bbox.y}` : '';
  const size = r.sizeMatch ? '' : ` (sizes ${r.sizeA.join('×')} vs ${r.sizeB.join('×')})`;
  return `${r.different} px (${pct}%)${where}${size}`;
}
