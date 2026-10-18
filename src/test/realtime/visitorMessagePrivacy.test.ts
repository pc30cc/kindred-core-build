/**
 * What the visitor's channel carries of a message and of a reaction change
 * (issue #340, contract §8 (1) and g2):
 *
 *  - a `message` envelope reaches ws:<ws>:conv:<cid> (which the visitor's
 *    browser subscribes to) without the operator account ids it holds —
 *    `sender_id` and the metadata ids of a join, a transfer, the closed line,
 *    a call row — and the inbox channel whole (the apps read sender_id there);
 *  - a row with nothing to remove goes out as it is (same keys, same order);
 *  - typing and seen envelopes are unchanged;
 *  - `message_reactions` goes whole to the inbox channel and, cut to the
 *    widget's fields (kind, conversation_id, message_id, reactions, at), to
 *    the conversation channel: counts, never who reacted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => [] as Array<{ channel: string; envelope: { type: string; payload: Record<string, unknown> } }>);
vi.mock('../../../server/services/realtime/resolvePublisher.js', () => ({
  resolvePublisher: async () => ({
    vendor: 'centrifugo',
    publish: async (channel: string, envelope: { type: string; payload: Record<string, unknown> }) => {
      published.push({ channel, envelope });
      return { ok: true };
    },
  }),
}));

const {
  buildMessageEnvelope,
  publishConversationEvent,
  publishOperatorEvent,
  visitorMessageMetadata,
  visitorMessagePayload,
  WIDGET_EVENT_FIELDS,
  OPERATOR_ID_METADATA_KEYS,
} = await import('../../../server/services/realtime/publish.js');
const { publishMessageReactions } = await import('../../../server/services/messageReactions.js');

const WS = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const SARA = '33333333-3333-4333-8333-333333333333';
const ALI = '44444444-4444-4444-8444-444444444444';
const CONV = `ws:${WS}:conv:${CID}`;
const INBOX = `ws:${WS}:inbox`;
const HEART = '❤️';

beforeEach(() => { published.length = 0; });

const byChannel = () => Object.fromEntries(published.map((p) => [p.channel, p.envelope]));

describe('a message on the visitor\'s channel', () => {
  it('an operator\'s reply: no sender_id for the visitor, whole for the inbox', async () => {
    const envelope = buildMessageEnvelope({
      id: 'm1', conversation_id: CID, sender_type: 'agent', body: 'سلام', created_at: '2026-10-18T09:00:00Z',
      metadata: { source: 'inbox', client_message_id: 'cm_1' }, sender_id: SARA, sender_name: 'Sara', sender_avatar: null,
    });
    await publishConversationEvent({} as never, WS, CID, envelope);
    const ch = byChannel();
    expect(ch[INBOX]).toEqual(envelope);
    expect(ch[INBOX].payload.sender_id).toBe(SARA);
    expect(ch[CONV].type).toBe('message');
    expect(ch[CONV].payload).not.toHaveProperty('sender_id');
    expect(JSON.stringify(ch[CONV])).not.toContain(SARA);
    // Everything else, in the same order.
    const { sender_id: _drop, ...rest } = envelope.payload;
    expect(Object.keys(ch[CONV].payload)).toEqual(Object.keys(rest));
    expect(ch[CONV].payload).toEqual(rest);
  });

  it.each([
    ['a join', { kind: 'routing_agent_joined', agent_id: SARA, agent_name: 'Sara', actor_id: ALI, actor_name: 'Ali' }, { kind: 'routing_agent_joined', agent_name: 'Sara', actor_name: 'Ali' }],
    ['a transfer', { kind: 'conversation_transferred', internal: false, actor_id: ALI, actor_name: 'Ali', from_id: ALI, from_name: 'Ali', to_id: SARA, to_name: 'Sara' },
      { kind: 'conversation_transferred', internal: false, actor_name: 'Ali', from_name: 'Ali', to_name: 'Sara' }],
    ['the closed line', { kind: 'conversation_closed', by: 'agent', agent_id: ALI, agent_name: 'Ali', operator_id: SARA, operator_name: 'Sara', status: 'resolved' },
      { kind: 'conversation_closed', by: 'agent', agent_name: 'Ali', operator_name: 'Sara', status: 'resolved' }],
  ])('%s: the names reach the visitor, the ids only the inbox', async (_label, metadata, visible) => {
    const envelope = buildMessageEnvelope({ id: 'm2', conversation_id: CID, sender_type: 'system', body: 'x', created_at: null, metadata });
    await publishConversationEvent({} as never, WS, CID, envelope);
    const ch = byChannel();
    expect(ch[CONV].payload.metadata).toEqual(visible);
    expect(ch[INBOX].payload.metadata).toEqual(metadata);
    expect(JSON.stringify(ch[CONV])).not.toMatch(new RegExp(`${SARA}|${ALI}`));
  });

  it('a call row (the hanging-up operator as sender_id) and a visitor\'s own message keep everything but ids', async () => {
    const call = buildMessageEnvelope({
      id: 'm3', conversation_id: CID, sender_type: 'system', body: 'call', created_at: null, sender_id: ALI,
      metadata: { kind: 'call_ended', call_session_id: 'c1', ended_by: 'operator', duration_seconds: 9 },
    });
    await publishConversationEvent({} as never, WS, CID, call);
    expect(byChannel()[CONV].payload).toMatchObject({ metadata: { kind: 'call_ended', call_session_id: 'c1', ended_by: 'operator', duration_seconds: 9 } });
    expect(byChannel()[CONV].payload).not.toHaveProperty('sender_id');
  });

  it('typing envelopes go out unchanged (the operator typing payload has no ids)', async () => {
    const typing = { type: 'typing' as const, payload: { actor: 'agent', conversation_id: CID, ts: 1, name: 'Sara', avatar: null } };
    await publishConversationEvent({} as never, WS, CID, typing);
    expect(published).toEqual([{ channel: CONV, envelope: typing }]);
  });
});

describe('visitorMessageMetadata / visitorMessagePayload', () => {
  it('the same object when there is nothing to remove; non-objects as they are', () => {
    const meta = { source: 'widget', visitor_id: 'v-1', attachment_id: 'a1' };
    expect(visitorMessageMetadata(meta)).toBe(meta);
    expect(visitorMessageMetadata(null)).toBeNull();
    expect(visitorMessageMetadata(undefined)).toBeUndefined();
    const arr = [1];
    expect(visitorMessageMetadata(arr)).toBe(arr);
  });

  it('drops every operator id key, keeps the order of the rest and does not touch the input', () => {
    const meta: Record<string, unknown> = { kind: 'k', ...Object.fromEntries(OPERATOR_ID_METADATA_KEYS.map((k) => [k, SARA])), after: 1 };
    const out = visitorMessageMetadata(meta);
    expect(out).toEqual({ kind: 'k', after: 1 });
    expect(Object.keys(out)).toEqual(['kind', 'after']);
    expect(meta.agent_id).toBe(SARA);
  });

  it('the payload: sender_id out, metadata cleaned, the rest as it is', () => {
    const payload = { id: 'm', sender_id: SARA, metadata: { agent_id: SARA, agent_name: 'Sara' }, text: 'x' };
    expect(visitorMessagePayload(payload)).toEqual({ id: 'm', metadata: { agent_name: 'Sara' }, text: 'x' });
  });
});

describe('message_reactions', () => {
  it('is a widget kind with exactly the fields the badge needs', () => {
    expect(WIDGET_EVENT_FIELDS.message_reactions).toEqual(['kind', 'conversation_id', 'message_id', 'reactions', 'at']);
  });

  it('publishMessageReactions: whole on the inbox channel, the widget\'s fields on the conversation channel, no ids, no `mine`', async () => {
    await publishMessageReactions({} as never, {
      workspaceId: WS, conversationId: CID, messageId: 'm1', at: 1760778000000,
      reactions: [{ emoji: HEART, count: 2, visitor: true, mine: true }, { emoji: '👍', count: 1, visitor: false, mine: false }],
    });
    const ch = byChannel();
    expect(Object.keys(ch).sort()).toEqual([CONV, INBOX].sort());
    const reactions = [{ emoji: HEART, count: 2, visitor: true }, { emoji: '👍', count: 1, visitor: false }];
    expect(ch[INBOX]).toEqual({
      type: 'event',
      payload: { kind: 'message_reactions', workspace_id: WS, conversation_id: CID, message_id: 'm1', reactions, at: 1760778000000 },
    });
    expect(ch[CONV]).toEqual({
      type: 'event',
      payload: { kind: 'message_reactions', conversation_id: CID, message_id: 'm1', reactions, at: 1760778000000 },
    });
  });

  it('an actor id passed by mistake never reaches the visitor\'s channel', async () => {
    await publishOperatorEvent({} as never, {
      kind: 'message_reactions', workspace_id: WS, conversation_id: CID, actor_id: SARA, message_id: 'm1', reactions: [], at: 1,
    });
    expect(JSON.stringify(byChannel()[CONV])).not.toContain(SARA);
  });
});
