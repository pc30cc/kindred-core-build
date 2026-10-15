/**
 * The embeddable widgets' static files (public/widget/, public/call-widget/)
 * as each build brand ships them (scripts/build/brand.mjs). Used by
 * scripts/widget-hash.js and scripts/call-widget-hash.js, and by the tests
 * that prove what the RESPOK widget carries (src/test/widget/widgetBrandBuild.test.ts).
 *
 * Every production build minifies the widgets' JS and CSS with esbuild and
 * drops their comments. The RESPOK build first leaves out the Iran region's
 * local kit, marked in the sources:
 *
 *   - a block between `/* @iran-kit:begin *\/` and `/* @iran-kit:end *\/` is
 *     deleted;
 *   - the file's switch `var LOCAL_KIT = true;` is deleted and every
 *     `LOCAL_KIT` becomes the literal `false` (esbuild `define`), so the
 *     minifier removes every `if (LOCAL_KIT ...)` branch, the only places
 *     allowed to use what the deleted blocks define.
 *
 * A name a deleted block defined that is still referenced after minifying
 * would throw a ReferenceError in visitors' browsers: the transform refuses
 * to produce such a file.
 *
 * The JS target is ES2017 (as scripts/build-smart-engine.mjs): the sources
 * are ES5 plus `class`, so nothing is lowered and no helper is added, and the
 * minifier introduces no syntax newer than that (no `??`, `?.`, or `catch {}`).
 * Top-level names of these classic scripts are kept (no `format`, so esbuild
 * does not treat them as modules and renames only local names).
 */
import { transformSync } from 'esbuild';

export const KIT_BEGIN = '/* @iran-kit:begin */';
export const KIT_END = '/* @iran-kit:end */';
export const LOCAL_KIT_SWITCH = 'var LOCAL_KIT = true;';

const JS_TARGET = 'es2017';
// Browsers of the same era as ES2017, so the CSS minifier keeps every value
// in a form they read (it lowers nothing newer the sources do not use).
const CSS_TARGET = ['chrome58', 'edge16', 'firefox57', 'safari11'];

/**
 * Removes the Iran region's local kit from one source: its marked blocks and
 * its switch. Returns the new source and the names the blocks declared.
 * @param {string} source
 * @param {string} [name] file name, for errors
 */
export function stripLocalKit(source, name = 'source') {
  const declared = new Set();
  let out = '';
  let at = 0;
  for (;;) {
    const begin = source.indexOf(KIT_BEGIN, at);
    const strayEnd = source.indexOf(KIT_END, at);
    if (begin < 0) {
      if (strayEnd >= 0) throw new Error(`${name}: ${KIT_END} without ${KIT_BEGIN}`);
      out += source.slice(at);
      break;
    }
    if (strayEnd >= 0 && strayEnd < begin) throw new Error(`${name}: ${KIT_END} without ${KIT_BEGIN}`);
    const end = source.indexOf(KIT_END, begin + KIT_BEGIN.length);
    if (end < 0) throw new Error(`${name}: ${KIT_BEGIN} without ${KIT_END}`);
    const block = source.slice(begin + KIT_BEGIN.length, end);
    if (block.includes(KIT_BEGIN)) throw new Error(`${name}: nested ${KIT_BEGIN}`);
    for (const m of block.matchAll(/\b(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    out += source.slice(at, begin);
    at = end + KIT_END.length;
  }
  const switches = out.split(LOCAL_KIT_SWITCH).length - 1;
  if (switches > 1) throw new Error(`${name}: "${LOCAL_KIT_SWITCH}" more than once`);
  if (switches === 1) out = out.replace(LOCAL_KIT_SWITCH, '');
  else if (/\bLOCAL_KIT\b/.test(out)) throw new Error(`${name}: uses LOCAL_KIT without "${LOCAL_KIT_SWITCH}"`);
  return { source: out, declared: [...declared] };
}

/**
 * One widget file as `brand` ships it. JS and CSS are minified (comments
 * dropped); for `respok` the local kit is removed first. Anything else is
 * returned unchanged.
 * @param {string} name file name (its extension picks the loader)
 * @param {string | Buffer} input
 * @param {'respok' | 'iran' | 'both'} brand
 * @returns {string | Buffer}
 */
export function transformWidgetAsset(name, input, brand) {
  const isJs = name.endsWith('.js');
  const isCss = name.endsWith('.css');
  if (!isJs && !isCss) return input;
  let source = String(input);
  let declared = [];
  if (brand === 'respok') ({ source, declared } = stripLocalKit(source, name));
  const result = transformSync(source, isJs
    ? { loader: 'js', minify: true, legalComments: 'none', target: JS_TARGET, charset: 'utf8', ...(brand === 'respok' ? { define: { LOCAL_KIT: 'false' } } : {}) }
    : { loader: 'css', minify: true, legalComments: 'none', target: CSS_TARGET, charset: 'utf8' });
  const code = result.code;
  if (isJs && brand === 'respok') {
    // Local names are renamed by the minifier; a name still spelled out is
    // an unbound (global) reference: the deleted definition's.
    const left = declared.filter((d) => new RegExp(`(^|[^\\w$.])${d.replace(/\$/g, '\\$')}(?![\\w$])`).test(code));
    if (left.length) throw new Error(`${name}: the RESPOK build still uses ${left.join(', ')} outside an "if (LOCAL_KIT ...)" branch`);
    if (/\bLOCAL_KIT\b/.test(code)) throw new Error(`${name}: LOCAL_KIT was not folded away`);
  }
  return code;
}

/** Whether `name` is a file this transform rewrites (top-level JS and CSS; not vendor/ libraries). */
export function isWidgetSource(name) {
  return /^[^/]+\.(js|css)$/.test(name);
}

// `node scripts/build/widgetBrand.mjs <respok|iran|both> <file>`: prints the
// file as that brand ships it (for tests that run where esbuild cannot,
// such as a jsdom environment).
const isMain = process.argv[1] && process.argv[1].endsWith('widgetBrand.mjs');
if (isMain) {
  const [brand, file] = process.argv.slice(2);
  const { readFileSync } = await import('fs');
  const { basename } = await import('path');
  process.stdout.write(String(transformWidgetAsset(basename(file), readFileSync(file), /** @type {any} */ (brand))));
}
