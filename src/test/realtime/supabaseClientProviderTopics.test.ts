/**
 * C8 — the operator console's Supabase adapter must join ONLY the topic the
 * authenticated server endpoint returns, never the canonical (guessable)
 * channel name, and must join nothing when the server refuses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const joined: string[] = [];

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    channel(topic: string) {
      joined.push(topic);
      const ch = {
        on: () => ch,
        subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
      };
      return ch;
    },
    removeChannel: async () => 'ok',
  },
}));

const { SupabaseRealtimeClientProvider, parseSupabaseChannel } = await import('@/realtime/providers/supabase');

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';

interface Call { url: string; body: Record<string, unknown> }
let calls: Call[] = [];
let reply: (call: Call) => { ok: boolean; body: unknown };

beforeEach(() => {
  joined.length = 0;
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const call = { url, body: JSON.parse(init.body) as Record<string, unknown> };
    calls.push(call);
    const r = reply(call);
    return { ok: r.ok, json: async () => r.body };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupabaseRealtimeClientProvider', () => {
  it('maps each channel kind to its authenticated endpoint', () => {
    expect(parseSupabaseChannel(`ws:${WS}:conv:${CONV}`)).toEqual({ kind: 'conversation', workspaceId: WS, conversationId: CONV });
    expect(parseSupabaseChannel(`ws:${WS}:inbox`)?.kind).toBe('inbox');
    expect(parseSupabaseChannel(`ws:${WS}:visitors`)?.kind).toBe('visitors');
    expect(parseSupabaseChannel(`ws:${WS}:operators`)?.kind).toBe('operators');
    expect(parseSupabaseChannel('random-topic')).toBeNull();
  });

  it('joins the server-provided topic, not the canonical channel name', async () => {
    const channel = `ws:${WS}:inbox`;
    reply = () => ({ ok: true, body: { vendor: 'supabase', channel, topic: `${channel}:SERVERMAC` } });
    const statuses: string[] = [];
    const sub = await new SupabaseRealtimeClientProvider().subscribe(channel, { onStatus: (s) => statuses.push(s) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/realtime/operator-inbox-subscribe');
    expect(calls[0].body).toEqual({ workspace_id: WS, transport: 'supabase' });
    expect(joined).toEqual([`${channel}:SERVERMAC`]);
    expect(statuses).toContain('open');
    sub.unsubscribe();
  });

  it('sends the conversation id to operator-subscribe', async () => {
    const channel = `ws:${WS}:conv:${CONV}`;
    reply = () => ({ ok: true, body: { vendor: 'supabase', channel, topic: `${channel}:MAC` } });
    await new SupabaseRealtimeClientProvider().subscribe(channel, {});
    expect(calls[0].url).toBe('/api/realtime/operator-subscribe');
    expect(calls[0].body).toEqual({ workspace_id: WS, conversation_id: CONV, transport: 'supabase' });
    expect(joined).toEqual([`${channel}:MAC`]);
  });

  it('joins nothing and reports error when the server refuses', async () => {
    reply = () => ({ ok: false, body: { error: 'Not authorized' } });
    const statuses: string[] = [];
    await new SupabaseRealtimeClientProvider().subscribe(`ws:${WS}:inbox`, { onStatus: (s) => statuses.push(s) });
    expect(joined).toEqual([]);
    expect(statuses).toContain('error');
  });

  it('refuses a topic that was not derived for the requested channel', async () => {
    reply = () => ({ ok: true, body: { vendor: 'supabase', topic: `ws:${WS}:visitors:MAC` } });
    await new SupabaseRealtimeClientProvider().subscribe(`ws:${WS}:inbox`, {});
    expect(joined).toEqual([]);
  });
});
