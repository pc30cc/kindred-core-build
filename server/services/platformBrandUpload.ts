/**
 * What an upload of the platform's own logo or symbol must be (Super Admin →
 * Branding → Visual identity; server/routes/platformBrandAssets.ts). Pure:
 * no I/O, no image library (the backend has none, and needs none).
 *
 *   - The original: SVG, PNG or WebP, at most MAX_BRAND_FILE_BYTES, its bytes
 *     what its type says.
 *   - An SVG passes a strict allowlist (sanitizeBrandSvg): static drawing
 *     only. Editor metadata is dropped; anything that runs or reaches outside
 *     the file is refused, never quietly cut, so the file stored draws exactly
 *     what the Super Admin's browser drew for its PNG copies.
 *   - The PNG copies, drawn by that browser (the server never rasterises):
 *     the signature checked and the size read from the IHDR chunk.
 *
 * The files are served from the platform's storage to every visitor of every
 * widget, and an SVG opened on its own is a document: that is why nothing
 * active may pass.
 */

export const MAX_BRAND_FILE_BYTES = 2 * 1024 * 1024;

export const BRAND_ASSET_VARIANTS = ['logo-light', 'logo-dark', 'symbol'] as const;
export type BrandAssetVariant = (typeof BRAND_ASSET_VARIANTS)[number];

export function isBrandAssetVariant(value: unknown): value is BrandAssetVariant {
  return typeof value === 'string' && (BRAND_ASSET_VARIANTS as readonly string[]).includes(value);
}

export type BrandImageType = 'svg' | 'png' | 'webp';

export const BRAND_IMAGE_CONTENT_TYPES: Record<BrandImageType, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
};

/** The sizes the symbol's PNG copies must have, in pixels (square). */
export const SYMBOL_ICON_SIZES = { apple_touch_180: 180, png_192: 192, png_512: 512 } as const;
export type SymbolIconName = keyof typeof SYMBOL_ICON_SIZES;

/** The email copy of the logo: about 3x a 40 px display height, within sane bounds. */
export const EMAIL_LOGO_MIN_HEIGHT = 40;
export const EMAIL_LOGO_MAX_HEIGHT = 480;
export const EMAIL_LOGO_MAX_WIDTH = 2400;

export class BrandUploadError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BrandUploadError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Base64 (plain or a data: URL) to bytes; empty or oversized is refused. */
export function decodeBrandFile(data: string, what = 'file'): Buffer {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  const body = (comma >= 0 ? data.slice(comma + 1) : data).replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new BrandUploadError('invalid_data', 400, what);
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length === 0) throw new BrandUploadError('invalid_data', 400, what);
  if (bytes.length > MAX_BRAND_FILE_BYTES) throw new BrandUploadError('file_too_large', 413, what);
  return bytes;
}

/** What the bytes are, by their own signature (never by the name or the declared type). */
export function sniffBrandImage(bytes: Buffer): BrandImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** A PNG's size from its IHDR chunk; null when the bytes are not a well-formed PNG header. */
export function readPngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) return null;
  return { width, height };
}

/** A PNG copy: its signature and size checked; `exact` for the square icons. */
export function checkBrandPng(data: string, what: string, exact?: number): { bytes: Buffer; width: number; height: number } {
  const bytes = decodeBrandFile(data, what);
  const size = readPngSize(bytes);
  if (!size) throw new BrandUploadError('png_invalid', 400, what);
  if (exact !== undefined && (size.width !== exact || size.height !== exact)) {
    throw new BrandUploadError('png_wrong_size', 400, `${what}: ${size.width}x${size.height}, expected ${exact}x${exact}`);
  }
  return { bytes, ...size };
}

/** The email copy of the logo: a PNG of a sensible height (about 3x the 40 px it is shown at). */
export function checkEmailLogoPng(data: string, what: string): { bytes: Buffer; width: number; height: number } {
  const png = checkBrandPng(data, what);
  if (png.height < EMAIL_LOGO_MIN_HEIGHT || png.height > EMAIL_LOGO_MAX_HEIGHT || png.width > EMAIL_LOGO_MAX_WIDTH) {
    throw new BrandUploadError('png_wrong_size', 400, `${what}: ${png.width}x${png.height}`);
  }
  return png;
}

/**
 * The original file: its declared type must be what its bytes are, and an SVG
 * comes back sanitised (the bytes to store).
 */
export function checkBrandOriginal(contentType: string, data: string): { type: BrandImageType; bytes: Buffer; contentType: string } {
  const bytes = decodeBrandFile(data, 'file');
  const type = sniffBrandImage(bytes);
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type || BRAND_IMAGE_CONTENT_TYPES[type] !== declared) throw new BrandUploadError('unsupported_type', 415, declared || 'none');
  if (type === 'png' && !readPngSize(bytes)) throw new BrandUploadError('png_invalid', 400, 'file');
  if (type === 'svg') {
    const clean = sanitizeBrandSvg(bytes.toString('utf8'));
    return { type, bytes: Buffer.from(clean, 'utf8'), contentType: BRAND_IMAGE_CONTENT_TYPES.svg };
  }
  return { type, bytes, contentType: BRAND_IMAGE_CONTENT_TYPES[type] };
}

// ─── SVG ─────────────────────────────────────────────────────────────

/** Static drawing elements. Anything else is refused (or, for metadata, dropped). */
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker', 'image',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feDropShadow',
  'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'feTile',
]);

/** Elements an editor writes that draw nothing: dropped with everything inside them. */
const SVG_DROPPED_ELEMENTS = new Set(['metadata']);

/** Presentation and geometry attributes; any other is refused (namespaced editor ones are dropped). */
const SVG_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'version', 'xml:space', 'href', 'xlink:href',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'dx', 'dy',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'transform', 'd', 'points', 'pathLength',
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'color', 'display', 'visibility', 'overflow', 'clip', 'clip-path', 'clip-rule', 'clipPathUnits',
  'mask', 'maskUnits', 'maskContentUnits', 'filter', 'filterUnits', 'primitiveUnits',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end',
  'in', 'in2', 'result', 'stdDeviation', 'mode', 'operator', 'k1', 'k2', 'k3', 'k4', 'values', 'type',
  'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'radius', 'edgeMode',
  'flood-color', 'flood-opacity', 'lighting-color', 'color-interpolation', 'color-interpolation-filters',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing',
  'text-decoration', 'writing-mode', 'direction', 'unicode-bidi', 'lengthAdjust', 'textLength', 'startOffset',
  'mix-blend-mode', 'isolation', 'vector-effect', 'shape-rendering', 'text-rendering', 'image-rendering',
  'paint-order', 'enable-background', 'focusable', 'role', 'aria-label', 'aria-hidden',
]);

/** A local reference (`#id`) or, on <image> only, an embedded raster image. */
const LOCAL_REF = /^#[A-Za-z_][\w.:-]*$/;
const EMBEDDED_RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

/** An entity other than XML's own (a doctype could have declared it; it is dropped). */
const XML_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
/** In an attribute or a stylesheet, a character reference could spell `url(` or `javascript:`. */
const CHAR_REFERENCE = /&#/;

const CSS_URL = /url\s*\(/gi;
const CSS_LOCAL_URL = /url\s*\(\s*(['"]?)#[A-Za-z_][\w.:-]*\1\s*\)/gi;

/** Every url(...) names a local fragment; nothing is imported, nothing scripted. */
function cssIsStatic(css: string): boolean {
  const lowered = css.toLowerCase();
  if (/@import|@namespace|@font-face|expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set|cross-fade|element\s*\(|src\s*\(/.test(lowered)) return false;
  if (CHAR_REFERENCE.test(css)) return false;
  // A CSS escape stands for any character (`u\rl(`, `@i\mport`), so it could
  // spell any of those: none is needed for a drawing.
  if (css.includes('\\')) return false;
  // Each url( must be a closed #local one: CSS also takes a url that runs,
  // unclosed, to the end of the stylesheet or the attribute.
  return (css.match(CSS_URL)?.length ?? 0) === (css.match(CSS_LOCAL_URL)?.length ?? 0);
}

function refuse(detail: string): never {
  throw new BrandUploadError('svg_not_allowed', 400, detail);
}

interface SvgAttr { name: string; value: string; quote: string }

const ATTR_RE = /\s+([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

function parseAttributes(source: string, tag: string): SvgAttr[] {
  const attrs: SvgAttr[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    ATTR_RE.lastIndex = at;
    const m = ATTR_RE.exec(source);
    if (!m) refuse(`<${tag}>: an attribute is not well-formed`);
    if (seen.has(m[1])) refuse(`<${tag}>: ${m[1]} twice`);
    seen.add(m[1]);
    attrs.push({ name: m[1], value: m[3] ?? m[4] ?? '', quote: m[3] !== undefined ? '"' : "'" });
    at = ATTR_RE.lastIndex;
  }
  return attrs;
}

/** One attribute kept as written, dropped (editor metadata), or the whole file refused. */
function keepAttribute(tag: string, attr: SvgAttr): boolean {
  const { name, value } = attr;
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) refuse(`<${tag}> ${name}`);
  if (XML_ENTITY.test(value) || CHAR_REFERENCE.test(value) || value.includes('<')) refuse(`<${tag}> ${name}: a character reference or '<'`);
  if (/javascript:|vbscript:|data:text/i.test(value.replace(/\s+/g, ''))) refuse(`<${tag}> ${name}`);
  if (lower === 'href' || lower === 'xlink:href') {
    const ref = value.trim();
    if (LOCAL_REF.test(ref) || (tag === 'image' && EMBEDDED_RASTER.test(ref))) return true;
    refuse(`<${tag}> ${name}: only a #local reference`);
  }
  if (name === 'xmlns') {
    if (value !== 'http://www.w3.org/2000/svg') refuse(`<${tag}> xmlns`);
    return true;
  }
  if (name === 'xmlns:xlink') return value === 'http://www.w3.org/1999/xlink' ? true : refuse(`<${tag}> xmlns:xlink`);
  // Other namespaces (Inkscape, Sketch, Illustrator's i:, data-*) are the
  // editor's notes, never drawn.
  if (lower.startsWith('xmlns:') || lower.startsWith('data-') || (name.includes(':') && !SVG_ATTRIBUTES.has(name))) return false;
  if (!SVG_ATTRIBUTES.has(name)) refuse(`<${tag}> ${name}`);
  // Presentation attributes are CSS values too, so any function or escape is
  // checked, not only one that already reads url(.
  if (/[(\\]/.test(value) || name === 'style') {
    if (!cssIsStatic(value)) refuse(`<${tag}> ${name}: only url(#local)`);
  }
  return true;
}

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|[^<]+|</g;

/**
 * The SVG to store, or a BrandUploadError ('svg_not_allowed', with what was
 * found). The root must be <svg> with a size (viewBox, or width and height);
 * only the allowlisted elements and attributes pass, every reference is a
 * #local one (an <image> may embed a raster as a data: URL), and stylesheets
 * import nothing. Comments, processing instructions, the doctype (and any
 * entity it declares) and editor metadata are dropped; inside a <style>, where
 * dropping one would join the text around it, they are refused.
 */
export function sanitizeBrandSvg(input: string): string {
  const source = String(input || '').replace(/^\uFEFF/, '');
  const out: string[] = [];
  const stack: string[] = [];
  let dropDepth = 0; // inside a dropped element (metadata, an editor's own)
  let sawRoot = false;
  let rootClosed = false;
  // A <style> is checked as one stylesheet, its text and CDATA joined as the
  // browser joins them, so nothing may sit inside it that this loop would
  // drop or step over (a comment, an element) to split `@import` or `url(`.
  let inStyle = false;
  let styleText: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = TOKEN_RE.exec(source))) {
    if (m.index !== consumed) refuse('not well-formed');
    consumed = TOKEN_RE.lastIndex;
    const token = m[0];
    if (token === '<') refuse('not well-formed');
    if (token.startsWith('<!--') || token.startsWith('<?')) {
      if (inStyle) refuse('<style>: a comment or processing instruction inside');
      continue;
    }
    if (/^<!DOCTYPE/i.test(token)) {
      if (sawRoot) refuse('a doctype inside the drawing');
      continue;
    }
    if (token.startsWith('<![CDATA[')) {
      if (!stack.length) refuse('text outside <svg>');
      if (dropDepth) continue;
      if (inStyle) {
        styleText.push(token.slice(9, -3));
        out.push(token);
        continue;
      }
      refuse('CDATA outside <style>');
    }
    const closing = m[1];
    const opening = m[2];
    if (closing) {
      const top = stack.pop();
      if (top !== closing) refuse(`</${closing}> closes <${top ?? 'nothing'}>`);
      if (dropDepth) {
        dropDepth -= 1;
        continue;
      }
      if (inStyle) {
        if (!cssIsStatic(styleText.join(''))) refuse('<style>: only url(#local)');
        inStyle = false;
        styleText = [];
      }
      out.push(`</${closing}>`);
      if (!stack.length) rootClosed = true;
      continue;
    }
    if (opening) {
      const selfClosing = m[4] === '/';
      if (inStyle) refuse(`<style>: an element inside (<${opening}>)`);
      if (rootClosed) refuse('more than one root element');
      if (!sawRoot && opening !== 'svg') refuse(`the root is <${opening}>, not <svg>`);
      const attrs = parseAttributes(m[3] || '', opening);
      if (dropDepth || SVG_DROPPED_ELEMENTS.has(opening) || (opening.includes(':') && sawRoot)) {
        if (!selfClosing) {
          stack.push(opening);
          dropDepth += 1;
        }
        continue;
      }
      if (!SVG_ELEMENTS.has(opening)) refuse(`<${opening}>`);
      if (opening === 'svg' && !sawRoot) {
        sawRoot = true;
        const viewBox = attrs.find((a) => a.name === 'viewBox')?.value ?? '';
        const width = parseFloat(attrs.find((a) => a.name === 'width')?.value ?? '');
        const height = parseFloat(attrs.find((a) => a.name === 'height')?.value ?? '');
        const box = viewBox.trim().split(/[\s,]+/).map(Number);
        const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
        if (!hasBox && !(width > 0 && height > 0)) refuse('no size (a viewBox, or width and height)');
        if (!attrs.some((a) => a.name === 'xmlns')) attrs.unshift({ name: 'xmlns', value: 'http://www.w3.org/2000/svg', quote: '"' });
      }
      const kept = attrs.filter((a) => keepAttribute(opening, a));
      out.push(`<${opening}${kept.map((a) => ` ${a.name}=${a.quote}${a.value}${a.quote}`).join('')}${selfClosing ? '/>' : '>'}`);
      if (selfClosing) {
        if (opening === 'svg') rootClosed = true;
      } else {
        stack.push(opening);
        if (opening === 'style') inStyle = true;
      }
      continue;
    }
    // Text.
    if (!stack.length) {
      if (token.trim()) refuse('text outside <svg>');
      continue;
    }
    if (dropDepth) continue;
    if (XML_ENTITY.test(token)) refuse('an entity');
    if (inStyle) styleText.push(token);
    out.push(token);
  }
  if (consumed !== source.length) refuse('not well-formed');
  if (!sawRoot) refuse('no <svg>');
  if (stack.length || !rootClosed) refuse('<svg> is not closed');
  return out.join('');
}
