/**
 * The two editions of the commerce plugins (WooCommerce, WHMCS, OpenCart),
 * built from the SAME sources in plugins/<iran code>-*:
 *
 *   - `iran`   — the packages exactly as the sources spell them (the Iran
 *                region's brand). Built the way they always were; their
 *                signed releases stay byte for byte what stores run.
 *   - `respok` — the International packages. The staged Iran package is
 *                rewritten by one deterministic transform (respokText /
 *                respokPath below): file and folder names, plugin names and
 *                slugs, text domains, PHP namespaces / class / function /
 *                constant / option prefixes, displayed text, default URLs
 *                and update-feed paths. Icons are swapped for RESPOK's.
 *                Nothing is forked: a change to a source file reaches both.
 *
 * Which ones a build makes follows the client build's brand
 * (scripts/build/brand.mjs): respok → respok, iran → iran, both → both.
 *
 * Wire protocol of the respok edition (server/services/commerce/pluginDialect.ts
 * accepts both on every deployment):
 *
 *   Iran (legacy)                    International (neutral)
 *   X-WebYar-<Name> headers          X-Platform-<Name>
 *   HTTP_X_WEBYAR_ (PHP $_SERVER)    HTTP_X_PLATFORM_
 *   protocol webyar-commerce/1       platform-commerce/1
 *   identity audience webyar-widget  platform-widget
 *   WHMCS signed path /webyar/whmcs/v1  /platform/whmcs/v1
 *   module code webyar               respok   (WP REST namespace respok/v1,
 *                                             WHMCS modules/addons/respok,
 *                                             OpenCart extension code respok)
 *
 * Platform rules the renamed packages keep (checked by
 * src/test/commerce/pluginEditions.test.ts):
 *   - WordPress: the plugin's folder is its slug, the main file is
 *     <slug>/<slug>.php, the text domain equals the slug and the language
 *     files are languages/<text domain>-<locale>.mo.
 *   - WHMCS: the addon folder modules/addons/<name>/ is the module name; it
 *     holds <name>.php whose functions are <name>_config/_activate/_output…
 *   - OpenCart 4.1: the extension code is taken from the uploaded file's name
 *     (<code>.ocmod.zip), and with it the folder extension/<code>/ and the
 *     namespace Opencart\…\Extension\<Code>; the controller class and route
 *     are module/<code>. OpenCart 3.0: the package's upload/ tree maps onto
 *     the store, routes are extension/module/<code>.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IRAN_BRAND_PATTERNS } from './brandAudit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @typedef {'iran' | 'respok'} PluginEdition */

/** Which plugin editions a build of `brand` (scripts/build/brand.mjs) makes. */
export function pluginEditionsFor(brand) {
  if (brand === 'respok') return ['respok'];
  if (brand === 'iran') return ['iran'];
  return ['iran', 'respok'];
}

/** The module code each edition's packages are named after. */
export const EDITION_CODE = { iran: ['web', 'yar'].join(''), respok: 'respok' };

/** The brand the respok edition displays (plugin names, admin pages, notices). */
export const RESPOK_DISPLAY_NAME = 'RESPOK';

/** Icons of the respok edition, by file name in the package (every PNG must be listed). */
export const RESPOK_ICONS = {
  'icon-128x128.png': join(ROOT, 'plugins', 'editions', 'respok', 'icon-128x128.png'),
  'icon.png': join(ROOT, 'public', 'brand', 'intl', 'maskable-icon-512.png'),
};

const TEXT_EXTENSIONS = new Set(['.php', '.twig', '.json', '.txt', '.md', '.css', '.js', '.po', '.pot', '.html', '.xml', '.sql', '.ini']);

function extOf(file) {
  const name = basename(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** Case of the replacement follows the case of what it replaces. */
function caseLike(match, word) {
  const letters = match.replace(/[^A-Za-z]/g, '');
  if (letters === letters.toUpperCase()) return word.toUpperCase();
  if (letters === letters.toLowerCase()) return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

// The Latin name in any spacing/case (scripts/build/brandAudit.mjs pattern 1).
const LATIN_ANY = /w\s*e\s*b[\s._-]*y\s*a\s*r/gi;
// The Persian name, with ZWNJ, ZWSP, a space or nothing between its parts.
const PERSIAN = /وب[\u200c\u200b\s]?یار/g;
const PERSIAN_ESCAPED = /\\u0648\\u0628(?:\\u200c|\\u200C|\\u200b| )?\\u06cc\\u0627\\u0631/gi;

/**
 * Rewrites one text file of the Iran package into the respok edition.
 * Order matters: wire names and domains first (they must become neutral,
 * not "respok"), display names next, every remaining identifier last.
 */
export function respokText(text) {
  let out = text;
  // Domains → RESPOK's.
  out = out.replace(/\bapp\.webyar\.ai\b/gi, 'app.respok.app');
  out = out.replace(/\bapi\.webyar\.ai\b/gi, 'api.respok.app');
  out = out.replace(/\bwebyar\.ai\b/gi, 'respok.app');
  // Wire protocol → brand-neutral names (server/services/commerce/pluginDialect.ts).
  // `HTTP_X_WEBYAR_` is matched with its length where PHP compares a prefix.
  out = out.replace(/'HTTP_X_WEBYAR_', 14\)/g, "'HTTP_X_PLATFORM_', 16)");
  if (/HTTP_X_WEBYAR_/.test(out)) throw new Error('HTTP_X_WEBYAR_ used without a known prefix length: teach respokText this form');
  out = out.replace(/X-WebYar-/g, 'X-Platform-');
  out = out.replace(/x-webyar-/g, 'x-platform-');
  if (/x-webyar-/i.test(out)) throw new Error('header prefix in an unexpected case: teach respokText this form');
  out = out.replace(/webyar-commerce\/1/g, 'platform-commerce/1');
  out = out.replace(/webyar-widget/g, 'platform-widget');
  out = out.replace(/\/webyar\/whmcs\/v1/g, '/platform/whmcs/v1');
  // OpenCart's update feed: a file of its own beside the Iran edition's.
  out = out.replace(/\/downloads\/opencart\/manifest\.json/g, '/downloads/opencart/respok-manifest.json');
  // Display names → RESPOK.
  out = out.replace(PERSIAN, RESPOK_DISPLAY_NAME);
  out = out.replace(PERSIAN_ESCAPED, RESPOK_DISPLAY_NAME);
  out = out.replace(/\bWeb\s+Yar\b/g, RESPOK_DISPLAY_NAME);
  // The name as a word of text (not part of an identifier or a namespace).
  out = out.replace(/(?<![A-Za-z0-9_\\$])WebYar(?![A-Za-z0-9_\\])/g, RESPOK_DISPLAY_NAME);
  // Every remaining spelling is an identifier, path or slug: same case, new code.
  out = out.replace(LATIN_ANY, (m) => caseLike(m, 'respok'));
  return out;
}

/** One path segment (file or folder name) of the respok edition. */
export function respokName(name) {
  return name.replace(LATIN_ANY, (m) => caseLike(m, 'respok'));
}

/** Throws when `text` (a name or a file's contents) still carries the Iran brand. */
export function assertNoIranBrand(label, text) {
  for (const re of IRAN_BRAND_PATTERNS) {
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
    if (m) {
      const at = Math.max(0, m.index - 40);
      throw new Error(`respok edition: ${label} still carries the Iran brand: ${JSON.stringify(text.slice(at, m.index + m[0].length + 40))}`);
    }
  }
}

function listAll(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    out.push(full);
    if (statSync(full).isDirectory()) out.push(...listAll(full));
  }
  return out;
}

/**
 * Turns a staged Iran package tree into the respok edition, in place:
 * renames every file and folder, rewrites every text file, recompiles
 * gettext catalogues from their rewritten .po, swaps the icons. Fails on
 * any file it does not know how to rewrite, and on any name or content that
 * still carries the Iran brand afterwards.
 */
export function transformTreeToRespok(dir) {
  // Deepest first, so a folder is renamed after its children.
  const paths = listAll(dir).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  for (const path of paths) {
    const name = basename(path);
    const renamed = respokName(name);
    if (renamed !== name) {
      const target = join(dirname(path), renamed);
      if (existsSync(target)) throw new Error(`respok edition: ${relative(dir, target)} would be overwritten`);
      renameSync(path, target);
    }
  }
  const files = listAll(dir).filter((p) => statSync(p).isFile());
  for (const file of files) {
    const ext = extOf(file);
    const rel = relative(dir, file);
    if (TEXT_EXTENSIONS.has(ext) || basename(file) === 'index.html') {
      writeFileSync(file, respokText(readFileSync(file, 'utf8')));
    } else if (ext === '.png') {
      const icon = RESPOK_ICONS[basename(file)];
      if (!icon) throw new Error(`respok edition: no RESPOK image for ${rel} (add it to RESPOK_ICONS)`);
      cpSync(icon, file);
    } else if (ext !== '.mo') {
      throw new Error(`respok edition: do not know how to rewrite ${rel}`);
    }
  }
  // Compiled catalogues: rebuilt from the rewritten .po beside them.
  for (const file of files.filter((f) => extOf(f) === '.mo')) {
    const po = file.replace(/\.mo$/, '.po');
    if (!existsSync(po)) throw new Error(`respok edition: ${relative(dir, file)} has no .po to rebuild it from`);
    writeFileSync(file, compileMo(readFileSync(po, 'utf8')));
  }
  for (const path of listAll(dir)) {
    const rel = relative(dir, path);
    assertNoIranBrand(`file name ${rel}`, rel);
    if (statSync(path).isFile()) assertNoIranBrand(rel, readFileSync(path).toString('utf8'));
  }
}

// ── gettext ─────────────────────────────────────────────────────────────

function poUnquote(line) {
  const m = line.match(/^"(.*)"\s*$/);
  if (!m) throw new Error(`malformed .po string line: ${line}`);
  return m[1].replace(/\\(["\\ntr])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' })[c]);
}

/** Entries of a .po file: [{ context, id, plural, strings[] }] (fuzzy and obsolete entries left out). */
export function parsePo(text) {
  const entries = [];
  let cur = null;
  let field = null;
  let fuzzy = false;
  const flush = () => {
    if (cur && cur.id !== undefined && !fuzzy) entries.push(cur);
    cur = null;
    field = null;
    fuzzy = false;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('#~')) continue;
    if (line.startsWith('#,')) { if (/\bfuzzy\b/.test(line)) fuzzy = true; continue; }
    if (line.startsWith('#')) continue;
    const kw = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(".*")$/);
    if (kw) {
      if ((kw[1] === 'msgid' || kw[1] === 'msgctxt') && cur && cur.strings.length) {
        const keepFuzzy = fuzzy;
        flush();
        fuzzy = keepFuzzy;
      }
      cur ??= { context: null, id: undefined, plural: null, strings: [] };
      const value = poUnquote(kw[3]);
      if (kw[1] === 'msgctxt') { cur.context = value; field = ['context']; }
      else if (kw[1] === 'msgid') { cur.id = value; field = ['id']; }
      else if (kw[1] === 'msgid_plural') { cur.plural = value; field = ['plural']; }
      else { const i = kw[2] === undefined ? 0 : Number(kw[2]); cur.strings[i] = value; field = ['strings', i]; }
      continue;
    }
    if (line.startsWith('"') && cur && field) {
      const value = poUnquote(line);
      if (field[0] === 'strings') cur.strings[field[1]] += value;
      else cur[field[0]] += value;
      continue;
    }
    throw new Error(`unsupported .po line: ${raw}`);
  }
  flush();
  return entries;
}

/** A GNU .mo catalogue (little endian, no hash table) of a .po file's translated entries. */
export function compileMo(poText) {
  const entries = parsePo(poText)
    .filter((e) => e.id === '' || e.strings.some((s) => s))
    .map((e) => {
      const key = `${e.context !== null ? `${e.context}\u0004` : ''}${e.id}${e.plural !== null ? `\u0000${e.plural}` : ''}`;
      return { key: Buffer.from(key, 'utf8'), value: Buffer.from(e.strings.join('\u0000'), 'utf8') };
    })
    .sort((a, b) => Buffer.compare(a.key, b.key));
  const n = entries.length;
  const headerSize = 28;
  const origTable = headerSize;
  const transTable = origTable + n * 8;
  let offset = transTable + n * 8;
  const parts = [];
  const origIdx = [];
  const transIdx = [];
  for (const e of entries) { origIdx.push([e.key.length, offset]); parts.push(e.key, Buffer.alloc(1)); offset += e.key.length + 1; }
  for (const e of entries) { transIdx.push([e.value.length, offset]); parts.push(e.value, Buffer.alloc(1)); offset += e.value.length + 1; }
  const head = Buffer.alloc(transTable + n * 8);
  head.writeUInt32LE(0x950412de, 0);
  head.writeUInt32LE(0, 4);
  head.writeUInt32LE(n, 8);
  head.writeUInt32LE(origTable, 12);
  head.writeUInt32LE(transTable, 16);
  head.writeUInt32LE(0, 20);
  head.writeUInt32LE(offset, 24);
  origIdx.forEach(([len, off], i) => { head.writeUInt32LE(len, origTable + i * 8); head.writeUInt32LE(off, origTable + i * 8 + 4); });
  transIdx.forEach(([len, off], i) => { head.writeUInt32LE(len, transTable + i * 8); head.writeUInt32LE(off, transTable + i * 8 + 4); });
  return Buffer.concat([head, ...parts]);
}

/** Reads a .mo back into { key → value } (tests). */
export function readMo(buf) {
  const le = buf.readUInt32LE(0) === 0x950412de;
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const n = u32(8);
  const orig = u32(12);
  const trans = u32(16);
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = buf.subarray(u32(orig + i * 8 + 4), u32(orig + i * 8 + 4) + u32(orig + i * 8)).toString('utf8');
    const value = buf.subarray(u32(trans + i * 8 + 4), u32(trans + i * 8 + 4) + u32(trans + i * 8)).toString('utf8');
    out.set(key, value);
  }
  return out;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Removes a staged tree (helper for the builders' temp folders). */
export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}
