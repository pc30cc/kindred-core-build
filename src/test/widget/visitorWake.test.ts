/**
 * V-07 (server side): an operator's message wakes the visitor's widget
 * through the loader's presence socket (server/services/widget/visitorWake.ts):
 * one publication per recent session of that browser on its own
 * `vp:v2:<workspace>:<session>` channel, carrying nothing but `kind: wake`.
 * Nothing for a conversation without a visitor session (a channel's), and
 * nothing without Centrifugo (there is no presence socket).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const S_OLD = '33333333-3333-4333-8333-333333333333';
const S_NOW = '44444444-4444-4444-8444-444444444444';

const db = vi.hoisted(() => ({
  conversation: null as Record<string, unknown> | null,
  session: null as Record<string, unknown> | null,
  recent: [] as Array<Record<string, unknown>>,
  vendor: 'centrifugo',
  published: [] as Array<{ channel: string; envelope: unknown }>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      Object.assign(b, {
        select: self, eq: self, order: self,
        limit: () => Promise.resolve({ data: table === 'visitor_sessions' ? db.recent : [], error: null }),
        maybeSingle: () => Promise.resolve({ data: table === 'conversations' ? db.conversation : db.session, error: null }),
      });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({
    vendor: db.vendor,
    publish: async (channel: string, envelope: unknown) => { db.published.push({ channel, envelope }); return { ok: true }; },
  }),
}));

const { wakeVisitorWidget } = await import('../../../server/services/widget/visitorWake.js');
const CONFIG = {} as never;

beforeEach(() => {
  db.conversation = { visitor_session_id: S_OLD };
  db.session = { visitor_id: 'visitor-1' };
  db.recent = [{ id: S_NOW }, { id: S_OLD }];
  db.vendor = 'centrifugo';
  db.published = [];
});

describe('waking the visitor\'s widget', () => {
  it('publishes an empty wake to the conversation\'s session and the browser\'s current one', async () => {
    await wakeVisitorWidget(CONFIG, WS, CONV);
    expect(db.published.map((p) => p.channel).sort()).toEqual([`vp:v2:${WS}:${S_NOW}`, `vp:v2:${WS}:${S_OLD}`].sort());
    for (const p of db.published) expect(p.envelope).toEqual({ type: 'event', payload: { kind: 'wake' } });
  });

  it('nothing for a conversation with no visitor session (a channel\'s)', async () => {
    db.conversation = { visitor_session_id: null };
    await wakeVisitorWidget(CONFIG, WS, CONV);
    expect(db.published).toEqual([]);
  });

  it('nothing without Centrifugo (no presence socket to hear it)', async () => {
    db.vendor = 'supabase';
    await wakeVisitorWidget(CONFIG, WS, CONV);
    expect(db.published).toEqual([]);
  });

  it('never throws', async () => {
    db.conversation = null;
    await expect(wakeVisitorWidget(CONFIG, WS, CONV)).resolves.toBeUndefined();
  });
});
