/**
 * The app icon, checked against the four ways one gets rejected or looks wrong.
 *
 * The artwork this app ships arrived drawn the way a logo is drawn for a
 * slide: a rounded rectangle with a drop shadow, floating on white. iOS masks
 * an app icon itself, so that would have gone to the home screen as a white
 * rounded square with a smaller blue one inside it and a shadow in between —
 * and nothing would have failed. It builds, it installs, it runs. You only
 * find out by looking at a phone, and by then it is in review.
 *
 * So the things that cannot be seen from the code are asserted here: one
 * square image, 1024, no alpha channel, and no border of flat colour around
 * the artwork. The PNG header carries the first three; the fourth needs the
 * pixels, which is why this reads the IDAT rather than trusting the size.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const CATALOG = 'ios/WebyarNative/Resources/Assets.xcassets/AppIcon.appiconset';
const MANIFEST = join(CATALOG, 'Contents.json');

type Png = {
  width: number;
  height: number;
  depth: number;
  /** PNG colour type: 2 is RGB, 6 is RGBA. */
  colour: number;
  /** Row-major RGB, three bytes per pixel. */
  pixels: Uint8Array;
};

/**
 * Enough of a PNG decoder to answer the questions above.
 *
 * Not a dependency: this runs on one file, of one shape, that this repo
 * produces itself, and a decoder small enough to read is worth more here than
 * one that handles interlacing and palettes we will never write.
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
  const out = new Uint8Array(width * height * 3);

  // Undo the per-row filters. Each row is prefixed with its filter byte and
  // is expressed against the row above it, so this cannot be done out of
  // order or in parallel.
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
      out[(y * width + x) * 3 + 0] = line[x * channels + 0];
      out[(y * width + x) * 3 + 1] = line[x * channels + 1];
      out[(y * width + x) * 3 + 2] = line[x * channels + 2];
    }
    above.set(line);
  }

  return { width, height, depth, colour, pixels: out };
}

/** How far apart the two most distant pixels in a strip are, per channel. */
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

describe('the iOS app icon', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const entries: Array<{ filename?: string; size?: string; idiom?: string }> = manifest.images ?? [];

  it('names a file for every slot it declares', () => {
    expect(entries.length, 'AppIcon.appiconset declares no images at all').toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.filename, `the ${entry.size} ${entry.idiom} slot is empty`).toBeTruthy();
      expect(existsSync(join(CATALOG, entry.filename!))).toBe(true);
    }
  });

  const named = entries.filter((e) => e.filename);

  it.each(named.map((e) => e.filename!))('%s is a square 1024 with no alpha', (filename) => {
    const png = decodePng(readFileSync(join(CATALOG, filename)));

    expect(png.width, 'an app icon must be square').toBe(png.height);
    expect(png.width).toBe(1024);
    expect(png.depth).toBe(8);
    // App Store Connect rejects an icon carrying an alpha channel outright,
    // whether or not anything in it is actually transparent.
    expect(png.colour, 'the icon has an alpha channel').toBe(2);
  });

  it.each(named.map((e) => e.filename!))('%s bleeds to all four edges', (filename) => {
    const png = decodePng(readFileSync(join(CATALOG, filename)));
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
        `the ${side} edge is one flat colour: the artwork has a margin around it, ` +
          `and iOS will mask that margin into the icon`,
      ).toBeGreaterThan(FLAT);
    }

    // And the corners belong to the artwork, not to a backdrop it was drawn
    // on. A pre-rounded icon leaves its corners the colour of the paper,
    // which is the same in all four; a full-bleed gradient does not.
    const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
    const cornerSpread = spread(png, (i) => corners[i], corners.length);
    expect(
      cornerSpread,
      'all four corners are the same colour: the icon is drawn on a backdrop ' +
        'rather than bleeding to its own edges',
    ).toBeGreaterThan(FLAT);
  });
});
