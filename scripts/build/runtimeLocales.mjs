/**
 * The chat widget's runtime in one language.
 *
 * public/widget/runtime.js carries its dictionary in every language the
 * widget speaks (I18n `dict`), each block opened by a `// @locale <id>` line
 * and the last closed by `// @locale-end`. A visitor's widget speaks one of
 * them for the whole page view (runtime.js init: `widgetLanguage`, else
 * `locale`), so the build also ships runtime-<id>.js: the same file with that
 * language's block only. English stays as an empty block in the others: it
 * is the fallback of `I18n.t`, and every language has every English key
 * (src/test/widget/runtimeLocales.test.ts), so the fallback is never read.
 *
 * /config names the file of the widget's language
 * (server/services/widget/manifest.ts runtimeAssetNameFor); the full
 * runtime.js stays for everything else (the dashboard's preview, an older
 * backend, the unhashed fallback).
 */

const OPEN = /^[ \t]*\/\/ @locale ([a-z]{2,3})[ \t]*$/;
const CLOSE = /^[ \t]*\/\/ @locale-end[ \t]*$/;

/**
 * The language blocks of `source`: `{ id, start, end }` line ranges (`start`
 * the marker line, `end` the next marker line), in order. Throws when the
 * markers are not one run of blocks closed by `@locale-end`, or English is
 * not among them: a build must not ship a runtime it cannot cut.
 */
export function localeBlocks(source) {
  const lines = String(source).split('\n');
  const blocks = [];
  let close = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const open = OPEN.exec(lines[i]);
    if (open) {
      if (close !== -1) throw new Error(`runtime locales: a @locale ${open[1]} after @locale-end (line ${i + 1})`);
      if (blocks.length) blocks[blocks.length - 1].end = i;
      if (blocks.some((b) => b.id === open[1])) throw new Error(`runtime locales: @locale ${open[1]} twice`);
      blocks.push({ id: open[1], start: i, end: -1 });
    } else if (CLOSE.test(lines[i])) {
      if (!blocks.length || close !== -1) throw new Error(`runtime locales: a stray @locale-end (line ${i + 1})`);
      close = i;
      blocks[blocks.length - 1].end = i;
    }
  }
  if (!blocks.length) throw new Error('runtime locales: no @locale block');
  if (close === -1) throw new Error('runtime locales: no @locale-end');
  if (!blocks.some((b) => b.id === 'en')) throw new Error('runtime locales: no @locale en (the fallback)');
  return { lines, blocks };
}

/** The ids of `source`'s language blocks, in order. */
export function runtimeLocales(source) {
  return localeBlocks(source).blocks.map((b) => b.id);
}

/**
 * `source` with only `locale`'s block (and an empty English one, the
 * fallback's name). Throws for a language the file has no block for.
 */
export function runtimeForLocale(source, locale) {
  const { lines, blocks } = localeBlocks(source);
  if (!blocks.some((b) => b.id === locale)) throw new Error(`runtime locales: no @locale ${locale}`);
  const out = [];
  let at = 0;
  for (const b of blocks) {
    out.push(...lines.slice(at, b.start));
    if (b.id === locale) out.push(...lines.slice(b.start, b.end));
    else if (b.id === 'en') out.push(lines[b.start], lines[b.start].replace('// @locale en', 'en: {},'));
    at = b.end;
  }
  out.push(...lines.slice(at));
  return out.join('\n');
}
