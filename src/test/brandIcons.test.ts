/**
 * Every icon the product shows, and the ways one goes wrong unnoticed.
 *
 * There were three marks in the tree and none of them agreed: the browser tab
 * carried a generic blue speech bubble, the Capacitor app shipped Capacitor's
 * own logo as both its icon and its splash screen, and only the native app
 * had WEBYAR on it. Nothing failed. It builds, it installs, it runs — you
 * find out by looking at a phone, or by a customer noticing before you do.
 *
 * Two rules, because two things happen to an icon:
 *
 *   * A home-screen icon is masked by the system. It has to be a full-bleed
 *     square with no alpha channel, and artwork with its own rounded corner
 *     or its own margin gets rounded twice — a white tile with a smaller one
 *     floating inside it. That is how the supplied artwork arrived.
 *   * A favicon is masked by nothing, so it carries the corner itself and is
 *     transparent outside it.
 *
 * And the whole point: they all have to be the same picture. That one is
 * checked by comparing the pixels, because it is the claim that decays.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import plist from 'plist';

/** An app-icon catalog: masked by the system, so square and opaque. */
const CATALOGS = [
  'ios/WebyarNative/Resources/Assets.xcassets/AppIcon.appiconset',
  'ios/App/App/Assets.xcassets/AppIcon.appiconset',
];
/** Masked by the system too, but a plain file rather than a catalog. */
const SQUARE_FILES = ['public/apple-touch-icon.png'];
/** Masked by nothing. */
const ROUNDED_FILES = ['public/favicon.png'];

type Png = {
  width: number;
  height: number;
  depth: number;
  /** PNG colour type: 2 is RGB, 6 is RGBA. */
  colour: number;
  /** Row-major RGB, three bytes per pixel. */
  pixels: Uint8Array;
  /** Row-major alpha, one byte per pixel; all 255 when the image has none. */
  alpha: Uint8Array;
};

/**
 * Enough of a PNG decoder to answer the questions above.
 *
 * Not a dependency: this runs on a handful of files, of one shape, that this
 * repo produces itself, and a decoder small enough to read is worth more here
 * than one that handles interlacing and palettes we will never write.
 */
function decodePng(bytes: Buffer): Png {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat: Buffer[] = [];

  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.subarray(at + 4, at + 8).toString('ascii');
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      expect(body[12], 'interlaced PNGs are not decoded here').toBe(0);
    } else if (kind === 'IDAT') {
      idat.push(body);
    } else if (kind === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height).fill(255);

  // Undo the per-row filters. Each row carries its filter byte and is
  // expressed against the row above it, so this cannot be done out of order.
  const line = new Uint8Array(stride);
  const above = new Uint8Array(stride);
  for (let y = 0, at = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[at + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = above[i];
      const c = i >= channels ? above[i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG row filter ${filter}`);
      }
      line[i] = value & 0xff;
    }
    at += stride;
    for (let x = 0; x < width; x += 1) {
      pixels[(y * width + x) * 3 + 0] = line[x * channels + 0];
      pixels[(y * width + x) * 3 + 1] = line[x * channels + 1];
      pixels[(y * width + x) * 3 + 2] = line[x * channels + 2];
      if (channels === 4) alpha[y * width + x] = line[x * channels + 3];
    }
    above.set(line);
  }

  return { width, height, depth, colour, pixels, alpha };
}

/** How far apart the two most distant samples in a strip are, worst channel. */
function spread(png: Png, pick: (i: number) => number, count: number): number {
  let worst = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    let low = 255;
    let high = 0;
    for (let i = 0; i < count; i += 1) {
      const value = png.pixels[pick(i) * 3 + channel];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    worst = Math.max(worst, high - low);
  }
  return worst;
}

/**
 * The image reduced to an n x n thumbnail over white, for comparing one icon
 * against another.
 *
 * Box-averaged rather than sampled: a nearest-neighbour thumbnail of a
 * gradient moves around under a one-pixel shift, and would make two icons
 * that are the same picture look different. Composited over white so a
 * rounded icon with transparent corners can be compared with the square one
 * it was cut from.
 */
function thumbnail(png: Png, n = 24): Float64Array {
  const out = new Float64Array(n * n * 3);
  for (let ty = 0; ty < n; ty += 1) {
    for (let tx = 0; tx < n; tx += 1) {
      const x0 = Math.floor((tx * png.width) / n);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * png.width) / n));
      const y0 = Math.floor((ty * png.height) / n);
      const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * png.height) / n));
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = y * png.width + x;
          const a = png.alpha[i] / 255;
          for (let c = 0; c < 3; c += 1) {
            sum[c] += png.pixels[i * 3 + c] * a + 255 * (1 - a);
          }
          count += 1;
        }
      }
      for (let c = 0; c < 3; c += 1) out[(ty * n + tx) * 3 + c] = sum[c] / count;
    }
  }
  return out;
}

/** Mean absolute difference between two thumbnails, in levels out of 255. */
function difference(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Every icon in a catalog that names a file, as repo-relative paths. */
function catalogFiles(catalog: string): string[] {
  const manifest = JSON.parse(readFileSync(join(catalog, 'Contents.json'), 'utf8'));
  const images: Array<{ filename?: string; size?: string; idiom?: string }> = manifest.images ?? [];
  expect(images.length, `${catalog} declares no images at all`).toBeGreaterThan(0);
  for (const image of images) {
    expect(image.filename, `a ${image.size} ${image.idiom} slot in ${catalog} is empty`).toBeTruthy();
  }
  return images.map((image) => join(catalog, image.filename!));
}

const squares = [...CATALOGS.flatMap(catalogFiles), ...SQUARE_FILES];
const all = [...squares, ...ROUNDED_FILES];

describe('the brand icons', () => {
  it.each(all)('%s exists', (path) => {
    expect(existsSync(path)).toBe(true);
  });

  it.each(all)('%s is square and 8-bit', (path) => {
    const png = decodePng(readFileSync(path));
    expect(png.width, 'an icon must be square').toBe(png.height);
    expect(png.depth).toBe(8);
  });

  it.each(squares)('%s is opaque, because the system masks it', (path) => {
    const png = decodePng(readFileSync(path));
    // App Store Connect rejects an icon carrying an alpha channel outright,
    // whether or not anything in it is actually transparent.
    expect(png.colour, 'this icon has an alpha channel').toBe(2);
  });

  it.each(squares)('%s bleeds to all four edges', (path) => {
    const png = decodePng(readFileSync(path));
    const { width: w, height: h } = png;

    // A margin shows up as an edge of one flat colour. Artwork that reaches
    // the edge varies along it — this icon's gradient moves by a hundred
    // levels or so down each side. Eight is far below anything real and far
    // above the couple of levels of noise in a PNG.
    const FLAT = 8;
    const edges: Array<[string, (i: number) => number, number]> = [
      ['top', (x) => x, w],
      ['bottom', (x) => (h - 1) * w + x, w],
      ['left', (y) => y * w, h],
      ['right', (y) => y * w + (w - 1), h],
    ];
    for (const [side, pick, count] of edges) {
      expect(
        spread(png, pick, count),
        `the ${side} edge is one flat colour: the artwork has a margin around ` +
          `it, and the system will mask that margin into the icon`,
      ).toBeGreaterThan(FLAT);
    }

    // And the corners belong to the artwork, not to a backdrop it was drawn
    // on. A pre-rounded icon leaves its corners the colour of the paper,
    // the same in all four; a full-bleed gradient does not.
    const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
    expect(
      spread(png, (i) => corners[i], corners.length),
      'all four corners are the same colour: this icon is drawn on a backdrop ' +
        'rather than bleeding to its own edges',
    ).toBeGreaterThan(FLAT);
  });

  it.each(ROUNDED_FILES)('%s carries its own rounded corner', (path) => {
    const png = decodePng(readFileSync(path));
    expect(png.colour, 'a favicon needs an alpha channel to round itself').toBe(6);
    const { width: w, height: h } = png;
    const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
    for (const i of corners) {
      expect(png.alpha[i], 'a corner is opaque: nothing masks a favicon, so ' +
        'the tab would show a hard square where every other surface is rounded')
        .toBeLessThan(8);
    }
    expect(png.alpha[(h / 2) * w + w / 2], 'the middle is transparent').toBe(255);
  });

  it('shows the same mark on every surface', () => {
    const reference = all[0];
    const want = thumbnail(decodePng(readFileSync(reference)));
    // Nine levels out of 255. Resampling between a 1024 and a 180 moves a
    // gradient by a level or two, and rounding the corners off the favicon
    // moves those corners a long way — over a 24x24 average that lands
    // around five. A genuinely different picture is nowhere near this.
    const SAME = 9;
    for (const path of all.slice(1)) {
      const got = difference(want, thumbnail(decodePng(readFileSync(path))));
      expect(
        got,
        `${path} is a different picture from ${reference} — every surface is ` +
          `meant to show one mark`,
      ).toBeLessThan(SAME);
    }
  });
});

/**
 * Every bundle that carries an icon has to name its icon set.
 *
 * `CFBundleIconName` is not the `CFBundleIcons` dictionary the asset compiler
 * writes during a build; that one is present and correct without any help.
 * This is the separate top-level key. Xcode's own app template ships it, a
 * plist generated from a project file does not, and neither does one
 * hand-maintained since a Capacitor scaffold.
 *
 * Nothing on a device misbehaves without it — App Store Connect is what
 * rejects the upload, as ITMS-90713, which is a bad moment to find out.
 */
describe('the bundles that carry an icon', () => {
  const CATALOG_NAME = 'AppIcon';

  it('the native app names its icon set in the generated Info.plist', () => {
    const project = readFileSync('ios/WebyarNative/project.yml', 'utf8');
    expect(
      project,
      'project.yml builds the Info.plist and declares no CFBundleIconName, ' +
        'so App Store Connect will reject the upload as ITMS-90713',
    ).toMatch(new RegExp(`^\\s*CFBundleIconName:\\s*${CATALOG_NAME}\\s*$`, 'm'));
  });

  it('the Capacitor app names its icon set in its Info.plist', () => {
    const info = plist.parse(
      readFileSync('ios/App/App/Info.plist', 'utf8'),
    ) as Record<string, unknown>;
    expect(
      info.CFBundleIconName,
      'ios/App/App/Info.plist declares no CFBundleIconName',
    ).toBe(CATALOG_NAME);
  });

  it('both names match a catalog that exists', () => {
    for (const catalog of CATALOGS) {
      expect(
        catalog.endsWith(`${CATALOG_NAME}.appiconset`),
        `${catalog} is not the ${CATALOG_NAME} set the plists name`,
      ).toBe(true);
      expect(existsSync(join(catalog, 'Contents.json'))).toBe(true);
    }
  });
});
