import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The widget runtime is a plain static file (no build step), so we extract the
 * KB sanitizer block and evaluate it here to assert it is DOM-parser based and
 * not bypassable by the classic regex-sanitizer payloads.
 */
function loadSanitizer(): (input: string) => string {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../public/widget/runtime.js'), 'utf8');
  const start = src.indexOf('var KB_ALLOWED_TAGS');
  const endMarker = 'function sanitizeHtml(input) {';
  const endStart = src.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(endStart).toBeGreaterThan(-1);
  const close = src.indexOf('\n    }', src.indexOf('return Util.escapeHtml(input);', endStart));
  const block = src.slice(start, close + 6);
  const factory = new Function('Util', `${block}; return sanitizeHtml;`);
  return factory({ escapeHtml: (s: string) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) });
}

const sanitizeHtml = loadSanitizer();

describe('widget KB sanitizeHtml (DOM-parser, allowlist based)', () => {
  it('strips <svg/onload=...> (no leading whitespace before the handler)', () => {
    const out = sanitizeHtml('<svg/onload=alert(1)>');
    expect(out.toLowerCase()).not.toContain('svg');
    expect(out.toLowerCase()).not.toContain('onload');
  });

  it('strips inline event handlers on allowed tags', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" onmouseover=alert(2)>hi</p>');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('onmouseover');
    expect(out).toContain('hi');
  });

  it('drops javascript: hrefs split by tab/newline characters', () => {
    for (const payload of [
      '<a href="javascript:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href="java\nscript:alert(1)">x</a>',
      '<a href=" JaVaScRiPt:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
    ]) {
      const out = sanitizeHtml(payload);
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toMatch(/href/);
    }
  });

  it('drops script/iframe/style elements but keeps safe markup', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script><iframe src="//evil"></iframe>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out).toContain('<p>ok</p>');
  });

  it('keeps legitimate links and forces safe rel/target', () => {
    const out = sanitizeHtml('<a href="https://example.com">go</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('drops data: image sources', () => {
    const out = sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(out.toLowerCase()).not.toContain('data:');
  });
});
