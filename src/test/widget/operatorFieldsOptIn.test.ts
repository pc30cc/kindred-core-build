/**
 * Who answers a thread (the assigned operator's name, photo and presence) is
 * added by the server to GET /api/widget/conversations and GET
 * /api/widget/history only on request, `operator=1`
 * (server/routes/widget.ts, widgetOperatorFields.test.ts). Core sends it only
 * for a renderer that draws it (features `conversationOperator`,
 * `chatHeader` or `operatorTyping`, runtime.js operatorQ): the default
 * template asks nothing, so its requests are byte for byte today's and the
 * server does no profile read or workspace snapshot lookup for them.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot, flush, resetWindow, win, type Dict } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

type HistoryCall = Dict & { operator?: unknown };

/** Records what Core hands the chat module's thread load. */
function recordHistoryLoads(): HistoryCall[] {
  const seen: HistoryCall[] = [];
  const chat = win.__gs_mod_chat as { loadConversationHistory: (o: HistoryCall) => void };
  const real = chat.loadConversationHistory;
  chat.loadConversationHistory = (o: HistoryCall) => { seen.push(o); real(o); };
  return seen;
}

async function run(renderer: Parameters<typeof boot>[0]['renderer']) {
  const h = boot({ renderer, conversations: [{ id: 'c1' }], history: { c1: [] } });
  const histories = recordHistoryLoads();
  await flush(20);
  h.runtime.setTab('list');
  await flush();
  h.runtime.__test.openConversation('c1');
  await flush(20);
  const lists = h.fetches.filter((u) => u.includes('/api/widget/conversations') && !u.includes('/read'));
  return { lists, histories };
}

describe('Core asks for the operator fields only for a renderer that draws them', () => {
  it('default: the thread list and the history are requested as before (no operator parameter)', async () => {
    const { lists, histories } = await run('default');
    expect(lists.length).toBeGreaterThan(0);
    for (const u of lists) expect(u).toBe('https://api.test/api/widget/conversations?workspace_id=ws-test');
    expect(histories.length).toBeGreaterThan(0);
    for (const o of histories) expect(o.operator).toBeUndefined();
  });

  it('a renderer declaring a feature that draws no operator does not ask either', async () => {
    const { lists, histories } = await run(() => ({ features: { kbSearch: true } }));
    for (const u of lists) expect(new URL(u).searchParams.has('operator')).toBe(false);
    for (const o of histories) expect(o.operator).toBeUndefined();
  });

  for (const feature of ['conversationOperator', 'chatHeader', 'operatorTyping']) {
    it(`${feature}: both requests ask (operator=1)`, async () => {
      const { lists, histories } = await run(() => ({ features: { [feature]: true } }));
      expect(lists.length).toBeGreaterThan(0);
      for (const u of lists) expect(new URL(u).searchParams.get('operator')).toBe('1');
      expect(histories.length).toBeGreaterThan(0);
      for (const o of histories) expect(o.operator).toBe(1);
    });
  }
});

describe('runtime-chat.js: the history URL', () => {
  function historyUrl(extra: Dict): string {
    new Function(readFileSync(resolve(process.cwd(), 'public/widget/runtime-chat.js'), 'utf8')).call(window);
    const chat = win.__gs_mod_chat as { loadConversationHistory: (o: Dict) => void };
    const urls: string[] = [];
    chat.loadConversationHistory({
      apiBase: 'https://api.test', workspaceId: 'ws', conversationId: 'c1', onResult() {},
      fetchWith: (u: string) => { urls.push(u); return new Promise(() => undefined); },
      ...extra,
    });
    return urls[0];
  }

  it('carries operator=1 only when asked', () => {
    expect(historyUrl({})).toBe('https://api.test/api/widget/history?workspace_id=ws&conversation_id=c1');
    expect(historyUrl({ operator: undefined })).toBe('https://api.test/api/widget/history?workspace_id=ws&conversation_id=c1');
    expect(historyUrl({ operator: 1 })).toBe('https://api.test/api/widget/history?workspace_id=ws&conversation_id=c1&operator=1');
  });
});
