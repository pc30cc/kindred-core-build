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
});
