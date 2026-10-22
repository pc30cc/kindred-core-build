/**
 * The widget's search as you type (GET /api/widget/kb/search with
 * `match=words`, sent by runtime-ext.js for a renderer declaring `kbSearch`):
 * the query is searched word by word, with every character the PostgREST
 * filter grammar or LIKE gives a meaning taken out, and the articles that
 * contain more of the words come first
 * (server/services/knowledge-base/widgetSearch.ts).
 *
 * As one phrase, «سلام, سفارشم» makes the filter unparsable (the route then
 * answers no results) and "ارسال سفارش" never finds «زمان ارسال و پیگیری
 * سفارش». Without `match=words` (the help center's search page of every
 * workspace calls this route too) the query stays the one phrase it always
 * was: this change does not alter any help center.
 */
import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseLogicValue } from '../../../server/db/postgrest/grammar';
import {
  KB_SEARCH_MAX_WORDS,
  kbSearchOrFilter,
  kbSearchPhrase,
  kbSearchText,
  kbSearchWindow,
  kbSearchWords,
  rankKbSearchRows,
} from '../../../server/services/knowledge-base/widgetSearch';

describe('the words of a query', () => {
  it('splits on spaces and takes out the grammar\'s and LIKE\'s own characters', () => {
    expect(kbSearchWords('سلام, سفارشم (جدید)')).toEqual(['سلام', 'سفارشم', 'جدید']);
    expect(kbSearchWords('100%_off*\\ "deal" {x}')).toEqual(['100', 'off', 'deal']);
  });

  it('drops one-letter words unless they are all there is, and repeats', () => {
    expect(kbSearchWords('ارسال و سفارش ارسال')).toEqual(['ارسال', 'سفارش']);
    expect(kbSearchWords('و')).toEqual(['و']);
    expect(kbSearchWords(' , ( ) ')).toEqual([]);
  });

  it('searches at most a handful of words', () => {
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(kbSearchWords(many)).toHaveLength(KB_SEARCH_MAX_WORDS);
  });
});

describe('the filter it builds', () => {
  it('is always valid PostgREST logic, whatever the visitor typed', () => {
    for (const q of ['سلام, سفارشم', 'price (new)', 'a,b)c(d', '"quoted', '{x}', 'x.y.z', 'title.eq.1']) {
      const words = kbSearchWords(q);
      if (!words.length) continue;
      const tree = parseLogicValue('or', false, `(${kbSearchOrFilter(words)})`, 'or');
      expect(tree.kind === 'expr' && tree.children).toHaveLength(words.length * 3);
    }
  });

  it('the raw query used to break it (the bug this fixes)', () => {
    const like = '%سلام, سفارشم%';
    expect(() => parseLogicValue('or', false, `(title.ilike.${like},excerpt.ilike.${like})`, 'or')).toThrow();
  });

  it('matches each word in the title, the summary and the text', () => {
    expect(kbSearchOrFilter(['ارسال', 'سفارش'])).toBe(
      'title.ilike.%ارسال%,excerpt.ilike.%ارسال%,content.ilike.%ارسال%,' +
      'title.ilike.%سفارش%,excerpt.ilike.%سفارش%,content.ilike.%سفارش%',
    );
  });
});

describe('the order of the answers', () => {
  const rows = [
    { slug: 'text-only', title: 'راهنمای سایز', excerpt: '' },
    { slug: 'one-in-title', title: 'زمان ارسال', excerpt: '' },
    { slug: 'both-in-title', title: 'زمان ارسال و پیگیری سفارش', excerpt: '' },
    { slug: 'one-in-summary', title: 'مرجوعی', excerpt: 'شرایط ارسال کالا' },
  ];

  it('more words, and words in the title, come first; ties keep the database order', () => {
    expect(rankKbSearchRows(rows, ['ارسال', 'سفارش'], 8).map((r) => r.slug))
      .toEqual(['both-in-title', 'one-in-title', 'one-in-summary', 'text-only']);
  });

  it('returns at most `limit`, reading a wider window first', () => {
    expect(rankKbSearchRows(rows, ['ارسال'], 2)).toHaveLength(2);
    expect(kbSearchWindow(8)).toBe(24);
    expect(kbSearchWindow(20)).toBe(50);
  });
});

describe('a control character or a Turkish «İ» (every help search), and nothing else', () => {
  // The three as they were before, for the queries that hold neither (and,
  // for the order, rows that hold no «İ»: see the last case).
  const wordsBefore = (query: string) => {
    const words = String(query || '').replace(/[,()"{}%_*\\]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean);
    const long = words.filter((w) => w.length >= 2);
    return Array.from(new Set((long.length ? long : words).map((w) => w.toLocaleLowerCase()))).slice(0, KB_SEARCH_MAX_WORDS);
  };
  const phraseBefore = (q: string) => `%${q.replace(/[%_]/g, ' ')}%`;
  const rankBefore = <T extends { title?: string | null; excerpt?: string | null }>(rows: T[], words: string[], limit: number) => {
    const score = (row: T) => words.reduce((s, w) => s
      + (String(row.title || '').toLocaleLowerCase().includes(w) ? 2 : 0)
      + (String(row.excerpt || '').toLocaleLowerCase().includes(w) ? 1 : 0), 0);
    return rows.map((row, index) => ({ row, index, score: score(row) }))
      .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((r) => r.row);
  };
  const QUERIES = [
    'سلام, سفارشم (جدید)', 'ارسال و سفارش ارسال', 'می‌خواهم سفارش را پیگیری کنم', 'Price (NEW) 100%_off', 'Kargo ÜCRETI ılık ŞIK',
    'IADE süreci', 'Straße GROSS', 'ΟΔΟΣ οδός', 'a', ' ', 'x.y.z title.eq.1', 'one two three four five six seven eight',
  ];
  const ROWS = [
    { slug: 'a', title: 'Kargo ücreti', excerpt: 'Şık paket' },
    { slug: 'b', title: 'iade süreci', excerpt: 'ılık' },
    { slug: 'c', title: 'زمان ارسال و پیگیری سفارش', excerpt: 'کد رهگیری' },
    { slug: 'd', title: 'Price list', excerpt: 'new 100 off' },
    { slug: 'e', title: 'ΟΔΟΣ', excerpt: 'straße' },
  ];

  it('the same words, phrase and order as before for every query without either, over rows without «İ»', () => {
    for (const q of QUERIES) {
      // As typed (the plain ILIKE of a database before migration 280a): as before.
      expect(kbSearchWords(q, false), q).toEqual(wordsBefore(q));
      // Folded (V-30): the same words, the Persian ZWNJ taken out (the only
      // thing the fold changes in these queries).
      expect(kbSearchWords(q), q).toEqual(wordsBefore(q).map((w) => w.replace(/\u200c/g, '')));
      expect(kbSearchPhrase(q), q).toBe(phraseBefore(q));
      expect(kbSearchText(q), q).toBe(q);
      expect(rankKbSearchRows(ROWS, kbSearchWords(q), 5).map((r) => r.slug), q).toEqual(rankBefore(ROWS, wordsBefore(q), 5).map((r) => r.slug));
    }
  });

  it('a control character is a space; a query of nothing else searches nothing', () => {
    expect(kbSearchWords('سفارش\u0000ارسال\u0007کد')).toEqual(['سفارش', 'ارسال', 'کد']);
    expect(kbSearchPhrase('İade\u0000politikası')).toBe('%İade politikası%');
    expect(kbSearchText('a\u0000b\u001fc\u007fd\u0085e')).toBe('a b c d e');
    expect(kbSearchPhrase('\u0000\u0000')).toBeNull();
    // The Persian ZWNJ is a letter-joiner (Cf), not a control character: it
    // does not split the word; the fold (V-30) takes it out of it.
    expect(kbSearchWords('می‌خواهم', false)).toEqual(['می‌خواهم']);
    expect(kbSearchWords('می‌خواهم')).toEqual(['میخواهم']);
  });

  it('«İ» is lower-cased as ILIKE folds it, and ranks and matches its title', () => {
    expect(kbSearchWords('İade İSTİYORUM')).toEqual(['iade', 'istiyorum']);
    expect('İade'.toLocaleLowerCase()).not.toBe('iade');
    const rows = [{ slug: 'x', title: 'Kargo', excerpt: '' }, { slug: 'tr', title: 'İade politikası', excerpt: '' }];
    expect(rankKbSearchRows(rows, kbSearchWords('İade'), 2).map((r) => r.slug)).toEqual(['tr', 'x']);
  });

  it('an article\'s «İ» now counts for a query without one too: the rows are folded as the words are (the one change of order)', () => {
    // As the database returns them (newest first): both match `iade` (ILIKE folds «İ»).
    const rows = [
      { slug: 'kargo', title: 'Kargo ücreti', excerpt: 'iade için kargo' },
      { slug: 'iade', title: 'İade politikası', excerpt: '' },
      { slug: 'summary', title: 'Sipariş', excerpt: 'İADE süresi' },
    ];
    for (const q of ['iade', 'IADE', 'iade süresi']) {
      expect(kbSearchWords(q), q).toEqual(wordsBefore(q));
      // Before: «İade» lower-cased to «i̇ade», which holds no `iade`, so the title scored nothing.
      expect(rankBefore(rows, wordsBefore(q), 3).map((r) => r.slug), q)
        .toEqual(q === 'iade süresi' ? ['kargo', 'summary', 'iade'] : ['kargo', 'iade', 'summary']);
    }
    expect(rankKbSearchRows(rows, kbSearchWords('iade'), 3).map((r) => r.slug)).toEqual(['iade', 'kargo', 'summary']);
    expect(rankKbSearchRows(rows, kbSearchWords('IADE'), 3).map((r) => r.slug)).toEqual(['iade', 'kargo', 'summary']);
    expect(rankKbSearchRows(rows, kbSearchWords('iade süresi'), 3).map((r) => r.slug)).toEqual(['iade', 'summary', 'kargo']);
  });
});

// ─── The route, against a recording fake of the data layer ───
const seen = vi.hoisted(() => ({ or: [] as string[], limit: [] as number[], rows: [] as unknown[] }));
interface FakeQuery {
  [chain: string]: unknown;
  or: (f: string) => FakeQuery;
  limit: (n: number) => FakeQuery;
  then: <T>(resolve: (r: { data: unknown[]; error: null }) => T) => Promise<T>;
}
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    const self = () => b;
    const b: FakeQuery = {
      from: self, select: self, eq: self, order: self, in: self, is: self, not: self,
      or: (f: string) => { seen.or.push(f); return b; },
      limit: (n: number) => { seen.limit.push(n); return b; },
      then: (resolve) => Promise.resolve({ data: seen.rows, error: null as null }).then(resolve),
    };
    return b;
  },
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({
  resolveKbLock: async () => null,
  applyKbUnlockedFilter: (q: unknown) => q,
}));

describe('GET /api/widget/kb/search', () => {
  async function search(q: string, limit?: number, match: string | null = 'words') {
    const { widgetKbRouter } = await import('../../../server/routes/kb.js');
    const app = express();
    app.use((req, _res, next) => { (req as unknown as Record<string, unknown>).serverConfig = {}; next(); });
    app.use('/api/widget/kb', widgetKbRouter);
    const server = http.createServer(app).listen(0);
    const port = (server.address() as AddressInfo).port;
    const qs = new URLSearchParams({
      workspace_id: '11111111-1111-4111-8111-111111111111', q,
      ...(limit ? { limit: String(limit) } : {}),
      ...(match ? { match } : {}),
    });
    const body = await new Promise<{ results: Array<{ slug: string }> }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: `/api/widget/kb/search?${qs}` }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    server.close();
    return body;
  }

  it('a comma no longer empties the answer: the words are searched and ranked, limit kept', async () => {
    seen.or.length = 0; seen.limit.length = 0;
    seen.rows = [
      { slug: 'a', title: 'مرجوعی', excerpt: 'شرایط ارسال' },
      { slug: 'b', title: 'ارسال و پیگیری سفارش', excerpt: '' },
      { slug: 'c', title: 'سفارش', excerpt: '' },
    ];
    const body = await search('ارسال, سفارش', 2);
    expect(seen.or[0]).toBe(kbSearchOrFilter(['ارسال', 'سفارش']));
    expect(seen.limit[0]).toBe(kbSearchWindow(2));
    expect(body.results.map((r) => r.slug)).toEqual(['b', 'c']);
  });

  it('a query with nothing searchable answers no results without a query', async () => {
    seen.or.length = 0;
    const body = await search(',()');
    expect(body.results).toEqual([]);
    expect(seen.or).toEqual([]);
  });

  it('without match=words (the help center, any older caller): one phrase, the database order, as before', async () => {
    seen.or.length = 0; seen.limit.length = 0;
    seen.rows = [
      { slug: 'a', title: 'مرجوعی', excerpt: 'شرایط ارسال' },
      { slug: 'b', title: 'ارسال و پیگیری سفارش', excerpt: '' },
    ];
    const body = await search('ارسال سفارش', 2, null);
    expect(seen.or).toEqual(['title.ilike.%ارسال سفارش%,excerpt.ilike.%ارسال سفارش%,content.ilike.%ارسال سفارش%']);
    expect(seen.limit).toEqual([2]);
    expect(body.results.map((r) => r.slug)).toEqual(['a', 'b']);
  });

  it('a control character is a space in both; nothing but control characters reads nothing', async () => {
    seen.or.length = 0;
    seen.rows = [];
    await search('ارسال\u0000سفارش', 2, null);
    await search('ارسال\u0000سفارش', 2);
    expect(seen.or).toEqual([
      'title.ilike.%ارسال سفارش%,excerpt.ilike.%ارسال سفارش%,content.ilike.%ارسال سفارش%',
      kbSearchOrFilter(['ارسال', 'سفارش']),
    ]);
    seen.or.length = 0;
    expect((await search('\u0000', 2, null)).results).toEqual([]);
    expect((await search('\u0000', 2)).results).toEqual([]);
    expect(seen.or).toEqual([]);
  });
});
