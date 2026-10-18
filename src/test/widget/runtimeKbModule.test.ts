/**
 * runtime-kb.js, the help center's module: what issue #340 adds to it.
 *
 *  - suggestArticles(): GET /api/widget/kb-suggest with the workspace, the
 *    locale, the draft and how many (two by default), through the caller's
 *    fetchWith (the widget token); the HTTP status of a refusal (a 429 says
 *    to stop asking for a while); an abort answers nothing;
 *  - loadArticle(): `meta=1` only when the caller passes it (runtime-ext.js,
 *    for a renderer that draws the author), else the request is today's.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Kb = {
  suggestArticles: (o: Record<string, unknown>) => void;
  loadArticle: (o: Record<string, unknown>) => void;
};
const w = window as unknown as { __gs_mod_kb: Kb };
beforeEach(() => { new Function(readFileSync(resolve(process.cwd(), 'public/widget/runtime-kb.js'), 'utf8')).call(window); });

const answer = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('suggestArticles', () => {
  it('asks the suggest route with the draft, through fetchWith', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const got: unknown[] = [];
    const ctl = new AbortController();
    w.__gs_mod_kb.suggestArticles({
      apiBase: 'https://api.test', workspaceId: 'ws 1', locale: 'fa', query: 'مرجوعی & کفش', signal: ctl.signal,
      fetchWith: (u: string, init: RequestInit) => { calls.push([u, init]); return answer(200, { results: [{ slug: 'a' }] }); },
      onResult: (r: unknown) => got.push(r),
    });
    await settle();
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0][0]);
    expect(u.origin + u.pathname).toBe('https://api.test/api/widget/kb-suggest');
    expect(Object.fromEntries(u.searchParams)).toEqual({ workspace_id: 'ws 1', locale: 'fa', q: 'مرجوعی & کفش', limit: '2' });
    expect(calls[0][1].method).toBe('GET');
    expect(calls[0][1].signal).toBe(ctl.signal);
    expect(got).toEqual([{ ok: true, status: 200, results: [{ slug: 'a' }] }]);
  });

  it('says the status of a refusal, nothing for an abort, and answers an empty draft at once', async () => {
    const got: unknown[] = [];
    const onResult = (r: unknown) => got.push(r);
    w.__gs_mod_kb.suggestArticles({ apiBase: 'https://api.test', workspaceId: 'ws', query: 'abc', fetchWith: () => answer(429, { code: 'RATE_LIMITED' }), onResult });
    await settle();
    expect(got).toEqual([{ ok: false, status: 429, results: [] }]);
    got.length = 0;
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    w.__gs_mod_kb.suggestArticles({ apiBase: 'https://api.test', workspaceId: 'ws', query: 'abc', fetchWith: () => Promise.reject(abort), onResult });
    await settle();
    expect(got).toEqual([]);
    w.__gs_mod_kb.suggestArticles({ apiBase: 'https://api.test', workspaceId: 'ws', query: 'abc', fetchWith: () => Promise.reject(new TypeError('net')), onResult });
    await settle();
    expect(got).toEqual([{ ok: false, status: 0, results: [] }]);
    got.length = 0;
    w.__gs_mod_kb.suggestArticles({ apiBase: 'https://api.test', workspaceId: 'ws', query: '', fetchWith: () => { throw new Error('asked'); }, onResult });
    expect(got).toEqual([{ ok: true, status: 0, results: [] }]);
  });
});

describe('loadArticle', () => {
  it('adds meta=1 only when asked to', async () => {
    const urls: string[] = [];
    const fetchWith = (u: string) => { urls.push(u); return answer(200, { article: null }); };
    w.__gs_mod_kb.loadArticle({ apiBase: 'https://api.test', workspaceId: 'ws', locale: 'fa', slug: 's', fetchWith, onResult: () => {} });
    w.__gs_mod_kb.loadArticle({ apiBase: 'https://api.test', workspaceId: 'ws', locale: 'fa', slug: 's', meta: 1, fetchWith, onResult: () => {} });
    await settle();
    expect(urls).toEqual([
      'https://api.test/api/widget/kb/article?workspace_id=ws&locale=fa&slug=s',
      'https://api.test/api/widget/kb/article?workspace_id=ws&locale=fa&slug=s&meta=1',
    ]);
  });
});
