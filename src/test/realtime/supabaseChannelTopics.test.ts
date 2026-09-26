/**
 * C8 — Supabase Broadcast topics must be unguessable, and the server must
 * never publish on a canonical (guessable) channel name.
 *
 * Covers:
 *   - topic derivation: deterministic, secret-bound, audience-separated,
 *     fail-closed without a secret, no visitor copy of operator channels;
 *   - SupabaseRealtimePublisher: fans a conversation event out to the
 *     operator + visitor topics, operator-only channels to one topic, and
 *     never touches the canonical name — including when no secret exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveSupabaseTopic,
  supabaseTopicsForPublish,
  resolveRealtimeChannelKey,
  RealtimeChannelSecretUnavailableError,
  __resetRealtimeChannelTopicWarningsForTests,
} from '../../../server/services/realtime/channelTopic';
import { SupabaseRealtimePublisher } from '../../../server/services/realtime/publishers/supabase';

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONV_CHANNEL = `ws:${WS}:conv:${CONV}`;
const INBOX_CHANNEL = `ws:${WS}:inbox`;

const SAVED = {
  secret: process.env.REALTIME_CHANNEL_SECRET,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function setEnv(secret: string | undefined, service: string | undefined) {
  if (secret === undefined) delete process.env.REALTIME_CHANNEL_SECRET;
  else process.env.REALTIME_CHANNEL_SECRET = secret;
  if (service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = service;
}

beforeEach(() => {
  __resetRealtimeChannelTopicWarningsForTests();
  setEnv('a'.repeat(48), 'service-role-key-for-tests-0123456789abcdef');
});

afterEach(() => {
  setEnv(SAVED.secret, SAVED.service);
});

describe('deriveSupabaseTopic', () => {
  it('extends the canonical name with a long, url-safe MAC', () => {
    const topic = deriveSupabaseTopic(INBOX_CHANNEL, 'operator');
    expect(topic.startsWith(`${INBOX_CHANNEL}:`)).toBe(true);
    const mac = topic.slice(INBOX_CHANNEL.length + 1);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('is deterministic for the same secret and differs per secret', () => {
    const a = deriveSupabaseTopic(INBOX_CHANNEL, 'operator');
    expect(deriveSupabaseTopic(INBOX_CHANNEL, 'operator')).toBe(a);
    setEnv('b'.repeat(48), 'service-role-key-for-tests-0123456789abcdef');
    expect(deriveSupabaseTopic(INBOX_CHANNEL, 'operator')).not.toBe(a);
  });

  it('separates the visitor copy of a conversation from the operator copy', () => {
    const op = deriveSupabaseTopic(CONV_CHANNEL, 'operator');
    const visitor = deriveSupabaseTopic(CONV_CHANNEL, 'visitor');
    expect(op).not.toBe(visitor);
    expect(visitor.startsWith(`${CONV_CHANNEL}:`)).toBe(true);
  });

  it('never derives a visitor topic for operator-only channels', () => {
    for (const ch of [INBOX_CHANNEL, `ws:${WS}:visitors`, `ws:${WS}:operators`, `ws:${WS}:queue`]) {
      expect(() => deriveSupabaseTopic(ch, 'visitor')).toThrow();
    }
  });

  it('falls back to a key derived from SUPABASE_SERVICE_ROLE_KEY', () => {
    setEnv(undefined, 'service-role-key-for-tests-0123456789abcdef');
    const r = resolveRealtimeChannelKey();
    expect(r.ok).toBe(true);
    const topic = deriveSupabaseTopic(INBOX_CHANNEL, 'operator');
    expect(topic).not.toBe(INBOX_CHANNEL);
    // Derived key is domain-separated from the dedicated-secret form.
    setEnv('service-role-key-for-tests-0123456789abcdef', 'service-role-key-for-tests-0123456789abcdef');
    expect(deriveSupabaseTopic(INBOX_CHANNEL, 'operator')).not.toBe(topic);
  });

  it('fails closed when no secret is available', () => {
    setEnv(undefined, undefined);
    expect(resolveRealtimeChannelKey().ok).toBe(false);
    expect(() => deriveSupabaseTopic(INBOX_CHANNEL, 'operator')).toThrow(RealtimeChannelSecretUnavailableError);
  });

  it('fails closed (no silent fallback) when the dedicated secret is too short', () => {
    setEnv('short', 'service-role-key-for-tests-0123456789abcdef');
    expect(resolveRealtimeChannelKey().ok).toBe(false);
    expect(() => deriveSupabaseTopic(INBOX_CHANNEL, 'operator')).toThrow(RealtimeChannelSecretUnavailableError);
  });

  it('publish fan-out: conversation → operator + visitor topics, inbox → operator only', () => {
    expect(supabaseTopicsForPublish(CONV_CHANNEL)).toEqual([
      deriveSupabaseTopic(CONV_CHANNEL, 'operator'),
      deriveSupabaseTopic(CONV_CHANNEL, 'visitor'),
    ]);
    expect(supabaseTopicsForPublish(INBOX_CHANNEL)).toEqual([deriveSupabaseTopic(INBOX_CHANNEL, 'operator')]);
  });
});

type SubscribeCb = (status: string) => void;

function fakeSupabase() {
  const joined: string[] = [];
  const sent: Array<{ topic: string; event: string; payload: unknown }> = [];
  const removed: string[] = [];
  const client = {
    channel(topic: string) {
      joined.push(topic);
      return {
        topic,
        subscribe(cb: SubscribeCb) { cb('SUBSCRIBED'); return this; },
        async send(msg: { event: string; payload: unknown }) {
          sent.push({ topic, event: msg.event, payload: msg.payload });
          return 'ok';
        },
      };
    },
    async removeChannel(ch: { topic: string }) { removed.push(ch.topic); return 'ok'; },
  };
  return { client, joined, sent, removed };
}

describe('SupabaseRealtimePublisher', () => {
  it('never broadcasts on the canonical conversation channel', async () => {
    const fake = fakeSupabase();
    const pub = new SupabaseRealtimePublisher(fake.client as never);
    const res = await pub.publish(CONV_CHANNEL, { type: 'message', payload: { id: 'm1', body: 'secret' } });
    expect(res.ok).toBe(true);
    expect(fake.joined).not.toContain(CONV_CHANNEL);
    expect(fake.joined.sort()).toEqual(
      [deriveSupabaseTopic(CONV_CHANNEL, 'operator'), deriveSupabaseTopic(CONV_CHANNEL, 'visitor')].sort(),
    );
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent.every((s) => s.event === 'message')).toBe(true);
    expect(fake.removed.sort()).toEqual(fake.joined.sort());
  });

  it('publishes operator-only channels to exactly one operator topic', async () => {
    const fake = fakeSupabase();
    const pub = new SupabaseRealtimePublisher(fake.client as never);
    await pub.publish(INBOX_CHANNEL, { type: 'event', payload: { kind: 'conversation_updated' } });
    expect(fake.joined).toEqual([deriveSupabaseTopic(INBOX_CHANNEL, 'operator')]);
  });

  it('fails closed without a secret: nothing is joined or sent', async () => {
    setEnv(undefined, undefined);
    const fake = fakeSupabase();
    const pub = new SupabaseRealtimePublisher(fake.client as never);
    const res = await pub.publish(INBOX_CHANNEL, { type: 'message', payload: { id: 'm1' } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/realtime_channel_secret_unavailable/);
    expect(fake.joined).toEqual([]);
    expect(fake.sent).toEqual([]);
  });
});
