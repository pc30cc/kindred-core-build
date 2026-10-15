/**
 * index.html per build brand (scripts/build/brand.mjs), applied by
 * vite.config.ts before Vite reads the page.
 *
 * The page's Iranian-kit parts sit between marker lines, and the RESPOK
 * build's own versions of them inside a marker comment:
 *
 *   <!-- @iran-kit -->          <!-- @respok-build
 *   …                           …
 *   <!-- @end-iran-kit -->      @end-respok-build -->
 *
 * In CSS the markers read `/* @iran-kit *` + `/`, in JS `// @iran-kit`, and a
 * JS @respok-build block opens with `/* @respok-build` and closes with
 * `@end-respok-build *` + `/`.
 *
 * Every build drops the marker lines. The RESPOK build also drops what the
 * @iran-kit markers enclose, keeps what @respok-build encloses, and drops
 * the page's comments (HTML, CSS, and whole-line JS comments), which talk
 * about both brands. Any other build drops the @respok-build blocks, so its
 * page is exactly the file as it was before the markers.
 */

const IRAN_KIT_BLOCK =
  /^[ \t]*(?:<!--|\/\/|\/\*) @iran-kit(?: -->| \*\/)?[ \t]*\n([\s\S]*?)^[ \t]*(?:<!--|\/\/|\/\*) @end-iran-kit(?: -->| \*\/)?[ \t]*\n/gm;
const RESPOK_BUILD_BLOCK = /^[ \t]*(?:<!--|\/\*) @respok-build[ \t]*\n([\s\S]*?)^[ \t]*@end-respok-build (?:-->|\*\/)[ \t]*\n/gm;

/** One comment, never running past its own end. */
const HTML_COMMENT = '<!--(?:(?!-->)[\\s\\S])*-->';
const CSS_COMMENT = '\\/\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/';

function dropComments(text, comment) {
  return text
    .replace(new RegExp(`^[ \\t]*${comment}[ \\t]*\\n`, 'gm'), '')
    .replace(new RegExp(comment, 'g'), '');
}

/**
 * @param {string} html
 * @param {'respok' | 'iran' | 'both' | string} brand
 * @returns {string}
 */
export function brandIndexHtml(html, brand) {
  const respok = brand === 'respok';
  const out = html
    .replace(IRAN_KIT_BLOCK, (_m, body) => (respok ? '' : body))
    .replace(RESPOK_BUILD_BLOCK, (_m, body) => (respok ? body : ''));
  if (!respok) return out;
  return dropComments(out, HTML_COMMENT)
    .replace(/(<style>)([\s\S]*?)(<\/style>)/g, (_m, open, css, close) => open + dropComments(css, CSS_COMMENT) + close)
    .replace(/(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script>)/g, (_m, open, js, close) => open + js.replace(/^[ \t]*\/\/.*\n/gm, '') + close);
}
