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
 * The Iran build does the same with the International-only kit, marked
 * `/* @intl-kit:begin *\/` … `/* @intl-kit:end *\/` with the switch
 * `var INTL_KIT = true;` (the widgets' mirror of the dashboard's
 * SHIPS_INTL_KIT, shared/buildBrand.ts). No widget file uses it yet: the
 * Iran build (app.webyar.ai) can serve the International edition, whose
 * kit it then needs (docs/operations/WIDGET_TEMPLATE_RULES.md §5). `both`
 * keeps everything. Every build refuses malformed markers of either kit.
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
export const INTL_KIT_BEGIN = '/* @intl-kit:begin */';
export const INTL_KIT_END = '/* @intl-kit:end */';
export const INTL_KIT_SWITCH = 'var INTL_KIT = true;';

/** The two kits: the Iran region's (left out of RESPOK) and the International one (left out of Iran). */
const IRAN_KIT = { begin: KIT_BEGIN, end: KIT_END, switch: LOCAL_KIT_SWITCH, flag: 'LOCAL_KIT' };
const INTL_KIT = { begin: INTL_KIT_BEGIN, end: INTL_KIT_END, switch: INTL_KIT_SWITCH, flag: 'INTL_KIT' };

const JS_TARGET = 'es2017';
// Browsers of the same era as ES2017, so the CSS minifier keeps every value
// in a form they read (it lowers nothing newer the sources do not use).
const CSS_TARGET = ['chrome58', 'edge16', 'firefox57', 'safari11'];

/**
 * Removes one kit from a source: its marked blocks and its switch. Returns
 * the new source and the names the blocks declared.
 * @param {string} source
 * @param {string} name file name, for errors
 * @param {{ begin: string, end: string, switch: string, flag: string }} kit
 */
function stripKit(source, name, kit) {
  const declared = new Set();
  let out = '';
  let at = 0;
  for (;;) {
    const begin = source.indexOf(kit.begin, at);
    const strayEnd = source.indexOf(kit.end, at);
    if (begin < 0) {
      if (strayEnd >= 0) throw new Error(`${name}: ${kit.end} without ${kit.begin}`);
      out += source.slice(at);
      break;
    }
    if (strayEnd >= 0 && strayEnd < begin) throw new Error(`${name}: ${kit.end} without ${kit.begin}`);
    const end = source.indexOf(kit.end, begin + kit.begin.length);
    if (end < 0) throw new Error(`${name}: ${kit.begin} without ${kit.end}`);
    const block = source.slice(begin + kit.begin.length, end);
    if (block.includes(kit.begin)) throw new Error(`${name}: nested ${kit.begin}`);
    for (const m of block.matchAll(/\b(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    out += source.slice(at, begin);
    at = end + kit.end.length;
  }
  const switches = out.split(kit.switch).length - 1;
  if (switches > 1) throw new Error(`${name}: "${kit.switch}" more than once`);
  if (switches === 1) out = out.replace(kit.switch, '');
  else if (new RegExp(`\\b${kit.flag}\\b`).test(out)) throw new Error(`${name}: uses ${kit.flag} without "${kit.switch}"`);
  return { source: out, declared: [...declared] };
}

/**
 * Removes the Iran region's local kit from one source: its marked blocks and
 * its switch. Returns the new source and the names the blocks declared.
 * @param {string} source
 * @param {string} [name] file name, for errors
 */
export function stripLocalKit(source, name = 'source') {
  return stripKit(source, name, IRAN_KIT);
}

/**
 * The same for the International-only kit (`@intl-kit`, `INTL_KIT`).
 * @param {string} source
 * @param {string} [name] file name, for errors
 */
export function stripIntlKit(source, name = 'source') {
  return stripKit(source, name, INTL_KIT);
}

/**
 * One widget file as `brand` ships it. JS and CSS are minified (comments
 * dropped); for `respok` the local kit is removed first, for `iran` the
 * International one. Anything else is returned unchanged.
 * @param {string} name file name (its extension picks the loader)
 * @param {string | Buffer} input
 * @param {'respok' | 'iran' | 'both'} brand
 * @param {{ define?: Record<string, string> }} [options] extra esbuild `define`s (JS only)
 * @returns {string | Buffer}
 */
export function transformWidgetAsset(name, input, brand, options = {}) {
  const isJs = name.endsWith('.js');
  const isCss = name.endsWith('.css');
  if (!isJs && !isCss) return input;
  let source = String(input);
  let declared = [];
  const left = brand === 'respok' ? IRAN_KIT : brand === 'iran' ? INTL_KIT : null;
  // Both kits' markers are checked in every build, so a malformed one fails
  // where it is written, not only in the other brand's build.
  for (const kit of [IRAN_KIT, INTL_KIT]) {
    if (kit === left) ({ source, declared } = stripKit(source, name, kit));
    else stripKit(source, name, kit);
  }
  const result = transformSync(source, isJs
    ? { loader: 'js', minify: true, legalComments: 'none', target: JS_TARGET, charset: 'utf8', define: { ...(options.define || {}), ...(left ? { [left.flag]: 'false' } : {}) } }
    : { loader: 'css', minify: true, legalComments: 'none', target: CSS_TARGET, charset: 'utf8' });
  const code = result.code;
  if (isJs && left) {
    // Local names are renamed by the minifier; a name still spelled out is
    // an unbound (global) reference: the deleted definition's.
    const used = declared.filter((d) => new RegExp(`(^|[^\\w$.])${d.replace(/\$/g, '\\$')}(?![\\w$])`).test(code));
    if (used.length) throw new Error(`${name}: the ${brand === 'respok' ? 'RESPOK' : 'Iran'} build still uses ${used.join(', ')} outside an "if (${left.flag} ...)" branch`);
    if (new RegExp(`\\b${left.flag}\\b`).test(code)) throw new Error(`${name}: ${left.flag} was not folded away`);
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
