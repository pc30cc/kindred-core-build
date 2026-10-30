// @vitest-environment node
/**
 * What an upload of the platform's own logo or symbol must be
 * (server/services/platformBrandUpload.ts): the original's bytes are what its
 * type says, at most 2 MB; the PNG copies' sizes are read from their IHDR
 * chunk (no image library); an SVG passes a strict allowlist — static drawing
 * only, editor metadata dropped, anything active or reaching outside the file
 * refused, never quietly cut.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BrandUploadError,
  MAX_BRAND_FILE_BYTES,
  checkBrandOriginal,
  checkBrandPng,
  checkEmailLogoPng,
  decodeBrandFile,
  isBrandAssetVariant,
  readPngSize,
  sanitizeBrandSvg,
  sniffBrandImage,
} from '../../../server/services/platformBrandUpload';

const file = (p: string) => readFileSync(resolve(process.cwd(), p));
const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64');
const WEBYAR_EMAIL = file('public/brand/webyar/email/webyar-logo.png');
const RESPOK_EMAIL = file('public/brand/intl/email/respok-logo.png');
const ICON_192 = file('public/brand/intl/android-chrome-192x192.png');

function code(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof BrandUploadError) return err.code;
    throw err;
  }
  return 'passed';
}

const svg = (inner: string, attrs = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"') => `<svg ${attrs}>${inner}</svg>`;

describe('the files', () => {
  it('names three variants and nothing else', () => {
    for (const v of ['logo-light', 'logo-dark', 'symbol']) expect(isBrandAssetVariant(v)).toBe(true);
    for (const v of ['logo', 'favicon', '../symbol', '', null]) expect(isBrandAssetVariant(v)).toBe(false);
  });

  it('knows a file by its bytes, never by what it is called', () => {
    expect(sniffBrandImage(WEBYAR_EMAIL)).toBe('png');
    expect(sniffBrandImage(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(8)]))).toBe('webp');
    expect(sniffBrandImage(Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- Illustrator -->\n<svg viewBox="0 0 1 1"></svg>'))).toBe('svg');
    expect(sniffBrandImage(Buffer.from('<html><svg></svg></html>'))).toBeNull();
    expect(sniffBrandImage(Buffer.from('GIF89a'))).toBeNull();
  });

  it('refuses a declared type its bytes do not have (415)', () => {
    expect(code(() => checkBrandOriginal('image/svg+xml', b64(WEBYAR_EMAIL)))).toBe('unsupported_type');
    expect(code(() => checkBrandOriginal('image/png', b64(svg(''))))).toBe('unsupported_type');
    expect(code(() => checkBrandOriginal('image/gif', b64('GIF89a....')))).toBe('unsupported_type');
    try { checkBrandOriginal('image/jpeg', b64(WEBYAR_EMAIL)); } catch (err) { expect((err as BrandUploadError).status).toBe(415); }
    expect(checkBrandOriginal('image/png; charset=binary', b64(WEBYAR_EMAIL))).toMatchObject({ type: 'png', contentType: 'image/png' });
  });

  it('refuses an empty, malformed or oversized body', () => {
    expect(code(() => decodeBrandFile(''))).toBe('invalid_data');
    expect(code(() => decodeBrandFile('not base64 at all!'))).toBe('invalid_data');
    const big = Buffer.alloc(MAX_BRAND_FILE_BYTES + 1, 1);
    expect(code(() => decodeBrandFile(b64(big)))).toBe('file_too_large');
    expect(decodeBrandFile(`data:image/png;base64,${b64(WEBYAR_EMAIL)}`).equals(WEBYAR_EMAIL)).toBe(true);
  });
});

describe('the PNG copies', () => {
  it('read their size from the IHDR chunk', () => {
    expect(readPngSize(WEBYAR_EMAIL)).toEqual({ width: 360, height: 139 });
    expect(readPngSize(RESPOK_EMAIL)).toEqual({ width: 400, height: 92 });
    expect(readPngSize(ICON_192)).toEqual({ width: 192, height: 192 });
    // A PNG signature with a broken header is not a PNG.
    const broken = Buffer.from(WEBYAR_EMAIL);
    broken.write('IHDX', 12, 'latin1');
    expect(readPngSize(broken)).toBeNull();
    expect(readPngSize(Buffer.from('not a png'))).toBeNull();
  });

  it('an icon must have its exact size', () => {
    expect(checkBrandPng(b64(ICON_192), 'png_192', 192)).toMatchObject({ width: 192, height: 192 });
    expect(code(() => checkBrandPng(b64(ICON_192), 'png_512', 512))).toBe('png_wrong_size');
    expect(code(() => checkBrandPng(b64(svg('')), 'png_192', 192))).toBe('png_invalid');
  });

  it('the email logo is a PNG of a sensible height', () => {
    expect(checkEmailLogoPng(b64(WEBYAR_EMAIL), 'png')).toMatchObject({ width: 360, height: 139 });
    const tall = Buffer.from(WEBYAR_EMAIL);
    tall.writeUInt32BE(900, 20);
    expect(code(() => checkEmailLogoPng(b64(tall), 'png'))).toBe('png_wrong_size');
  });
});

describe('an SVG', () => {
  it('every kit SVG passes as it is drawn', () => {
    for (const dir of ['public/brand/intl', 'public/brand/webyar']) {
      for (const name of readdirSync(resolve(process.cwd(), dir)).filter((n) => n.endsWith('.svg'))) {
        const source = file(`${dir}/${name}`).toString('utf8');
        const out = sanitizeBrandSvg(source);
        expect(out, name).toMatch(/^<svg[\s>]/);
        // Same drawing: the same elements, in the same order.
        const tags = (s: string) => (s.match(/<([A-Za-z][\w:-]*)/g) || []).filter((t) => !t.includes(':'));
        expect(tags(out), name).toEqual(tags(source.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, '')));
      }
    }
  });

  it('keeps gradients, clip paths, local references, stylesheets and embedded rasters', () => {
    const drawing = svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient>'
      + '<clipPath id="c"><rect width="10" height="10"/></clipPath>'
      + '<style>.a{fill:url(#g)} .b > .c{opacity:.5}</style></defs>'
      + '<g clip-path="url(#c)"><path class="a" d="M0 0h10v10z" fill="url(\'#g\')"/></g>'
      + '<use href="#c" x="5"/><use xlink:href="#c"/>'
      + '<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>'
      + '<title>Acme &amp; Co</title>',
      'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40"',
    );
    expect(sanitizeBrandSvg(drawing)).toBe(drawing);
  });

  it('drops what an editor writes and nothing draws; adds the namespace a browser needs', () => {
    const out = sanitizeBrandSvg(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
      + '<!-- Generator: Adobe Illustrator -->\n'
      + '<svg viewBox="0 0 10 10" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3" data-name="Layer 1">'
      + '<metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata>'
      + '<sodipodi:namedview pagecolor="#fff"/>'
      + '<path d="M0 0h1" inkscape:label="dot"/></svg>',
    );
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1"/></svg>');
  });

  it.each([
    ['a script', svg('<script>alert(1)</script>')],
    ['a script in another case', svg('<SCRIPT>alert(1)</SCRIPT>')],
    ['foreignObject', svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>')],
    ['an event handler', svg('<rect width="1" height="1" onclick="alert(1)"/>')],
    ['an event handler on the root', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"></svg>'],
    ['a link', svg('<a href="https://evil.test"><rect width="1" height="1"/></a>')],
    ['an animation that could rewrite a reference', svg('<set attributeName="href" to="javascript:alert(1)"/>')],
    ['an animation', svg('<animate attributeName="x" from="0" to="1"/>')],
    ['an external reference', svg('<use href="https://evil.test/x.svg#a"/>')],
    ['a protocol-relative reference', svg('<use xlink:href="//evil.test/x.svg#a"/>')],
    ['a javascript: reference', svg('<use href="javascript:alert(1)"/>')],
    ['an external image', svg('<image href="https://evil.test/track.png"/>')],
    ['an embedded SVG image', svg('<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>')],
    ['an imported stylesheet', svg('<style>@import url(https://evil.test/a.css);</style>')],
    ['a stylesheet fetching a file', svg('<style>.a{background:url(https://evil.test/a.png)}</style>')],
    ['a stylesheet in CDATA fetching a file', svg('<style><![CDATA[.a{fill:url("//evil.test/a")}]]></style>')],
    ['a font from elsewhere', svg('<style>@font-face{font-family:x;src:url(#f)}</style>')],
    ['a CSS escape', svg('<style>.a{background:\\75 rl(https://evil.test)}</style>')],
    ['a style attribute fetching a file', svg('<rect width="1" height="1" style="fill:url(https://evil.test/a)"/>')],
    ['a presentation attribute fetching a file', svg('<rect width="1" height="1" fill="url(https://evil.test/a#g)"/>')],
    ['a character reference spelling a URL', svg('<rect width="1" height="1" fill="&#117;rl(https://evil.test)"/>')],
    ['an entity a doctype declared', '<!DOCTYPE svg [<!ENTITY x "javascript:alert(1)">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>&x;</text></svg>'],
    ['an unknown element', svg('<iframe/>')],
    ['an unknown attribute', svg('<rect width="1" height="1" formaction="x"/>')],
    ['another root', '<html><svg viewBox="0 0 1 1"></svg></html>'],
    ['a namespaced root', '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg:svg>'],
    ['two roots', `${svg('')}${svg('')}`],
    ['no size', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'],
    ['a tag left open', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g>'],
    ['a mismatched end tag', svg('<g></rect>')],
    ['an unquoted attribute', '<svg viewBox=0 0 1 1></svg>'],
    ['a stray "<"', svg('<rect width="1" height="1"/> < ')],
    ['a foreign default namespace', '<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"></svg>'],
  ])('refuses %s', (_what, source) => {
    expect(code(() => sanitizeBrandSvg(source))).toBe('svg_not_allowed');
  });

  it('a refused SVG is a 400 that says what was found', () => {
    try {
      checkBrandOriginal('image/svg+xml', b64(svg('<script>alert(1)</script>')));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrandUploadError);
      expect((err as BrandUploadError).status).toBe(400);
      expect((err as BrandUploadError).detail).toContain('<script>');
    }
  });

  it('the stored bytes are the sanitised drawing', () => {
    const out = checkBrandOriginal('image/svg+xml', b64('<!-- x --><svg viewBox="0 0 2 2"><circle r="1"/></svg>'));
    expect(out.bytes.toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1"/></svg>');
    expect(out.contentType).toBe('image/svg+xml');
  });
});
