/**
 * The chat widget's realtime drivers and an expired widget session.
 *
 * A page left open (a laptop asleep) can come back with a session token the
 * server no longer takes. The connection itself was recovered already; a
 * conversation's subscription (POST /api/realtime/subscribe) was not: its
 * 401/403 left the conversation without live messages until the next token
 * refresh. Both drivers now recover the session once (the shared session
 * manager) and ask again with the fresh token, never more than once.
 *
 * And the Supabase driver imports its client library only from an absolute
 * https address (http on this machine), written into the module script as a
 * string literal: an attribute of the host page can no longer reach the
 * script's source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CENTRIFUGO = read('public/widget/runtime-rt-centrifugo.js');
const SUPABASE = read('public/widget/runtime-rt-supabase.js');
const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

type Dict = Record<string, unknown>;
interface Answer { status: number; body?: unknown }

/** The shared session manager: `get` is the token now, `recover` swaps in a fresh one. */
function bus(fresh: string | null) {
  const b = { token: 'wt-expired', recovers: 0, vc: '', get: () => b.token, recover: () => { b.recovers += 1; if (fresh) b.token = fresh; return Promise.resolve(fresh); } };
  return b;
}

function answerFrom(answers: Answer[]) {
  const a = answers.length > 1 ? answers.shift()! : answers[0];
  return { ok: a.status < 400, status: a.status, json: async () => a.body ?? {} };
}

describe('the Centrifugo driver: a refused subscription', () => {
  function run(answers: Answer[], fresh: string | null) {
    const tokenBus = bus(fresh);
    const subscribes: Array<{ token: string }> = [];
    const frames: Dict[] = [];
    const sockets: FakeWs[] = [];
    class FakeWs {
      readyState = 0;
      onmessage?: (ev: { data: string }) => void;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { sockets.push(this); }
      send(s: string) {
        const f = JSON.parse(s) as Dict & { id: number };
        frames.push(f);
        const reply = f.connect ? { connect: { client: 'c1' } } : f.subscribe ? { subscribe: {} } : {};
        Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify({ id: f.id, ...reply }) }));
      }
      close() {}
    }
    const sandbox: Dict = {
      fetch: async (url: string, init: { headers: Record<string, string> }) => {
        if (String(url).endsWith('/api/realtime/subscribe')) {
          subscribes.push({ token: init.headers['X-Widget-Token'] });
          return answerFrom(answers);
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
      WebSocket: FakeWs,
      __gs_token: tokenBus,
      setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(CENTRIFUGO, sandbox);
    const driver = (sandbox.__gs_mod_rt_centrifugo as { create: (...a: unknown[]) => Dict }).create(
      { workspaceId: WS, apiBase: 'https://api.test' },
      { vendor: 'centrifugo', token: 'ct', ws_url: 'wss://rt.test', expires_at: Date.now() + 30 * 60_000 },
      { onConnectionState() {}, onMessage() {}, onTyping() {}, onSubscribed() {}, fallbackToPolling() {} },
    );
    return { driver, sockets, subscribes, frames, tokenBus };
  }

  async function open(h: ReturnType<typeof run>) {
    (h.driver.subscribeConversation as (c: string) => void)(CID);
    (h.driver.connect as () => void)();
    await flush(2);
    const ws = h.sockets[0];
    ws.readyState = 1;
    ws.onopen!();
    await flush();
  }

  it('recovers the session once and subscribes with the fresh token', async () => {
    const h = run([{ status: 401 }, { status: 200, body: { vendor: 'centrifugo', token: 'sub-tk', channel: `ws:${WS}:conv:${CID}` } }], 'wt-fresh');
    await open(h);
    expect(h.subscribes.map((s) => s.token)).toEqual(['wt-expired', 'wt-fresh']);
    expect(h.tokenBus.recovers).toBe(1);
    const sub = h.frames.find((f) => f.subscribe) as { subscribe: { channel: string; token: string } } | undefined;
    expect(sub?.subscribe).toEqual({ channel: `ws:${WS}:conv:${CID}`, token: 'sub-tk' });
  });

  it('asks once more at most: refused again, it subscribes to nothing', async () => {
    const h = run([{ status: 403 }], 'wt-fresh');
    await open(h);
    expect(h.subscribes).toHaveLength(2);
    expect(h.tokenBus.recovers).toBe(1);
    expect(h.frames.some((f) => f.subscribe)).toBe(false);
  });

  it('a session that cannot be recovered is not asked again', async () => {
    const h = run([{ status: 401 }], null);
    await open(h);
    expect(h.subscribes).toHaveLength(1);
    expect(h.frames.some((f) => f.subscribe)).toBe(false);
  });
});

describe('the Supabase driver', () => {
  function run(opts: { answers?: Answer[]; fresh?: string | null; libUrl?: string; factory?: boolean }) {
    const tokenBus = bus(opts.fresh ?? null);
    const topic = `ws:${WS}:conv:${CID}:MAC0123456789abcdefghijklmnopqrstu`;
    const answers = opts.answers || [{ status: 200, body: { vendor: 'supabase', topic } }];
    const subscribes: string[] = [];
    const joined: string[] = [];
    const appended: Array<{ type?: string; textContent?: string }> = [];
    const fallbacks: string[] = [];
    const fakeClient = {
      channel(t: string) {
        joined.push(t);
        const ch = { topic: t, on: () => ch, subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; } };
        return ch;
      },
      removeChannel() {},
      realtime: { disconnect() {} },
    };
    const sandbox: Dict = {
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        subscribes.push(init.headers['X-Widget-Token']);
        return answerFrom(answers);
      },
      __gs_token: tokenBus,
      document: {
        getElementsByTagName: () => (opts.libUrl === undefined ? [] : [{ getAttribute: (n: string) => (n === 'data-supabase-js-url' ? opts.libUrl : null) }]),
        createElement: () => ({}),
        head: { appendChild: (el: { type?: string; textContent?: string }) => { appended.push(el); } },
      },
      addEventListener() {}, removeEventListener() {},
      URL, setTimeout, clearTimeout, Promise, JSON,
    };
    if (opts.factory !== false) sandbox.__gs_supabase_client_factory = () => fakeClient;
    sandbox.window = sandbox;
    vm.runInNewContext(SUPABASE, sandbox);
    const driver = (sandbox.__gs_mod_rt_supabase as { create: (...a: unknown[]) => Dict }).create(
      { workspaceId: WS, apiBase: 'https://api.test' },
      { vendor: 'supabase', supabase_url: 'https://x.supabase.co', anon_key: 'anon' },
      { fallbackToPolling: (r: string) => fallbacks.push(r), onSubscribed() {} },
    );
    return { driver, subscribes, joined, appended, fallbacks, tokenBus, topic };
  }

  async function start(h: ReturnType<typeof run>) {
    (h.driver.subscribeConversation as (c: string) => void)(CID);
    (h.driver.connect as () => void)();
    await flush();
  }

  it('a refused topic: the session is recovered once and the topic asked again with the fresh token', async () => {
    const h = run({ answers: [{ status: 401 }, { status: 200, body: { vendor: 'supabase', topic: `ws:${WS}:conv:${CID}:MAC0123456789abcdefghijklmnopqrstu` } }], fresh: 'wt-fresh' });
    await start(h);
    expect(h.subscribes).toEqual(['wt-expired', 'wt-fresh']);
    expect(h.tokenBus.recovers).toBe(1);
    expect(h.joined).toEqual([h.topic]);
  });

  it('refused again: no third ask, and polling takes over', async () => {
    const h = run({ answers: [{ status: 403 }], fresh: 'wt-fresh' });
    await start(h);
    expect(h.subscribes).toHaveLength(2);
    expect(h.joined).toEqual([]);
    expect(h.fallbacks).toEqual(['supabase_topic_unavailable']);
  });

  it('imports its library from an https address, written as a string literal', async () => {
    const h = run({ factory: false, libUrl: "https://cdn.example/supabase.js');window.x=1;('" });
    await start(h);
    expect(h.appended).toHaveLength(1);
    const src = String(h.appended[0].textContent);
    // The whole address is one string literal: its quote ends no statement.
    expect(src.startsWith('import { createClient } from ' + JSON.stringify("https://cdn.example/supabase.js');window.x=1;('") + ';')).toBe(true);
  });

  it.each(['javascript:alert(1)', 'data:text/javascript,alert(1)', '/vendor/supabase.js', 'http://cdn.example/supabase.js'])('loads nothing from %j: polling takes over', async (libUrl) => {
    const h = run({ factory: false, libUrl });
    await start(h);
    expect(h.appended).toHaveLength(0);
    expect(h.fallbacks).toEqual(['supabase_init_failed']);
  });
});
