/**
 * The realtime drivers and the `event` envelope (issue #340, g2): both
 * drivers hand a `message_reactions` event to the runtime's hook
 * (`hooks.onReaction`, runtime.js → ext('reaction')), keep `call:incoming`
 * and `call:ended` for the call sidecar, and drop every other kind (the
 * visitor channel carries only the kinds WIDGET_EVENT_FIELDS lists, and a
 * stray operator kind must still do nothing).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const RUNTIME = read('public/widget/runtime.js');
type Dict = Record<string, unknown>;
const w = window as unknown as Dict;

beforeEach(() => { for (const k of Object.keys(w)) if (k.startsWith('__gs')) delete w[k]; });
afterEach(() => { for (const k of Object.keys(w)) if (k.startsWith('__gs')) delete w[k]; });

const REACTION = { kind: 'message_reactions', conversation_id: 'c1', message_id: 'm1', reactions: [{ emoji: '❤️', count: 1, visitor: true }], at: 5 };

function hooks() {
  const seen: Array<[string, unknown]> = [];
  const calls: Array<[string, unknown]> = [];
  w.__gs_call = { incoming: (p: unknown) => calls.push(['incoming', p]), ended: (p: unknown) => calls.push(['ended', p]) };
  return {
    seen, calls,
    hooks: {
      onConnectionState() {}, onMessage: (e: unknown) => seen.push(['message', e]), onTyping: (e: unknown) => seen.push(['typing', e]),
      onPresence() {}, onReaction: (p: unknown) => seen.push(['reaction', p]), onReconnect() {}, onSubscribed() {},
    },
  };
}

describe('the Supabase driver', () => {
  it('hands message_reactions to the hook, calls to the sidecar, drops the rest', async () => {
    const WS = '11111111-1111-4111-8111-111111111111';
    const CID = '22222222-2222-4222-8222-222222222222';
    const topic = `ws:${WS}:conv:${CID}:MAC0123456789abcdefghijklmnopqrstu`;
    const handlers: Record<string, (msg: unknown) => void> = {};
    const fakeClient = {
      channel() {
        const ch = {
          on(_type: string, filter: { event: string }, fn: (msg: unknown) => void) { handlers[filter.event] = fn; return ch; },
          subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
        };
        return ch;
      },
      removeChannel() {},
      realtime: { disconnect() {} },
    };
    const h = hooks();
    const sandbox: Dict = {
      fetch: async () => ({ ok: true, json: async () => ({ vendor: 'supabase', channel: `ws:${WS}:conv:${CID}`, topic }) }),
      __gs_supabase_client_factory: () => fakeClient,
      __gs_token: { get: () => 'wt' },
      __gs_call: w.__gs_call,
      setTimeout, clearTimeout, Promise,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('public/widget/runtime-rt-supabase.js'), sandbox);
    const drv = (sandbox.__gs_mod_rt_supabase as { create: (...a: unknown[]) => Dict }).create(
      { workspaceId: WS, apiBase: 'https://api.test' }, { vendor: 'supabase', supabase_url: 'https://x.supabase.co', anon_key: 'anon' },
      { ...h.hooks, fallbackToPolling() {} });
    (drv.subscribeConversation as (c: string) => void)(CID);
    (drv.connect as () => void)();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(typeof handlers.event).toBe('function');
    handlers.event({ payload: REACTION });
    handlers.event({ payload: { kind: 'call:ended', call_id: 'k1' } });
    handlers.event({ payload: { kind: 'note_added', note: 'private' } });
    handlers.event({ payload: { kind: 'conversation_updated' } });
    expect(h.seen).toEqual([['reaction', REACTION]]);
    expect(h.calls).toEqual([['ended', { kind: 'call:ended', call_id: 'k1' }]]);
  });
});

describe('the Centrifugo driver', () => {
  it('hands message_reactions to the hook, calls to the sidecar, drops the rest', () => {
    const src = read('public/widget/runtime-rt-centrifugo.js');
    const branch = src.slice(src.indexOf("if (data && data.type === 'event') {"), src.indexOf("} else if (data && data.type === 'message' && hooks.onMessage)"));
    // The `event` branch alone, run as the driver runs it for a pushed frame.
    const run = new Function('data', 'hooks', 'window', branch + '}');
    const h = hooks();
    for (const payload of [REACTION, { kind: 'call:incoming', id: 'i1' }, { kind: 'note_added' }, { kind: 'tags_changed' }]) {
      run({ type: 'event', payload }, h.hooks, window);
    }
    expect(h.seen).toEqual([['reaction', REACTION]]);
    expect(h.calls).toEqual([['incoming', { kind: 'call:incoming', id: 'i1' }]]);
    // A driver without the hook (an older runtime) ignores it.
    expect(() => run({ type: 'event', payload: REACTION }, {}, window)).not.toThrow();
  });
});

describe('the runtime', () => {
  it('passes the hook to the driver: one line, ext(\'reaction\'), nothing else', () => {
    expect(RUNTIME).toContain("onReaction: function (p) { ext('reaction', p); },");
    expect(RUNTIME.match(/ext\('reaction'/g)).toHaveLength(1);
  });
});
