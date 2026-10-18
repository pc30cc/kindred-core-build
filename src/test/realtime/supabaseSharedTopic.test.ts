/**
 * The Supabase adapter shares one join per topic.
 *
 * The Supabase client returns the SAME channel object for a topic it has
 * already joined, and removeChannel() leaves the topic for every holder. The
 * inbox list and an open thread both subscribe to `ws:<ws>:inbox`, and the
 * thread's subscription is dropped on every conversation switch: unshared,
 * that switch would have silenced the list. Now each topic is joined once,
 * every subscriber gets every broadcast, and the topic is left with the last
 * subscriber.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (msg: { payload?: unknown }) => void;
interface FakeChannel { topic: string; bindings: Map<string, Cb[]>; statusCb?: (s: string) => void; joins: number }
const world = vi.hoisted(() => ({ channels: new Map<string, FakeChannel>(), removed: [] as string[] }));

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/realtime/providers/supabaseConnection', () => ({
  getSupabaseRealtimeClient: async () => ({
    channel(topic: string) {
      // As realtime-js does: the existing channel object for a joined topic.
      let ch = world.channels.get(topic);
      if (!ch) {
        ch = { topic, bindings: new Map(), joins: 0 };
        world.channels.set(topic, ch);
      }
      const self = ch;
      const api = {
        on(_type: string, filter: { event: string }, cb: Cb) {
          self.bindings.set(filter.event, [...(self.bindings.get(filter.event) || []), cb]);
          return api;
        },
        subscribe(cb: (s: string) => void) { self.joins += 1; self.statusCb = cb; cb('SUBSCRIBED'); return api; },
        __topic: topic,
      };
      return api;
    },
    removeChannel: async (ch: { __topic: string }) => { world.removed.push(ch.__topic); world.channels.delete(ch.__topic); return 'ok'; },
  }),
}));

const { SupabaseRealtimeClientProvider } = await import('@/realtime/providers/supabase');

const WS = '11111111-1111-4111-8111-111111111111';
const INBOX = `ws:${WS}:inbox`;
const TOPIC = `${INBOX}:MAC`;

const broadcast = (event: string, payload: unknown) => {
  for (const cb of world.channels.get(TOPIC)?.bindings.get(event) || []) cb({ payload });
};

beforeEach(() => {
  world.channels.clear();
  world.removed.length = 0;
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ vendor: 'supabase', channel: INBOX, topic: TOPIC }) }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('SupabaseRealtimeClientProvider — one join per topic', () => {
  it('two subscribers share one join and each hears every event', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    const list = vi.fn();
    const thread = vi.fn();
    const s1 = await provider.subscribe(INBOX, { onEvent: list });
    const statuses: string[] = [];
    const s2 = await provider.subscribe(INBOX, { onEvent: thread, onStatus: (s) => statuses.push(s) });
    expect(world.channels.get(TOPIC)!.joins).toBe(1);
    expect(statuses).toEqual(['connecting', 'open']);
    broadcast('event', { type: 'event', payload: { kind: 'note_added', conversation_id: 'c1', workspace_id: WS } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(thread).toHaveBeenCalledTimes(1);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('a subscriber leaving keeps the others hearing; the last one leaves the topic', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    const list = vi.fn();
    const thread = vi.fn();
    const s1 = await provider.subscribe(INBOX, { onEvent: list });
    const s2 = await provider.subscribe(INBOX, { onEvent: thread });
    s2.unsubscribe();
    s2.unsubscribe(); // twice is once
    expect(world.removed).toEqual([]);
    broadcast('event', { type: 'event', payload: { kind: 'conversation_updated', conversation_id: 'c1', workspace_id: WS } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(thread).not.toHaveBeenCalled();
    s1.unsubscribe();
    expect(world.removed).toEqual([TOPIC]);
  });

  it('after the topic was left, the next subscriber joins it again', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    (await provider.subscribe(INBOX, {})).unsubscribe();
    const again = vi.fn();
    const sub = await provider.subscribe(INBOX, { onMessage: again });
    expect(world.channels.get(TOPIC)!.joins).toBe(1);
    broadcast('message', { type: 'message', payload: { id: 'm1', conversation_id: 'c1' } });
    expect(again).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
  });

  it('a status change after the join reaches every subscriber', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    const a: string[] = [];
    const b: string[] = [];
    const s1 = await provider.subscribe(INBOX, { onStatus: (s) => a.push(s) });
    const s2 = await provider.subscribe(INBOX, { onStatus: (s) => b.push(s) });
    world.channels.get(TOPIC)!.statusCb!('CHANNEL_ERROR');
    world.channels.get(TOPIC)!.statusCb!('SUBSCRIBED');
    expect(a).toEqual(['connecting', 'open', 'error', 'open']);
    expect(b).toEqual(['connecting', 'open', 'error', 'open']);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('a subscriber that comes after a lost and recovered join hears the status of now', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    const s1 = await provider.subscribe(INBOX, {});
    const ch = world.channels.get(TOPIC)!;
    ch.statusCb!('CHANNEL_ERROR');
    const during: string[] = [];
    const s2 = await provider.subscribe(INBOX, { onStatus: (s) => during.push(s) });
    expect(during).toEqual(['connecting', 'error']);
    ch.statusCb!('SUBSCRIBED');
    const after: string[] = [];
    const s3 = await provider.subscribe(INBOX, { onStatus: (s) => after.push(s) });
    expect(after).toEqual(['connecting', 'open']);
    expect(during).toEqual(['connecting', 'error', 'open']);
    expect(ch.joins).toBe(1);
    s1.unsubscribe();
    s2.unsubscribe();
    s3.unsubscribe();
  });

  it('a channel the server closed is joined afresh by the next subscriber', async () => {
    const provider = new SupabaseRealtimeClientProvider();
    const first = await provider.subscribe(INBOX, {});
    world.channels.get(TOPIC)!.statusCb!('CLOSED');
    const heard = vi.fn();
    const second = await provider.subscribe(INBOX, { onEvent: heard });
    expect(world.channels.get(TOPIC)!.joins).toBe(2);
    broadcast('event', { type: 'event', payload: { kind: 'note_added', conversation_id: 'c1', workspace_id: WS } });
    expect(heard).toHaveBeenCalledTimes(1);
    // The first subscriber's leave does not take the new join down.
    first.unsubscribe();
    expect(world.removed).toEqual([]);
    second.unsubscribe();
    expect(world.removed).toEqual([TOPIC]);
  });
});
