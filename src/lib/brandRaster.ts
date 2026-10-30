/**
 * PNG copies of the platform's logo and symbol, drawn in the Super Admin's
 * browser when they upload them (Super Admin → Branding → Visual identity).
 * The server never rasterises (it has no image library): it stores the
 * original and these copies together and checks only their PNG headers
 * (server/services/platformBrandUpload.ts).
 *
 *   - the logo's email copy: 120 px high (3x the 40 px an email shows it
 *     at), transparent: email clients show no SVG;
 *   - the symbol's icons: 192 and 512 px, transparent (the web app, the
 *     notifications, the tab), and 180 px opaque on the given background
 *     (the iPhone home screen masks its own corners and shows no alpha).
 *
 * The file is drawn from a blob URL (same origin: the canvas is not tainted).
 * An SVG gets an explicit width and height from its viewBox first: Safari
 * draws an SVG without them at 150 x 150. Text in an SVG is drawn with this
 * browser's fonts, so a logo's text should be outlined.
 */

export const EMAIL_LOGO_HEIGHT = 120;
const EMAIL_LOGO_MAX_WIDTH = 2400;
export const ICON_SIZES = { apple_touch_180: 180, png_192: 192, png_512: 512 } as const;

export interface PreparedBrandFile {
  contentType: string;
  /** Base64 of the original, as uploaded. */
  data: string;
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The size an SVG declares: its viewBox, else its width and height; null when it declares neither. */
export function svgIntrinsicSize(svgText: string): { width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return null;
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  const width = parseFloat(root.getAttribute('width') || '');
  const height = parseFloat(root.getAttribute('height') || '');
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The SVG with an explicit pixel size, so every browser draws it at its own proportions. */
function sizedSvg(svgText: string, size: { width: number; height: number }): string {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  root.setAttribute('width', String(size.width));
  root.setAttribute('height', String(size.height));
  return new XMLSerializer().serializeToString(doc);
}

/** The file decoded into an image this page can draw. */
async function loadImage(file: File): Promise<HTMLImageElement> {
  let blob: Blob = file;
  if (file.type === 'image/svg+xml') {
    const text = await file.text();
    const size = svgIntrinsicSize(text);
    if (!size) throw new Error('svg_no_size');
    blob = new Blob([sizedSvg(text, size)], { type: 'image/svg+xml' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image_unreadable'));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('image_unreadable');
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The image fitted (contained, centred) on a canvas of this size; base64 PNG. */
function drawPng(
  img: HTMLImageElement,
  width: number,
  height: number,
  opts: { background?: string; inset?: number } = {},
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
  }
  const inset = opts.inset ?? 0;
  const boxW = width * (1 - 2 * inset);
  const boxH = height * (1 - 2 * inset);
  const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export function brandFileType(file: File): string | null {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/svg+xml' || type === 'image/png' || type === 'image/webp') return type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

/** A logo, ready for POST …/assets/logo-light|logo-dark: the original and its email PNG. */
export async function prepareLogoUpload(file: File): Promise<PreparedBrandFile & { png: string }> {
  const contentType = brandFileType(file);
  if (!contentType) throw new Error('unsupported_type');
  const typed = file.type === contentType ? file : new File([file], file.name, { type: contentType });
  const img = await loadImage(typed);
  const ratio = img.naturalWidth / img.naturalHeight;
  const height = Math.max(40, Math.min(EMAIL_LOGO_HEIGHT, Math.floor(EMAIL_LOGO_MAX_WIDTH / ratio)));
  const width = Math.max(1, Math.min(EMAIL_LOGO_MAX_WIDTH, Math.round(height * ratio)));
  return { contentType, data: toBase64(await file.arrayBuffer()), png: drawPng(img, width, height) };
}

/** A symbol, ready for POST …/assets/symbol: the original and its three icons. */
export async function prepareSymbolUpload(
  file: File,
  background = '#FFFFFF',
): Promise<PreparedBrandFile & { icons: Record<keyof typeof ICON_SIZES, string> }> {
  const contentType = brandFileType(file);
  if (!contentType) throw new Error('unsupported_type');
  const typed = file.type === contentType ? file : new File([file], file.name, { type: contentType });
  const img = await loadImage(typed);
  return {
    contentType,
    data: toBase64(await file.arrayBuffer()),
    icons: {
      apple_touch_180: drawPng(img, 180, 180, { background, inset: 0.12 }),
      png_192: drawPng(img, 192, 192),
      png_512: drawPng(img, 512, 512),
    },
  };
}
