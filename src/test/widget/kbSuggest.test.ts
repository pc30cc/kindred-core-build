// @vitest-environment node
/**
 * Instant answers (GET /api/widget/kb-suggest, server/routes/widgetKbSuggest.ts
 * and server/services/knowledge-base/widgetSuggest.ts), through the REAL
 * widget mount chain of server/index.ts (CORS, per-IP, per-workspace and
 * per-session limiters, the widget token and origin checks, the route's own
 * `kb_suggest` bucket and process ceiling) over an in-memory data layer:
 *
 *   - the words of a draft: stopwords out, one-letter words out, at most the
 *     four longest; a draft with nothing to search reads nothing;
 *   - only published, widget-visible articles, title or summary, a word in
 *     the title or two in the summary, the conversation's language as the
 *     tie-break; matches as words, a snippet window, the reading time of
 *     runtime-ext.js's own formula (one shared fixture);
 *   - the memos: an identical draft reads nothing again, a reading time is
 *     read once per article version;
 *   - its limits are its own: the help center's 2,400 searches a minute
 *     never refuse an instant answer, nor the reverse; the 31st request of
 *     one address in a minute is refused with retry_after;
 *   - /api/widget/kb/search?match=words also carries snippet + matches; the
 *     help center's own search (no match=words) answers exactly as before.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, SHOP_ORIGIN, type FakeDb } from './widgetConfigFakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-kb-suggest';
const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb, or: [] as string[] }));

/** The fake data layer, recording every `.or()` filter (it does not apply them). */
function recording(builder: unknown): unknown {
  return new Proxy(builder as object, {
    get(target, prop) {
      if (prop === 'or') return (f: string) => { holder.or.push(f); return recording(builder); };
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function' || prop === 'then') return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out === target || (out && typeof out === 'object' && !(out instanceof Promise)) ? recording(out) : out;
      };
    },
  });
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => recording(holder.db.client.from(t)),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { widgetKbRouter } = await import('../../../server/routes/kb.js');
const { jsonBodyParser } = await import('../../../server/middleware/bodyParsers.js');
const { widgetCorsMiddleware } = await import('../../../server/middleware/widgetCors.js');
const sec = await import('../../../server/middleware/security.js');
const { createSessionToken, __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const suggest = await import('../../../server/services/knowledge-base/widgetSuggest.js');
const { parseLogicValue } = await import('../../../server/db/postgrest/grammar.js');

const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
function buildApp() {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = CONFIG; next(); });
  // server/index.ts, in order.
  app.use(jsonBodyParser());
  app.use(cookieParser());
  app.use('/api/widget/kb', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.publicKbGlobalCeiling, sec.publicKbRateLimiter, widgetKbRouter);
  app.use('/api/widget', widgetCorsMiddleware(), sec.widgetRateLimiter, sec.widgetWorkspaceRateLimiter, sec.widgetSessionRateLimiter, widgetRouter);
  return app;
}
const app = buildApp();

let ipSeq = 1;
const freshIp = () => `45.61.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`;
const token = () => createSessionToken(WS, SHOP_ORIGIN);

function ask(query: Record<string, unknown>, opts: { ip?: string; token?: string | null } = {}) {
  const r = request(app).get('/api/widget/kb-suggest').query(query)
    .set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', opts.ip ?? freshIp());
  return opts.token === null ? r : r.set('X-Widget-Token', opts.token ?? token());
}

type Row = Record<string, unknown>;
const UPDATED = '2026-10-10T00:00:00Z';
function article(slug: string, title: string, excerpt: string, extra: Row = {}): Row {
  return {
    id: `id-${slug}`, workspace_id: WS, slug, title, excerpt, content: 'متن کوتاه', locale: 'fa',
    status: 'published', visible_in_widget: true, updated_at: UPDATED, created_at: '2026-01-01T00:00:00Z', ...extra,
  };
}
const ARTICLES: Row[] = [
  article('returns', 'شرایط مرجوعی کفش', 'تا ۷ روز می‌توانید کفش را برگردانید', { content: 'کلمه '.repeat(450) }),
  article('sizes', 'راهنمای سایز', 'جدول سایز کفش و لباس', { updated_at: '2026-10-12T00:00:00Z' }),
  article('shipping', 'زمان ارسال', 'ارسال سفارش‌ها', { updated_at: '2026-10-11T00:00:00Z' }),
  article('hidden', 'مرجوعی کفش (داخلی)', '', { visible_in_widget: false }),
  article('draft', 'مرجوعی کفش پیش‌نویس', '', { status: 'draft' }),
  article('en-returns', 'Shoe returns', 'Return shoes within 7 days', { locale: 'en' }),
  article('other-ws', 'مرجوعی کفش', '', { workspace_id: 'ffffffff-0000-4000-8000-000000000000' }),
];

function fresh(articles: Row[] = ARTICLES) {
  const tables = widgetScenarioTables({ edition: 'iran', ai: false, smart: false }) as Record<string, Row[]>;
  tables.knowledge_base_articles = articles.map((a) => ({ ...a }));
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  holder.or = [];
}

beforeEach(async () => {
  fresh();
  suggest.__resetKbSuggestCachesForTests();
  __resetWidgetRateLimitsForTests();
  (await import('../../../server/services/billing/locks/state.js')).clearLockStateCache();
  (await import('../../../server/services/widget/public.js')).__resetWidgetOriginCaches();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
});
afterAll(() => { delete process.env.WIDGET_KB_SUGGEST_GLOBAL_PER_MIN; });

describe('the words of a draft', () => {
  it('drops greetings, filler and one-letter words, in fa, en and tr', () => {
    expect(suggest.kbSuggestWords('سلام، لطفا')).toEqual([]);
    expect(suggest.kbSuggestWords('سلام')).toEqual([]);
    expect(suggest.kbSuggestWords('hi thanks')).toEqual([]);
    expect(suggest.kbSuggestWords('Merhaba lütfen')).toEqual([]);
    expect(suggest.kbSuggestWords('سلام می‌خواهم کفش را مرجوعی کنم')).toEqual(['کفش', 'مرجوعی', 'کنم']);
    expect(suggest.kbSuggestWords('I want to return my shoes')).toEqual(['return', 'shoes']);
  });

  it('keeps the four longest (a tie to the later word), in typing order, each once', () => {
    // Lengths 6, 4, 4, then a tie of 2-letter words: the one typed last ('aa', again at the end).
    expect(suggest.kbSuggestWords('aa bbbb cc dddddd ee ffff gg aa')).toEqual(['bbbb', 'dddddd', 'ffff', 'aa']);
    expect(suggest.kbSuggestWords('ab cd ef gh ij')).toEqual(['cd', 'ef', 'gh', 'ij']);
    expect(suggest.kbSuggestWords('Shoes SHOES shoes')).toEqual(['shoes']);
  });

  it('a sentence\'s punctuation is no part of a word', () => {
    expect(suggest.kbSuggestWords('سلام، کفش؟ «مرجوعی»!')).toEqual(['کفش', 'مرجوعی']);
    expect(suggest.kbSuggestWords('Shoes, returns? (refund) — e-mail')).toEqual(['shoes', 'returns', 'refund', 'mail']);
    expect(suggest.kbSuggestWords('می‌خواهم کفش')).toEqual(['کفش']);
  });

  it('takes the grammar\'s and LIKE\'s own characters out, and reads only the start of a draft', () => {
    expect(suggest.kbSuggestWords('100%_off*\\ "deal" {x} (new),')).toEqual(['100', 'off', 'deal', 'new']);
    expect(suggest.kbSuggestWords(`${'x'.repeat(130)} shoes`)).toEqual(['x'.repeat(120)]);
  });

  it('case folds as the database\'s ILIKE does: a Turkish «İ» is «i», never «i» + a combining dot', () => {
    expect(suggest.kbSuggestWords('İade İstiyorum')).toEqual(['iade']);
    expect(suggest.kbSuggestFold('İADE İptal I')).toBe('iade iptal i');
    const rows = [{ title: 'İade politikası', excerpt: 'İptal ve İade', locale: 'tr' }];
    expect(suggest.rankKbSuggestRows(rows, suggest.kbSuggestWords('İade'), 3, 'tr')).toHaveLength(1);
    expect(suggest.kbMatchedWords(rows[0], ['iade', 'iptal', 'kargo'])).toEqual(['iade', 'iptal']);
    // The help search's own words are not folded (kbSearchWords): matched, and returned, as given.
    expect(suggest.kbMatchedWords(rows[0], ['İade'.toLocaleLowerCase()])).toEqual(['İade'.toLocaleLowerCase()]);
    // The window is around «İade» itself (JavaScript's own lower case found no «iade» there: the start of the text).
    expect(suggest.kbSnippet(`${'x '.repeat(80)}İade politikası`, ['iade'], 40)).toBe('…x x x x x x x x x x x x x x İade…');
  });

  it('control characters split words (a NUL never reaches the database); the ZWNJ of a Persian word stays', () => {
    expect(suggest.kbSuggestWords('کفش\u0000مرجوعی\u0007shoes\u001b')).toEqual(['کفش', 'مرجوعی', 'shoes']);
    expect(suggest.kbSuggestWords('پیش‌نویس')).toEqual(['پیش‌نویس']);
  });

  it('the filter is valid PostgREST logic whatever was typed, title and summary only', () => {
    for (const q of ['سلام, سفارشم', 'price (new)', 'a,b)c(d', '"quoted', '{x}', 'x.y.z', 'title.eq.1', 'c++ 50%', 'a:b']) {
      const words = suggest.kbSuggestWords(q);
      if (!words.length) continue;
      const filter = suggest.kbSuggestOrFilter(words);
      expect(filter).not.toMatch(/content/);
      const tree = parseLogicValue('or', false, `(${filter})`, 'or');
      expect(tree.kind === 'expr' && tree.children).toHaveLength(words.length * 2);
    }
  });
});

describe('ranking', () => {
  const rows = [
    { slug: 'a', title: 'زمان ارسال', excerpt: '', locale: 'fa' },
    { slug: 'b', title: 'مرجوعی', excerpt: 'ارسال کالا', locale: 'fa' },
    { slug: 'c', title: 'ارسال سریع', excerpt: '', locale: 'en' },
    { slug: 'd', title: 'هزینه', excerpt: 'ارسال و سفارش', locale: 'fa' },
  ];
  it('a word in the title passes; one word only in the summary does not; two in the summary do', () => {
    expect(suggest.rankKbSuggestRows(rows, ['ارسال'], 3, 'fa').map((r) => r.slug)).toEqual(['a', 'c']);
    expect(suggest.rankKbSuggestRows(rows, ['ارسال', 'سفارش'], 3, 'fa').map((r) => r.slug)).toEqual(['a', 'd', 'c']);
  });
  it('the conversation\'s language breaks a tie, never a word score', () => {
    expect(suggest.rankKbSuggestRows(rows, ['ارسال'], 3, 'en').map((r) => r.slug)).toEqual(['c', 'a']);
    expect(suggest.rankKbSuggestRows(rows, ['ارسال'], 3, null).map((r) => r.slug)).toEqual(['a', 'c']);
    expect(suggest.rankKbSuggestRows([{ title: 'x ارسال', excerpt: 'سفارش', locale: 'en' }, { title: 'ارسال', excerpt: '', locale: 'fa' }], ['ارسال', 'سفارش'], 2, 'fa')[0].locale).toBe('en');
  });
  it('limit', () => {
    expect(suggest.rankKbSuggestRows(rows, ['ارسال', 'سفارش'], 1, 'fa')).toHaveLength(1);
  });
});

describe('snippet', () => {
  it('a window around the first match, cut at spaces, with … where cut', () => {
    const text = `${'آغاز '.repeat(20)}شرایط مرجوعی کفش تا هفت روز است و ${'پایان '.repeat(30)}`;
    const s = suggest.kbSnippet(text, ['مرجوعی'], 60)!;
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('مرجوعی');
    expect(s.length).toBeLessThanOrEqual(62);
    expect(s.indexOf('مرجوعی')).toBeLessThanOrEqual(32);
    expect(s.slice(1, -1)).not.toMatch(/^\s|\s$/);
  });
  it('short text whole, no match from the start, tags out, nothing for no text', () => {
    expect(suggest.kbSnippet('<b>کوتاه</b>  است', ['x'])).toBe('کوتاه است');
    expect(suggest.kbSnippet(`${'a '.repeat(100)}`, ['zz'], 20)).toBe(`${'a '.repeat(10).trim()}…`);
    expect(suggest.kbSnippet(null, ['x'])).toBeNull();
    expect(suggest.kbSnippet('   ', ['x'])).toBeNull();
  });
});

describe('reading minutes: the same formula as the widget', () => {
  // runtime-ext.js's article view (kbArticleMeta), taken from the shipped
  // file, run on the same fixtures as the server's kbReadingMinutes.
  const ext = readFileSync(resolve(__dirname, '../../../public/widget/runtime-ext.js'), 'utf8')
    + readFileSync(resolve(__dirname, '../../../public/widget/runtime-late.js'), 'utf8');
  const wordsExpr = /String\(article\.content \|\| ''\)\.replace\(\/<\[\^>\]\*>\/g, ' '\)\.split\(\/\\s\+\/\)\.filter\(Boolean\)\.length/;
  const minutesExpr = /Math\.max\(1, Math\.round\(words \/ 200\)\)/;
  it('the widget still computes it this way', () => {
    expect(ext).toMatch(wordsExpr);
    expect(ext).toMatch(minutesExpr);
  });
  const widgetMinutes = new Function('article', `var words = ${wordsExpr.source.replace(/\\(.)/g, '$1')}; return ${minutesExpr.source.replace(/\\(.)/g, '$1')};`) as (a: { content: unknown }) => number;
  const FIXTURES: unknown[] = [
    '', null, undefined, 'one', 'کلمه '.repeat(99), 'کلمه '.repeat(100), 'کلمه '.repeat(299), 'کلمه '.repeat(300), 'کلمه '.repeat(301),
    `<p>${'word '.repeat(450)}</p><img src="x">`, '<h1>a</h1><p>b</p>'.repeat(250), 'a b\tc\nd', 'x'.repeat(5000),
    `${'متن‌ها '.repeat(1000)}`, 42,
  ];
  it.each(FIXTURES.map((f, i) => [i, f]))('fixture %i', (_i, content) => {
    expect(suggest.kbReadingMinutes(content)).toBe(widgetMinutes({ content }));
  });
});

describe('GET /api/widget/kb-suggest', () => {
  it('answers the draft: published, widget-visible, this workspace only, with matches, snippet and reading time', async () => {
    const res = await ask({ workspace_id: WS, q: 'سلام میخوام کفش مرجوعی کنم', locale: 'fa', limit: '2' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // Not the hidden one, the draft or another workspace's (each would rank
    // first); not «راهنمای سایز» either: one word in its summary only.
    expect(res.body.results.map((r: Row) => r.slug)).toEqual(['returns']);
    expect(res.body.results[0]).toEqual({
      slug: 'returns', title: 'شرایط مرجوعی کفش', snippet: 'تا ۷ روز می‌توانید کفش را برگردانید',
      matches: ['کفش', 'مرجوعی'], readingMinutes: 2,
    });
    // Two words in a summary are enough.
    const two = await ask({ workspace_id: WS, q: 'کفش لباس', locale: 'fa' });
    expect(two.body.results.map((r: Row) => r.slug)).toEqual(['returns', 'sizes']);
    expect(Object.keys(two.body.results[1]).sort()).toEqual(['matches', 'readingMinutes', 'slug', 'snippet', 'title']);
    expect(two.body.results[1]).toMatchObject({ matches: ['کفش', 'لباس'], readingMinutes: 1 });
    // Title or summary, any word; never the text.
    expect(holder.or.some((f) => f.includes('title.ilike.%کفش%') && f.includes('excerpt.ilike.%مرجوعی%') && !f.includes('content'))).toBe(true);
  });

  it('the workspace comes from the token: none given is the token\'s; another is 403; no token is 401', async () => {
    expect((await ask({ q: 'مرجوعی کفش' })).body.results.length).toBeGreaterThan(0);
    const other = await ask({ workspace_id: 'ffffffff-0000-4000-8000-000000000000', q: 'مرجوعی کفش' });
    expect([other.status, other.body.code]).toEqual([403, 'WORKSPACE_MISMATCH']);
    expect((await ask({ workspace_id: 'not-a-uuid', q: 'مرجوعی کفش' })).status).toBe(403);
    expect((await ask({ workspace_id: WS, q: 'مرجوعی کفش' }, { token: null })).status).toBe(401);
  });

  it('a draft with nothing to search reads nothing', async () => {
    holder.db.resetCalls();
    for (const q of ['سلام', 'hi thanks', 'و', ' , ( ) ', 'merhaba']) {
      const res = await ask({ workspace_id: WS, q });
      expect(res.body).toEqual({ results: [] });
    }
    expect(holder.db.calls.log.filter((l) => l === 'from:knowledge_base_articles')).toEqual([]);
  });

  it('bad input answers no results: no q, a q over 200, a bad locale', async () => {
    expect((await ask({ workspace_id: WS })).body).toEqual({ results: [] });
    expect((await ask({ workspace_id: WS, q: 'کفش '.repeat(80) })).body).toEqual({ results: [] });
    expect((await ask({ workspace_id: WS, q: 'کفش', locale: 'x' })).body).toEqual({ results: [] });
  });

  it('limit is clamped to 1..3 (default 2)', async () => {
    const many = Array.from({ length: 6 }, (_, i) => article(`k${i}`, `کفش ${i}`, ''));
    fresh(many);
    expect((await ask({ workspace_id: WS, q: 'کفش' })).body.results).toHaveLength(2);
    suggest.__resetKbSuggestCachesForTests();
    expect((await ask({ workspace_id: WS, q: 'کفش', limit: '9' })).body.results).toHaveLength(3);
    expect((await ask({ workspace_id: WS, q: 'کفش', limit: '0' })).body.results).toHaveLength(1);
    expect((await ask({ workspace_id: WS, q: 'کفش', limit: 'lots' })).body.results).toHaveLength(2);
  });

  it('an identical draft reads nothing again; a reading time is read once per article version', async () => {
    await ask({ workspace_id: WS, q: 'مرجوعی کفش' });
    holder.db.resetCalls();
    const again = await ask({ workspace_id: WS, q: 'کفش مرجوعی' }); // the same words, in another order
    expect(again.body.results[0].slug).toBe('returns');
    expect(holder.db.calls.log.filter((l) => l === 'from:knowledge_base_articles')).toEqual([]);
    // Another draft that finds the same articles: their rows again, their reading time not.
    await ask({ workspace_id: WS, q: 'کفش' });
    expect(holder.db.calls.log.filter((l) => l === 'from:knowledge_base_articles')).toHaveLength(1);
  });

  it('a database error answers no results, and is not remembered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    holder.db.options.failingTables = new Set(['knowledge_base_articles']);
    expect((await ask({ workspace_id: WS, q: 'مرجوعی کفش' })).body).toEqual({ results: [] });
    holder.db.options.failingTables = new Set();
    expect((await ask({ workspace_id: WS, q: 'مرجوعی کفش' })).body.results.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('the memos are bounded', () => {
    expect(suggest.__kbSuggestCacheSizesForTests()).toEqual({ rows: 0, minutes: 0 });
    const src = readFileSync(resolve(__dirname, '../../../server/services/knowledge-base/widgetSuggest.ts'), 'utf8');
    expect(src).toMatch(/ROWS_MAX = 2_000/);
    expect(src).toMatch(/ROWS_NEGATIVE_MAX = 2_000/);
    expect(src).toMatch(/MINUTES_MAX = 20_000/);
  });

  it('a remembered answer keeps no summaries, yet answers every language and limit as all the rows would', async () => {
    // 24 matching rows (the window) with long summaries, in three languages:
    // every title has a word (2), every fifth summary the other (3), so the
    // language decides which of the equal scores come first.
    const long = 'متن '.repeat(400);
    const rows = Array.from({ length: 24 }, (_, i) => article(
      `k${i}`,
      `کفش ${i}`,
      i % 5 === 0 ? `${'متن '.repeat(i)}مرجوعی ${long}` : long,
      { locale: ['fa', 'en', 'tr'][i % 3], updated_at: `2026-10-${String(10 + (i % 9)).padStart(2, '0')}T0${i % 10}:00:00Z` },
    ));
    fresh(rows);
    const words = suggest.kbSuggestWords('کفش مرجوعی');
    // What ranking every row (no memo) answers, read from the same rows in the database's order.
    const dbOrder = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    for (const locale of ['fa', 'en', 'tr', 'de']) {
      for (const limit of [1, 2, 3]) {
        const res = await ask({ workspace_id: WS, q: 'کفش مرجوعی', locale, limit: String(limit) });
        const expected = suggest.rankKbSuggestRows(dbOrder as Array<Row & { title: string; excerpt: string; locale: string }>, words, limit, suggest.kbSuggestLocale(locale));
        expect(res.body.results.map((r: Row) => r.slug)).toEqual(expected.map((r) => r.slug));
        expect(res.body.results.map((r: Row) => r.snippet)).toEqual(expected.map((r) => suggest.kbSnippet(r.excerpt, words)));
      }
    }
    // Twelve answers from one remembered entry.
    expect(suggest.__kbSuggestCacheSizesForTests().rows).toBe(1);
  });
});

describe('GET /api/widget/kb/search: snippet and matches only with match=words', () => {
  it('match=words: each result carries snippet + matches', async () => {
    const res = await request(app).get('/api/widget/kb/search').query({ workspace_id: WS, q: 'مرجوعی کفش', match: 'words' })
      .set('X-Forwarded-For', freshIp());
    expect(res.status).toBe(200);
    const top = res.body.results[0];
    expect(top.slug).toBe('returns');
    expect(top.matches).toEqual(['مرجوعی', 'کفش']);
    expect(top.snippet).toBe('تا ۷ روز می‌توانید کفش را برگردانید');
  });

  it('without it (the help center): the rows exactly as read, no snippet, no matches', async () => {
    const res = await request(app).get('/api/widget/kb/search').query({ workspace_id: WS, q: 'کفش' }).set('X-Forwarded-For', freshIp());
    expect(res.status).toBe(200);
    for (const row of res.body.results) {
      expect(Object.keys(row).sort()).toEqual(['excerpt', 'id', 'locale', 'slug', 'title']);
    }
  });
});

describe('its limits are its own', () => {
  it('the 31st request of one address in a minute is refused, with retry_after; the help center is not', async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i += 1) expect((await ask({ workspace_id: WS, q: 'کفش' }, { ip })).status).toBe(200);
    const refused = await ask({ workspace_id: WS, q: 'کفش' }, { ip });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(refused.body.retry_after).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    const help = await request(app).get('/api/widget/kb/search').query({ workspace_id: WS, q: 'کفش', match: 'words' })
      .set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', ip);
    expect(help.status).toBe(200);
  });

  it('its process ceiling refuses instant answers only (scope kb-suggest)', async () => {
    process.env.WIDGET_KB_SUGGEST_GLOBAL_PER_MIN = '40';
    let res = await ask({ workspace_id: WS, q: 'کفش' });
    for (let i = 0; i < 45 && res.status === 200; i += 1) res = await ask({ workspace_id: WS, q: 'کفش' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'PREAUTH_GLOBAL_LIMIT', scope: 'kb-suggest' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const help = await request(app).get('/api/widget/kb/search').query({ workspace_id: WS, q: 'کفش' })
      .set('Origin', SHOP_ORIGIN).set('X-Forwarded-For', freshIp());
    expect(help.status).toBe(200);
    delete process.env.WIDGET_KB_SUGGEST_GLOBAL_PER_MIN;
    expect((await ask({ workspace_id: WS, q: 'کفش' })).status).toBe(200);
  });

  it('2,400 help searches a minute (its ceiling) never refuse an instant answer', async () => {
    let refused = null as null | request.Response;
    for (let i = 0; i < 2_401 && !refused; i += 1) {
      const res = await request(app).get('/api/widget/kb/search').query({ workspace_id: WS, q: 'کفش' }).set('X-Forwarded-For', freshIp());
      if (res.status === 429) refused = res;
    }
    expect(refused?.body).toMatchObject({ code: 'PREAUTH_GLOBAL_LIMIT', scope: 'public-kb' });
    expect((await ask({ workspace_id: WS, q: 'کفش' })).status).toBe(200);
  }, 120_000);
});
