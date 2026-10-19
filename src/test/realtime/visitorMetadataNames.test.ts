/**
 * The names a visitor reads in a system row, an AI reply and a quote
 * (owner, 2026-10-18: no automatic text in another language than the
 * widget's):
 *
 *  - an English stand-in stored as a NAME ('a colleague',
 *    chatRouting.resolveAgentDisplayName until now) or an email address
 *    (call invitations' operator_name fallback) never reaches the visitor
 *    as a name: `agent_name`, `to_name`, `operator_name` lose it, a
 *    placeholder `sender_name` is null. Each renderer then writes its own
 *    generic sentence in the visitor's language. A real name stays, and a
 *    row with nothing to change is the same object;
 *  - the AI's built-in name ('AI Assistant', English in every language)
 *    still goes out as stored, on the realtime envelope and on /poll,
 *    /history (senderIdentity.ts): the runtime.js loaded before this
 *    release labels the AI's replies with it, and `default` loses the
 *    reply's badge and time without one. Today's runtime treats it as no
 *    name (runtime.js aiOwnName; src/test/widget/aiNamelessRun.test.ts).
 *    On /poll and /history a name the owner gave the agent since wins over
 *    the default a row was stamped with;
 *  - a quoted system row carries its kind and the names its sentence needs
 *    (widgetAttachments.ts visitorReplyPreview); one of a kind the widget
 *    cannot write is not quoted at all, as an internal one.
 */
import { describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock('../../../server/supabase.js', () => {
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return b;
  }
  return { getServiceClient: () => ({ from: (t: string) => builder(t) }) };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async () => new Map(),
}));

const { visitorMessageMetadata, visitorMessagePayload, buildMessageEnvelope } =
  await import('../../../server/services/realtime/publish.js');
const { enrichMessagesWithReplyTo, visitorReplyPreview } = await import('../../../server/routes/widgetAttachments.js');
const { enrichMessagesWithSender } = await import('../../../server/services/widget/senderIdentity.js');
const { DEFAULT_AI_AGENT_NAME } = await import('../../../server/services/ai-agent/settings.js');
const { getServiceClient } = await import('../../../server/supabase.js');

const CID = '22222222-2222-4222-8222-222222222222';
const WS = '11111111-1111-4111-8111-111111111111';

describe('visitorMessageMetadata: names that are not names', () => {
  it('drops a placeholder agent_name, keeps the rest', () => {
    expect(visitorMessageMetadata({ kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: 'u1' }))
      .toEqual({ kind: 'routing_agent_joined' });
    expect(visitorMessageMetadata({ kind: 'routing_agent_joined', agent_name: ' A Colleague ' }))
      .toEqual({ kind: 'routing_agent_joined' });
    expect(visitorMessageMetadata({ kind: 'routing_agent_joined', agent_name: 'An operator' }))
      .toEqual({ kind: 'routing_agent_joined' });
  });

  it('drops an email address in agent_name, to_name or operator_name', () => {
    expect(visitorMessageMetadata({ kind: 'call_invitation', channel: 'video', operator_name: 'sara@example.com', status: 'pending' }))
      .toEqual({ kind: 'call_invitation', channel: 'video', status: 'pending' });
    expect(visitorMessageMetadata({ kind: 'conversation_transferred', to_name: 'ops@example.com', actor_name: 'Ali' }))
      .toEqual({ kind: 'conversation_transferred', actor_name: 'Ali' });
  });

  it('keeps real names (Persian too) and returns the same object when nothing changes', () => {
    const join = { kind: 'routing_agent_joined', agent_name: 'سارا' };
    expect(visitorMessageMetadata(join)).toBe(join);
    const invite = { kind: 'call_invitation', channel: 'audio', operator_name: 'Sara Ahmadi', status: 'pending' };
    expect(visitorMessageMetadata(invite)).toBe(invite);
    const plain = { source: 'widget', client_message_id: 'cm_1' };
    expect(visitorMessageMetadata(plain)).toBe(plain);
  });

  it('keeps the key order of what stays', () => {
    const out = visitorMessageMetadata({ kind: 'routing_agent_joined', agent_id: 'u1', agent_name: 'a colleague', at: 1 });
    expect(Object.keys(out)).toEqual(['kind', 'at']);
  });
});

describe('visitorMessagePayload: sender names', () => {
  const envelope = (row: Parameters<typeof buildMessageEnvelope>[0]) => buildMessageEnvelope(row).payload;

  it('a join whose name was a placeholder goes out without a name anywhere', () => {
    const out = visitorMessagePayload(envelope({
      id: 'm1', conversation_id: CID, sender_type: 'system', body: 'a colleague joined the conversation.',
      created_at: '2026-10-18T09:00:00Z', metadata: { kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: 'u1' },
    }));
    expect(out.sender_name).toBeNull();
    expect(out.metadata).toEqual({ kind: 'routing_agent_joined' });
    expect(JSON.stringify(out)).not.toContain('a colleague"');
  });

  it('a real join keeps its name', () => {
    const out = visitorMessagePayload(envelope({
      id: 'm1', conversation_id: CID, sender_type: 'system', body: 'Sara joined the conversation.',
      created_at: '2026-10-18T09:00:00Z', metadata: { kind: 'routing_agent_joined', agent_name: 'Sara', agent_id: 'u1' },
    }));
    expect(out.sender_name).toBe('Sara');
    expect(out.metadata).toEqual({ kind: 'routing_agent_joined', agent_name: 'Sara' });
  });

  it('an AI reply keeps the name it was stored with, the built-in default too', () => {
    expect(DEFAULT_AI_AGENT_NAME).toBe('AI Assistant');
    const def = visitorMessagePayload(envelope({
      id: 'a1', conversation_id: CID, sender_type: 'ai', body: 'سلام!', created_at: '2026-10-18T09:00:00Z',
      metadata: { source: 'ai_agent', agent_name: 'AI Assistant' },
    }));
    expect(def.sender_name).toBe('AI Assistant');
    expect(def.metadata).toEqual({ source: 'ai_agent', agent_name: 'AI Assistant' });
    const named = visitorMessagePayload(envelope({
      id: 'a2', conversation_id: CID, sender_type: 'ai', body: 'سلام!', created_at: '2026-10-18T09:00:00Z',
      metadata: { source: 'ai_agent', agent_name: 'نیلو' },
    }));
    expect(named.sender_name).toBe('نیلو');
    expect(named.metadata).toEqual({ source: 'ai_agent', agent_name: 'نیلو' });
  });

  it('an operator who happens to be called "AI Assistant" keeps the name', () => {
    const out = visitorMessagePayload(envelope({
      id: 'o1', conversation_id: CID, sender_type: 'agent', body: 'hi', created_at: '2026-10-18T09:00:00Z',
      metadata: {}, sender_name: 'AI Assistant',
    }));
    expect(out.sender_name).toBe('AI Assistant');
  });
});

describe('/poll and /history: the AI default name (senderIdentity.ts)', () => {
  it('an AI row under the default name keeps it; a name the owner chose since wins', async () => {
    db.tables = { ai_agent_settings: [{ workspace_id: WS, agent_name: 'AI Assistant', agent_logo_url: null, metadata: {} }] };
    const out = await enrichMessagesWithSender({} as never, getServiceClient({} as never), [
      { id: 'a1', role: 'agent', sender_type: 'ai', _sender_id: null, text: 'سلام!', metadata: { source: 'ai_agent', agent_name: 'AI Assistant' } },
      { id: 'a2', role: 'agent', sender_type: 'ai', _sender_id: null, text: 'سلام!', metadata: { source: 'ai_agent' } },
    ], WS) as Array<Record<string, unknown>>;
    expect(out[0].sender_name).toBe('AI Assistant');
    expect(out[0].metadata).toEqual({ source: 'ai_agent', agent_name: 'AI Assistant' });
    expect(out[1].sender_name).toBe('AI Assistant');
    expect(out[1].metadata).toEqual({ source: 'ai_agent' });

    db.tables = { ai_agent_settings: [{ workspace_id: WS, agent_name: 'نیلو', agent_logo_url: null, metadata: {} }] };
    const named = await enrichMessagesWithSender({} as never, getServiceClient({} as never), [
      { id: 'a3', role: 'agent', sender_type: 'ai', _sender_id: null, text: 'سلام!', metadata: { source: 'ai_agent', agent_name: 'AI Assistant' } },
    ], WS) as Array<Record<string, unknown>>;
    // A row stamped with the default before the owner named the agent reads the name it has now.
    expect(named[0].sender_name).toBe('نیلو');
  });
});

describe('a quoted system row (reply_to)', () => {
  const parent = (id: string, sender_type: string, body: string, metadata: Row) =>
    ({ id, conversation_id: CID, sender_type, body, metadata });

  it('carries its kind and the visitor\'s metadata; an unknown kind is not quoted (as an internal row)', async () => {
    db.tables = {
      conversation_messages: [
        parent('p-queue', 'system', 'Your message is in the support queue.', { kind: 'routing_in_queue' }),
        parent('p-transfer', 'system', 'Ali transferred this conversation to Sara', {
          kind: 'conversation_transferred', actor_id: 'u1', actor_name: 'Ali', from_id: 'u1', from_name: 'Ali', to_id: 'u2', to_name: 'Sara',
        }),
        parent('p-new', 'system', 'Something new', { kind: 'something_new' }),
        parent('p-internal', 'system', 'Ali unassigned this conversation', { kind: 'conversation_unassigned', internal: true }),
        parent('p-agent', 'agent', 'سفارشتان ارسال شد.', {}),
      ],
    };
    const out = await enrichMessagesWithReplyTo({} as never, CID, [
      { id: 'v1', reply_to_message_id: 'p-queue' },
      { id: 'v2', reply_to_message_id: 'p-transfer' },
      { id: 'v3', reply_to_message_id: 'p-new' },
      { id: 'v4', reply_to_message_id: 'p-internal' },
      { id: 'v5', reply_to_message_id: 'p-agent' },
    ]);
    expect(out).toEqual([
      { id: 'v1', reply_to_message_id: 'p-queue', reply_to: { id: 'p-queue', text: 'Your message is in the support queue.', sender_type: 'system', kind: 'routing_in_queue', meta: {} } },
      { id: 'v2', reply_to_message_id: 'p-transfer', reply_to: { id: 'p-transfer', text: 'Ali transferred this conversation to Sara', sender_type: 'system', kind: 'conversation_transferred', meta: { to_name: 'Sara' } } },
      { id: 'v3', reply_to_message_id: null, reply_to: null },
      { id: 'v4', reply_to_message_id: null, reply_to: null },
      { id: 'v5', reply_to_message_id: 'p-agent', reply_to: { id: 'p-agent', text: 'سفارشتان ارسال شد.', sender_type: 'agent' } },
    ]);
  });

  it('visitorReplyPreview (POST /message\'s quote too): the same rule', () => {
    expect(visitorReplyPreview({ id: 'p', body: 'You have been invited to a video call.', sender_type: 'system', metadata: { kind: 'call_invitation', channel: 'video', operator_name: 'sara@example.com' } }))
      .toEqual({ id: 'p', text: 'You have been invited to a video call.', sender_type: 'system', kind: 'call_invitation', meta: { channel: 'video' } });
    expect(visitorReplyPreview({ id: 'p', body: 'x', sender_type: 'system', metadata: { kind: 'conversation_closed' } })).toBeNull();
    expect(visitorReplyPreview({ id: 'p', body: null, sender_type: 'contact', metadata: null }))
      .toEqual({ id: 'p', text: '', sender_type: 'contact' });
  });
});
