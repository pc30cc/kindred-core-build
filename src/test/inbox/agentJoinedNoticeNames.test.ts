/**
 * The join notice routing writes names the operator who joined, or nobody.
 *
 * chatRouting.resolveAgentDisplayName used to answer 'a colleague' for an
 * operator without a full name, and that English placeholder was stored as
 * the NAME (`metadata.agent_name`): every reader then wrote "a colleague
 * به گفتگو پیوست" in Persian, "a colleague görüşmeye katıldı" in Turkish. Now
 * the name is null and each reader writes its own generic sentence; the
 * stored body stays the English fallback ("A colleague joined the
 * conversation."), as every system row's.
 *
 * Calls/invitations: the inviting operator's EMAIL used to stand in for a
 * missing full name on the visitor's card; now the name is null there too.
 *
 * Both run for real against an in-memory fake of the data layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  profiles: [] as Row[],
  inserted: [] as Row[],
  conversation: null as Row | null,
  /** The assignee's presence as routing reads it (R-27: "joined" only while they are here). */
  presence: 'active' as string,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (name: string) => (name === 'claim_conversation' ? { data: true, error: null } : { data: true, error: null }),
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pending: Row | null = null;
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
        in: () => api,
        is: () => api,
        not: () => api,
        order: () => api,
        limit: () => api,
        update: () => api,
        insert(row: Row) {
          if (table === 'conversation_messages') db.inserted.push(row);
          pending = row;
          return api;
        },
        maybeSingle: async () => {
          if (table === 'profiles') {
            const id = filters.find(([c]) => c === 'id')?.[1];
            return { data: db.profiles.find((p) => p.id === id) || null, error: null };
          }
          if (table === 'conversations') return { data: db.conversation, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'call_invitations') {
            return { data: { id: 'inv-1', status: 'pending', expires_at: '2026-10-18T10:00:00Z', ...(pending || {}) }, error: null };
          }
          return { data: { id: 'm1', created_at: 'now', seen_at: null, ...(pending || {}) }, error: null };
        },
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return api;
    },
  }),
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
  publishConversationEvent: async () => {},
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/channels/telegram/offlineDelivery.js', () => ({ maybeQueueTelegramOfflineScreen: async () => false }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyAssignment: async () => {}, notifyHandoff: async () => {} }));
vi.mock('../../../server/services/conversationMetadata.js', () => ({ patchConversationMetadata: async () => true }));
vi.mock('../../../server/services/billing/locks/state.js', () => ({ resolveLockState: async () => ({}) }));
vi.mock('../../../server/services/billing/locks/predicates.js', () => ({ isMemberLocked: () => false }));
vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => {} }));
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.map((id) => [id, { state: db.presence, lastActivityAt: Date.now() }])),
}));
vi.mock('../../../server/services/calls/departments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/calls/departments.js')>()),
  resolveChatRoutingMember: async () => ({ role: 'agent', suspended: false, receivesChats: true }),
}));

const { routeConversationToOperator, claimConversationManually } = await import('../../../server/services/chatRouting.js');
const { createInvitation } = await import('../../../server/services/calls/invitations.js');

const config = {} as never;
const OP = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  db.profiles = [];
  db.inserted = [];
  db.conversation = null;
  db.presence = 'active';
});

const joins = () => db.inserted.filter((r) => (r.metadata as Row | undefined)?.kind === 'routing_agent_joined');

describe('routing\'s join notice', () => {
  it('an operator without a full name: no name stored, the generic English fallback body', async () => {
    db.profiles = [{ id: OP, full_name: null }];
    const res = await claimConversationManually(config, { workspaceId: 'ws1', conversationId: 'c1', userId: OP });
    expect(res.claimed).toBe(true);
    expect(joins()).toHaveLength(1);
    const [row] = joins();
    expect(row.body).toBe('A colleague joined the conversation.');
    expect(row.metadata).toEqual({ kind: 'routing_agent_joined', agent_name: null, agent_id: OP });
  });

  it('an operator with a full name: named, trimmed', async () => {
    db.profiles = [{ id: OP, full_name: '  سارا  ' }];
    await claimConversationManually(config, { workspaceId: 'ws1', conversationId: 'c1', userId: OP });
    const [row] = joins();
    expect(row.body).toBe('سارا joined the conversation.');
    expect(row.metadata).toEqual({ kind: 'routing_agent_joined', agent_name: 'سارا', agent_id: OP });
  });

  it('the hand-over to an operator already holding the conversation says the same', async () => {
    db.conversation = { id: 'c1', assigned_to: OP, metadata: {} };
    db.profiles = [{ id: OP, full_name: '' }];
    const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
    expect(res.outcome).toBe('already_assigned');
    const [row] = joins();
    expect(row.body).toBe('A colleague joined the conversation.');
    expect((row.metadata as Row).agent_name).toBeNull();
  });

  it('says nothing about an operator who is not here (offline, or no panel open)', async () => {
    db.conversation = { id: 'c1', assigned_to: OP, metadata: {} };
    db.profiles = [{ id: OP, full_name: 'Sara' }];
    for (const presence of ['offline', 'disconnected']) {
      db.presence = presence;
      const res = await routeConversationToOperator(config, { workspaceId: 'ws1', conversationId: 'c1' });
      expect(res.outcome).toBe('already_assigned');
    }
    expect(joins()).toEqual([]);
  });

  it('never stores an English placeholder as a name', async () => {
    db.profiles = [];
    await claimConversationManually(config, { workspaceId: 'ws1', conversationId: 'c1', userId: OP });
    expect(JSON.stringify(joins())).not.toMatch(/"agent_name":"a colleague"/i);
  });
});

describe('a call invitation\'s card', () => {
  const card = () => db.inserted.find((r) => (r.metadata as Row | undefined)?.kind === 'call_invitation')?.metadata as Row | undefined;

  it('names the operator by full name only, never by email', async () => {
    db.conversation = { id: 'c1', workspace_id: 'ws1', contact_id: null, visitor_session_id: null };
    db.profiles = [{ id: OP, full_name: null, email: 'sara@example.com' }];
    const res = await createInvitation(config, { workspaceId: 'ws1', conversationId: 'c1', operatorUserId: OP, channel: 'video' });
    expect(res.ok).toBe(true);
    expect(card()?.operator_name).toBeNull();
    expect(JSON.stringify(db.inserted)).not.toContain('sara@example.com');
  });

  it('a full name is used', async () => {
    db.conversation = { id: 'c1', workspace_id: 'ws1', contact_id: null, visitor_session_id: null };
    db.profiles = [{ id: OP, full_name: 'Sara Ahmadi', email: 'sara@example.com' }];
    await createInvitation(config, { workspaceId: 'ws1', conversationId: 'c1', operatorUserId: OP, channel: 'audio' });
    expect(card()?.operator_name).toBe('Sara Ahmadi');
  });
});
