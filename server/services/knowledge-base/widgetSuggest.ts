/**
 * Instant answers (`GET /api/widget/kb-suggest`, routes/widgetKbSuggest.ts):
 * while a visitor writes a new conversation's first message, the help
 * articles that answer it, at most three, for the t2 tray above the composer.
 *
 * Narrower than the help search on purpose (widgetSearch.ts), because the
 * input is a sentence being typed rather than a query:
 *
 *   - greetings and filler («سلام», «لطفا», "hi", "please", «merhaba») are
 *     not searched (KB_SUGGEST_STOPWORDS), and only the four longest of the
 *     remaining words are, so a long draft costs no more than a short one;
 *   - only an article's title and summary are matched, never its text, and
 *     only published articles shown in the widget (`visible_in_widget`),
 *     never one the plan has locked;
 *   - an article needs a word in its title, or two in its summary
 *     (KB_SUGGEST_MIN_SCORE); the conversation's language breaks ties.
 *
 * Each answer carries the words it matched (the renderer marks them,
 * escaped), a snippet of the summary around the first match, and the reading
 * time the article view shows (kbReadingMinutes: runtime-ext.js's formula).
 *
 * Two bounded in-process memos keep the endpoint cheap: the articles a
 * (workspace, words) pair can answer with, for 60 s, kept small (hitsOf: no
 * summaries), and each article's reading time per id@updated_at. Neither is
 * invalidated: an edit shows within a minute.
 */
import type { ServerConfig } from '../../config.js';
import { MemoCache } from '../../lib/memoCache.js';
import { getServiceClient } from '../../supabase.js';
import { resolveKbLock } from './locks.js';
import { publicArticles } from './publicArticles.js';

/** At most this many words of a draft are searched. */
export const KB_SUGGEST_MAX_WORDS = 4;
/** Only the start of a draft is read (a pasted paragraph stays cheap). */
export const KB_SUGGEST_MAX_QUERY = 120;
/** At most this many answers; the widget asks for two. */
export const KB_SUGGEST_MAX_LIMIT = 3;
/** A word in the title (2), or two in the summary (1 each). */
export const KB_SUGGEST_MIN_SCORE = 2;
/** Rows read before ranking. */
export const KB_SUGGEST_WINDOW = 24;
/** The snippet's length around the first match. */
export const KB_SUGGEST_SNIPPET = 120;
/** Characters of context kept before the first match. */
const SNIPPET_LEAD = 30;

/**
 * Words a draft is made of that say nothing about its subject. Lower-case;
 * Persian in both spellings people type (with and without the ZWNJ).
 */
export const KB_SUGGEST_STOPWORDS: ReadonlySet<string> = new Set([
  // fa
  'سلام', 'درود', 'ممنون', 'مرسی', 'متشکرم', 'لطفا', 'لطفاً', 'من', 'شما', 'ما', 'این', 'آن', 'که', 'را', 'با', 'از', 'به',
  'در', 'برای', 'تا', 'یا', 'هم', 'چه', 'چی', 'چیه', 'چیست', 'چطور', 'چگونه', 'کی', 'کجا', 'آیا', 'هست', 'است', 'بود',
  'دارم', 'دارید', 'میخواهم', 'می‌خواهم', 'میخوام', 'می‌خوام', 'میخواستم', 'می‌خواستم', 'بپرسم', 'خواهش', 'اگر', 'ولی',
  'اما', 'یک', 'وقت', 'بخیر',
  // en
  'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'the', 'a', 'an', 'is', 'are', 'was', 'i', 'im', 'my', 'me', 'you',
  'your', 'we', 'it', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'how', 'what', 'when', 'where', 'can', 'could',
  'do', 'does', 'did', 'want', 'need', 'with', 'about', 'this', 'that',
  // tr
  'merhaba', 'selam', 'teşekkürler', 'teşekkür', 'lütfen', 'bir', 've', 'ile', 'için', 'mi', 'mı', 'mu', 'mü', 'ben',
  'sen', 'siz', 'biz', 'bu', 'şu', 'ne', 'nasıl', 'nerede', 'var', 'yok', 'istiyorum',
]);

/**
 * Lower case the way the database's ILIKE folds it: JavaScript turns «İ»
 * (Turkish capital dotted I) into «i» plus a combining dot, which no stored
 * title holds and PostgreSQL never produces (it folds «İ» to «i»), so
 * «İade» found nothing and «İstiyorum» was no stopword. Every other letter
 * keeps its length, so positions found in the folded text are the
 * original's (kbSnippet).
 */
export function kbSuggestFold(text: string): string {
  return text.toLowerCase().replace(/i\u0307/g, 'i');
}

/**
 * The words of a draft to search: every punctuation mark, symbol and
 * control character taken out (a draft is a sentence: «کفش؟», «سلام،» and
 * "shoes," are the words کفش, سلام and shoes; this also covers every
 * character the filter grammar and LIKE give a meaning, as widgetSearch.ts
 * kbSearchWords does, and a NUL, which the database refuses as text),
 * lower-cased as the database folds case (kbSuggestFold), without
 * stopwords and one-letter words, each once; the four longest (a tie goes
 * to the word typed later: the end of a draft is what is being written), in
 * the order they were typed. No word → nothing is searched.
 */
export function kbSuggestWords(query: string): string[] {
  const seen = new Map<string, number>();
  String(query || '')
    .slice(0, KB_SUGGEST_MAX_QUERY)
    .replace(/[\p{P}\p{S}\p{Cc}]/gu, ' ')
    .split(/\s+/)
    .map((w) => kbSuggestFold(w.trim()))
    .forEach((w, index) => {
      if (w.length < 2 || KB_SUGGEST_STOPWORDS.has(w)) return;
      seen.set(w, index); // the last place a repeated word was typed
    });
  return [...seen.entries()]
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1])
    .slice(0, KB_SUGGEST_MAX_WORDS)
    .sort((a, b) => a[1] - b[1])
    .map(([w]) => w);
}

/** The PostgREST `or=(...)` filter: any word in the title or the summary (never the text). */
export function kbSuggestOrFilter(words: string[]): string {
  return words.flatMap((w) => [`title.ilike.%${w}%`, `excerpt.ilike.%${w}%`]).join(',');
}

/** 'fa-IR' → 'fa'; a language the help center does not have → null. */
export function kbSuggestLocale(locale: unknown): 'fa' | 'en' | 'tr' | null {
  const short = String(locale ?? '').toLowerCase().split('-')[0];
  return short === 'fa' || short === 'en' || short === 'tr' ? short : null;
}

/**
 * Reading time of an article, in minutes: EXACTLY the formula the widget's
 * article view uses (public/widget/runtime-ext.js, `kbArticleMeta`): the
 * content with tags turned into spaces, words split on white space, 200 a
 * minute, rounded, at least 1. src/test/widget/kbSuggest.test.ts runs both
 * on one fixture set.
 */
export function kbReadingMinutes(content: unknown): number {
  const words = String(content || '').replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Text without tags, white space collapsed. */
function plain(text: unknown): string {
  return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Up to `max` characters of `text` around the first of `words` it contains:
 * from at most 30 characters before it, cut at word boundaries, with "…"
 * where something was cut. No match: the start of the text. Null for no text.
 */
export function kbSnippet(text: unknown, words: string[], max = KB_SUGGEST_SNIPPET): string | null {
  const body = plain(text);
  if (!body) return null;
  if (body.length <= max) return body;
  const lower = kbSuggestFold(body);
  const hits = words.map((w) => lower.indexOf(kbSuggestFold(w))).filter((i) => i >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, first - SNIPPET_LEAD);
  if (start > 0) {
    const space = body.indexOf(' ', start);
    // Start after the space that ends the cut word, unless that skips the match.
    start = space >= 0 && space < first ? space + 1 : start;
  }
  let end = Math.min(body.length, start + max);
  if (end < body.length) {
    const space = body.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

export interface KbSuggestRow {
  id: string;
  title: string | null;
  slug: string | null;
  excerpt: string | null;
  locale: string | null;
  updated_at: string | null;
}

export interface KbSuggestion {
  slug: string;
  title: string;
  snippet: string | null;
  /** The searched words found in the title or summary, as typed (lower-case). */
  matches: string[];
  readingMinutes: number | null;
}

/** The words of `words` that `row`'s title or summary contains. */
export function kbMatchedWords(row: { title?: string | null; excerpt?: string | null }, words: string[]): string[] {
  const title = kbSuggestFold(String(row.title || ''));
  const excerpt = kbSuggestFold(String(row.excerpt || ''));
  // The help search's words (kbSearchWords) are not folded: compared folded too.
  return words.filter((w) => title.includes(kbSuggestFold(w)) || excerpt.includes(kbSuggestFold(w)));
}

/** A word in the title counts 2, in the summary 1. */
function wordScore(row: { title?: string | null; excerpt?: string | null }, words: string[]): number {
  const title = kbSuggestFold(String(row.title || ''));
  const excerpt = kbSuggestFold(String(row.excerpt || ''));
  let score = 0;
  for (const w of words) {
    if (title.includes(w)) score += 2;
    if (excerpt.includes(w)) score += 1;
  }
  return score;
}

/** rankKbSuggestRows' order, for any word score. */
function rankByScore<T extends { locale?: string | null }>(rows: T[], scoreOf: (row: T) => number, limit: number, locale: string | null): T[] {
  return rows
    .map((row, index) => {
      const score = scoreOf(row);
      const bonus = locale && kbSuggestLocale(row.locale) === locale ? 0.5 : 0;
      return { row, index, score, rank: score + bonus };
    })
    .filter((r) => r.score >= KB_SUGGEST_MIN_SCORE)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((r) => r.row);
}

/**
 * Orders the matched rows: a word in the title counts 2, in the summary 1;
 * rows under KB_SUGGEST_MIN_SCORE are dropped; then 0.5 for an article in
 * the conversation's language, which only ever breaks a tie between equal
 * word scores; then the database's order (most recently updated first).
 */
export function rankKbSuggestRows<T extends { title?: string | null; excerpt?: string | null; locale?: string | null }>(
  rows: T[],
  words: string[],
  limit: number,
  locale: string | null,
): T[] {
  return rankByScore(rows, (row) => wordScore(row, words), limit, locale);
}

// ─── memos ────────────────────────────────────────────────────────────

const ROWS_TTL_MS = 60_000;
/** Answers that found something; past 60 s an entry is only reloaded, so this is ample at the ceiling's 1,800 a minute. */
const ROWS_MAX = 2_000;
/** Answers that found nothing (most drafts), in their own LRU: they never push a real one out. */
const ROWS_NEGATIVE_MAX = 2_000;
const MINUTES_MAX = 20_000;

/**
 * A matched article as the memo keeps it: what an answer shows of it, its
 * word score, and no summary (its snippet and matched words instead).
 */
interface KbSuggestHit {
  id: string;
  slug: string;
  title: string;
  locale: string | null;
  updated_at: string | null;
  score: number;
  snippet: string | null;
  matches: string[];
}

/** Every language an answer can be ranked for (kbSuggestLocale). */
const RANK_LOCALES = [null, 'fa', 'en', 'tr'] as const;

/**
 * What the memo keeps of the rows `words` matched: only those an answer can
 * show, whatever its language and limit (the first KB_SUGGEST_MAX_LIMIT of
 * the ranking for each language: a language only reorders equal word
 * scores), in the database's order, without their summaries. Ranking these
 * gives exactly the answer ranking every row would (rankKbSuggestRows), and
 * an entry is at most a dozen small records instead of KB_SUGGEST_WINDOW
 * rows with summaries of up to 2,000 characters.
 */
function hitsOf(rows: KbSuggestRow[], words: string[]): KbSuggestHit[] {
  const shown = new Set<KbSuggestRow>();
  for (const locale of RANK_LOCALES) {
    for (const row of rankKbSuggestRows(rows, words, KB_SUGGEST_MAX_LIMIT, locale)) shown.add(row);
  }
  return rows.filter((row) => shown.has(row)).map((row) => ({
    id: row.id,
    slug: String(row.slug),
    title: String(row.title ?? ''),
    locale: row.locale ?? null,
    updated_at: row.updated_at ?? null,
    score: wordScore(row, words),
    snippet: kbSnippet(row.excerpt, words),
    matches: kbMatchedWords(row, words),
  }));
}

/** The answerable articles per (workspace, sorted words) (hitsOf). Errors are never stored. */
const rowsCache = new MemoCache<KbSuggestHit[]>({
  name: 'kb-suggest',
  ttlMs: () => ROWS_TTL_MS,
  max: () => ROWS_MAX,
  isNegative: (hits) => hits.length === 0,
  negativeMax: () => ROWS_NEGATIVE_MAX,
  // A row list is cheap to rebuild and an edit should show: no stale serving.
  serveStale: () => false,
});

/** Reading minutes per `${id}@${updated_at}` (insertion order = age). */
const minutesCache = new Map<string, number>();

function rememberMinutes(key: string, minutes: number): void {
  minutesCache.delete(key);
  minutesCache.set(key, minutes);
  while (minutesCache.size > MINUTES_MAX) minutesCache.delete(minutesCache.keys().next().value as string);
}

async function readRows(config: ServerConfig, workspaceId: string, words: string[]): Promise<KbSuggestHit[]> {
  const lock = await resolveKbLock(config, workspaceId);
  const { data, error } = await publicArticles(config, workspaceId, 'id, title, slug, excerpt, locale, updated_at', lock)
    .eq('visible_in_widget', true)
    .or(kbSuggestOrFilter(words))
    .order('updated_at', { ascending: false })
    .limit(KB_SUGGEST_WINDOW);
  if (error) throw new Error(`kb-suggest read failed: ${error.message}`);
  return hitsOf(((data ?? []) as unknown as KbSuggestRow[]).filter((r) => r && r.id && r.slug), words);
}

async function readingMinutesOf(config: ServerConfig, workspaceId: string, rows: Array<{ id: string; updated_at: string | null }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: Array<{ id: string; updated_at: string | null }> = [];
  for (const row of rows) {
    const hit = minutesCache.get(`${row.id}@${row.updated_at ?? ''}`);
    if (hit !== undefined) out.set(row.id, hit);
    else missing.push(row);
  }
  if (!missing.length) return out;
  const { data, error } = await getServiceClient(config)
    .from('knowledge_base_articles')
    .select('id, content, updated_at')
    .eq('workspace_id', workspaceId)
    .in('id', missing.map((r) => r.id));
  if (error) return out; // reading time is decoration: the answers stand without it
  for (const r of (data ?? []) as Array<{ id: string; content: string | null; updated_at: string | null }>) {
    const minutes = kbReadingMinutes(r.content);
    rememberMinutes(`${r.id}@${r.updated_at ?? ''}`, minutes);
    out.set(r.id, minutes);
  }
  return out;
}

/**
 * The instant answers for `words` (kbSuggestWords) in a workspace. Throws on
 * a database error (the route answers `[]`).
 */
export async function suggestKbArticles(
  config: ServerConfig,
  workspaceId: string,
  words: string[],
  limit: number,
  locale: string | null,
): Promise<KbSuggestion[]> {
  if (!words.length) return [];
  const key = `${workspaceId}|${[...words].sort().join(' ')}`;
  const hits = await rowsCache.get(key, () => readRows(config, workspaceId, words));
  const ranked = rankByScore(hits, (hit) => hit.score, Math.min(KB_SUGGEST_MAX_LIMIT, Math.max(1, limit)), kbSuggestLocale(locale));
  if (!ranked.length) return [];
  const minutes = await readingMinutesOf(config, workspaceId, ranked);
  return ranked.map((hit) => ({
    slug: hit.slug,
    title: hit.title,
    snippet: hit.snippet,
    // In this draft's order (the memo is shared by every order of its words).
    matches: words.filter((w) => hit.matches.includes(w)),
    readingMinutes: minutes.get(hit.id) ?? null,
  }));
}

/** Test-only — forget both memos. */
export function __resetKbSuggestCachesForTests(): void {
  rowsCache.clear();
  minutesCache.clear();
}

/** Test-only — the memos' sizes. */
export function __kbSuggestCacheSizesForTests(): { rows: number; minutes: number } {
  return { rows: rowsCache.sizes()[0] + rowsCache.sizes()[1], minutes: minutesCache.size };
}
