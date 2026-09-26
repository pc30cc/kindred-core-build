/**
 * C8 — widget Supabase realtime driver (public/widget/runtime-rt-supabase.js).
 *
 * The driver must never join the canonical `ws:<ws>:conv:<cid>` name (it is
 * guessable and Supabase Broadcast channels are public). It asks
 * /api/realtime/subscribe (`transport: 'supabase'`, widget token + cookie)
 * for the concrete topic and joins only that; on refusal it joins nothing
 * and falls back to polling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const SRC = readFileSync(resolve(__dirname, '../../../public/widget/runtime-rt-supabase.js'), 'utf8');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const CANONICAL = `ws:${WS}:conv:${CID}`;

interface FetchCall { url: string; init: { headers: Record<string, string>; body: string; credentials?: string } }

interface Harness {
  joined: string[];
  removed: string[];
  fetches: FetchCall[];
  fallbacks: string[];
  subscribedAcks: string[];
  driver: {
    connect(): void;
    disconnect(): void;
    subscribeConversation(cid: string): void;
    unsubscribeConversation(cid: string): void;
  };
}

function load(reply: () => { ok: boolean; body: unknown }): Harness {
  const h = {
    joined: [] as string[],
    removed: [] as string[],
    fetches: [] as FetchCall[],
    fallbacks: [] as string[],
    subscribedAcks: [] as string[],
  };
  const fakeClient = {
    channel(topic: string) {
      h.joined.push(topic);
      const ch = {
        topic,
        on: () => ch,
        subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
      };
      return ch;
    },
    removeChannel(ch: { topic: string }) { h.removed.push(ch.topic); },
    realtime: { disconnect() { /* noop */ } },
  };
  const sandbox: Record<string, unknown> = {
    fetch: async (url: string, init: FetchCall['init']) => {
      h.fetches.push({ url, init });
      const r = reply();
      return { ok: r.ok, json: async () => r.body };
    },
    __gs_supabase_client_factory: () => fakeClient,
    __gs_token: { get: () => 'wt_live_token' },
    setTimeout,
    clearTimeout,
    Promise,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const mod = sandbox.__gs_mod_rt_supabase as { create: (...a: unknown[]) => Harness['driver'] };
  const driver = mod.create(
    { workspaceId: WS, apiBase: 'https://api.example.test', sessionToken: 'stale' },
    { vendor: 'supabase', supabase_url: 'https://x.supabase.co', anon_key: 'anon' },
    {
      fallbackToPolling: (r: string) => h.fallbacks.push(r),
      onSubscribed: (e: { channel: string }) => h.subscribedAcks.push(e.channel),
    },
  );
  return { ...h, driver };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let topic = '';
beforeEach(() => {
  topic = `${CANONICAL}:VISITORMAC0123456789abcdefghijkl`;
});

describe('runtime-rt-supabase.js topic handling', () => {
  it('fetches the topic from /api/realtime/subscribe and joins only that topic', async () => {
    const h = load(() => ({ ok: true, body: { vendor: 'supabase', channel: CANONICAL, topic } }));
    h.driver.subscribeConversation(CID);
    h.driver.connect();
    await flush(); await flush(); await flush();

    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].url).toBe('https://api.example.test/api/realtime/subscribe');
    expect(h.fetches[0].init.credentials).toBe('include');
    expect(h.fetches[0].init.headers['X-Widget-Token']).toBe('wt_live_token');
    expect(JSON.parse(h.fetches[0].init.body)).toEqual({ workspace_id: WS, conversation_id: CID, transport: 'supabase' });
    expect(h.joined).toEqual([topic]);
    expect(h.joined).not.toContain(CANONICAL);
    // Runtime-facing channel identity stays canonical.
    expect(h.subscribedAcks).toEqual([CANONICAL]);

    h.driver.unsubscribeConversation(CID);
    expect(h.removed).toEqual([topic]);
  });

  it('joins nothing and falls back to polling when the server refuses', async () => {
    const h = load(() => ({ ok: false, body: { error: 'Conversation not accessible' } }));
    h.driver.subscribeConversation(CID);
    h.driver.connect();
    await flush(); await flush(); await flush();
    expect(h.joined).toEqual([]);
    expect(h.fallbacks).toEqual(['supabase_topic_unavailable']);
  });

  it('rejects a topic that was not derived for this conversation', async () => {
    const h = load(() => ({ ok: true, body: { vendor: 'supabase', topic: `ws:${WS}:inbox:MAC` } }));
    h.driver.subscribeConversation(CID);
    h.driver.connect();
    await flush(); await flush(); await flush();
    expect(h.joined).toEqual([]);
  });

  it('does not join if the conversation was unsubscribed while the topic was in flight', async () => {
    const h = load(() => ({ ok: true, body: { vendor: 'supabase', channel: CANONICAL, topic } }));
    h.driver.subscribeConversation(CID);
    h.driver.connect();
    h.driver.unsubscribeConversation(CID);
    await flush(); await flush(); await flush();
    expect(h.joined).toEqual([]);
  });
});
