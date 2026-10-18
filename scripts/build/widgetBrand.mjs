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
 * SHIPS_INTL_KIT, shared/buildBrand.ts): an Iran-brand deployment switched
 * to the International edition then goes without it (the plain launcher
 * instead of RESPOK's, docs/operations/WIDGET_TEMPLATE_RULES.md §5); the
 * loader's RESPOK kit is marked so. `both` keeps everything. Every build
 * refuses malformed markers of either kit.
 *
 * A name a deleted block defined that is still referenced after minifying
 * would throw a ReferenceError in visitors' browsers: the transform refuses
 * to produce such a file. Every name counts: each declarator of a
 * `var a = 1, b = 2;` or `var a, b;` and each function or class the block
 * declares (declaredNames).
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

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * The tokens of a script, enough to find its declarations: identifiers,
 * punctuators (`=>` as one) and opaque literals. Strings, template literals,
 * comments, numbers and regular expressions are skipped as whole tokens, so
 * a comma or a bracket inside one counts for nothing.
 * @param {string} src
 * @param {string} name file name, for errors
 * @returns {Array<{ t: 'id' | 'p' | 'lit', v: string }>}
 */
function scriptTokens(src, name) {
  const out = [];
  let i = 0;
  const fail = (what) => { throw new Error(`${name}: a kit block the build cannot read (${what} at ${i})`); };
  const regexAllowed = () => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.t === 'lit') return false;
    if (prev.t === 'id') return KEYWORDS_BEFORE_EXPRESSION.has(prev.v);
    return prev.v !== ')' && prev.v !== ']';
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) fail('comment'); i = e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      // A template literal's `${…}` may hold anything but its closing
      // backtick: the sources are ES5 plus `class`, so none is expected.
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      if (i >= src.length) fail('string');
      i++;
      out.push({ t: 'lit', v: c });
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        const r = src[i];
        if (r === '\\') { i++; continue; }
        if (r === '\n') fail('regular expression');
        if (inClass) { if (r === ']') inClass = false; continue; }
        if (r === '[') inClass = true;
        else if (r === '/') break;
      }
      if (i >= src.length) fail('regular expression');
      for (i++; i < src.length && /[a-z]/i.test(src[i]); i++);
      out.push({ t: 'lit', v: '/' });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
    if (word) { out.push({ t: 'id', v: word[0] }); i += word[0].length; continue; }
    const num = /^\.?[0-9][\w.]*/.exec(src.slice(i, i + 200));
    if (num) { out.push({ t: 'lit', v: '0' }); i += num[0].length; continue; }
    if (c === '=' && src[i + 1] === '>') { out.push({ t: 'p', v: '=>' }); i += 2; continue; }
    out.push({ t: 'p', v: c });
    i++;
  }
  return out;
}

/**
 * The names a kit block declares for the code around it: every declarator
 * of each `var` / `let` / `const` (`var a = 1, b = f(2, 3);` and `var a, b;`
 * declare a AND b), each function declaration and each class declaration,
 * outside the bodies of its functions and classes (their own locals are
 * invisible outside the block, and the minifier renames them). A
 * destructuring declaration is refused, never guessed.
 * @param {string} block
 * @param {string} [name] file name, for errors
 */
export function declaredNames(block, name = 'source') {
  const tokens = scriptTokens(block, name);
  const names = new Set();
  /** Open brackets: '(' / '[' / '{', 'fn' (a function's or a class's body), 'params' (a function's parameters). */
  const stack = [];
  let fnPending = false;
  let bodyNext = false;
  let classPending = false;
  const inFunction = () => stack.includes('fn');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'id' && (tok.v === 'function' || tok.v === 'class')) {
      const prev = tokens[i - 1];
      let next = tokens[i + 1];
      if (next && next.v === '*') next = tokens[i + 2];
      const statement = !prev || (prev.t === 'p' && (prev.v === ';' || prev.v === '{' || prev.v === '}'));
      if (next && next.t === 'id' && next.v !== 'extends' && statement && !inFunction()) names.add(next.v);
      if (tok.v === 'class') classPending = true;
      else fnPending = true;
      continue;
    }
    if (tok.t === 'id' && (tok.v === 'var' || tok.v === 'let' || tok.v === 'const') && !inFunction()) {
      for (;;) {
        const id = tokens[++i];
        if (!id || id.t !== 'id') throw new Error(`${name}: a kit block declares what the build cannot read (${tok.v} ${id ? id.v : '…'})`);
        names.add(id.v);
        if (tokens[i + 1] && tokens[i + 1].v === '=') {
          // Its initializer: up to this statement's next comma or semicolon,
          // a bracket closing around it, or the next declaration.
          let depth = 0;
          for (i += 2; i < tokens.length; i++) {
            const v = tokens[i].t === 'lit' ? '' : tokens[i].v;
            if (v === '(' || v === '[' || v === '{') depth++;
            else if (v === ')' || v === ']' || v === '}') { if (depth === 0) break; depth--; }
            else if (depth === 0 && (v === ',' || v === ';' || v === 'var' || v === 'let' || v === 'const')) break;
          }
        } else i++;
        // A comma: the next declarator (initialised or not, `var a, b;`).
        if (!tokens[i] || tokens[i].v !== ',') { i--; break; }
      }
      continue;
    }
    if (tok.t !== 'p') continue;
    if (tok.v === '=>') { bodyNext = true; continue; }
    if (tok.v === '(') { stack.push(fnPending ? 'params' : '('); fnPending = false; continue; }
    if (tok.v === '[') { stack.push('['); continue; }
    if (tok.v === '{') { stack.push(bodyNext || classPending ? 'fn' : '{'); bodyNext = false; classPending = false; continue; }
    if (tok.v === ')' || tok.v === ']' || tok.v === '}') {
      if (stack.pop() === 'params') bodyNext = true;
      continue;
    }
    bodyNext = false;
  }
  return [...names];
}

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
    if (!name.endsWith('.css')) for (const d of declaredNames(block, name)) declared.add(d);
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
