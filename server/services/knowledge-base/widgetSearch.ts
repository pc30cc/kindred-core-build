/**
 * The widget's help search (`GET /api/widget/kb/search`): which words of a
 * visitor's query are searched, and in which order the articles come back.
 *
 * The query used to be matched as ONE substring inside a PostgREST `or=(...)`
 * filter. Two consequences, both visible to visitors:
 *
 *   - a comma or a parenthesis ends a value in that grammar, so an ordinary
 *     draft such as «سلام, سفارشم» or "price (new)" made the filter unparsable
 *     and the route answered no results at all;
 *   - "ارسال سفارش" never found «زمان ارسال و پیگیری سفارش», because the two
 *     words are not next to each other there.
 *
 * Now the query is split into words, every character that means something
 * to the filter grammar (`,` `(` `)` `"` `{` `}`) or to LIKE (`%` `_` `*` `\`)
 * becomes a space, each word is matched on its own, and the articles that
 * contain more of the words (in the title first, then the summary) come
 * first. No migration, no new index: the trigram indexes on title, excerpt
 * and content serve each `ilike`.
 */

/** At most this many words are searched (a pasted paragraph stays cheap). */
export const KB_SEARCH_MAX_WORDS = 6;

/**
 * The words to search for. One-letter words (a lone «و» or "a") are dropped
 * unless they are all there is, so a conjunction does not match every
 * article. Duplicates are searched once.
 */
export function kbSearchWords(query: string): string[] {
  const words = String(query || '')
    .replace(/[,()"{}%_*\\]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const long = words.filter((w) => w.length >= 2);
  const picked = long.length ? long : words;
  return Array.from(new Set(picked.map((w) => w.toLocaleLowerCase())))
    .slice(0, KB_SEARCH_MAX_WORDS);
}

/** The PostgREST `or=(...)` filter: any word in the title, summary or text. */
export function kbSearchOrFilter(words: string[]): string {
  return words
    .flatMap((w) => [`title.ilike.%${w}%`, `excerpt.ilike.%${w}%`, `content.ilike.%${w}%`])
    .join(',');
}

/** How many rows to read before ranking (the route returns `limit` of them). */
export function kbSearchWindow(limit: number): number {
  return Math.min(50, Math.max(limit * 3, 24));
}

/**
 * Orders matched rows: each word found in the title counts 2, in the
 * summary 1; ties keep the database's order (most recently updated first).
 * A row that matched only in the article text keeps its place behind them.
 */
export function rankKbSearchRows<T extends { title?: string | null; excerpt?: string | null }>(
  rows: T[],
  words: string[],
  limit: number,
): T[] {
  const score = (row: T) => {
    const title = String(row.title || '').toLocaleLowerCase();
    const excerpt = String(row.excerpt || '').toLocaleLowerCase();
    let s = 0;
    for (const w of words) {
      if (title.includes(w)) s += 2;
      if (excerpt.includes(w)) s += 1;
    }
    return s;
  };
  return rows
    .map((row, index) => ({ row, index, score: score(row) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.row);
}
