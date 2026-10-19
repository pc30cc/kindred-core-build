/**
 * The requester's support chat (iOS, Android: GET support history) names a
 * team member's join only by a real name. Rows stored before the fix carry
 * routing's English stand-in ('a colleague', chatRouting.ts) or an email in
 * `agent_name`; the apps put the name inside their own sentence
 * («a colleague به گفتگو پیوست»), so such a name is no name and the app uses
 * its localized team word, as every other reader does
 * (shared/systemMessages.ts visitorDisplayName).
 *
 * supportHistory runs for real on an in-memory data layer.
 */
import { describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return api; },
        in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return api; },
        is: () => api, order: () => api, limit: () => api,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: { data: Row[]; error: null; count: number }) => unknown) =>
          Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve),
      };
      return api;
    },
  }),
}));
vi.mock('../../../server/services/platformSupport/settings.js', () => ({
  loadPlatformSupportSettings: async () => ({ enabled: true, workspaceId: 'support-ws' }),
}));

const { supportHistory } = await import('../../../server/services/platformSupport/service.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

function joins(...names: Array<string | null>) {
  db.tables = {
    platform_support_threads: [{ conversation_id: 'c1', support_workspace_id: 'support-ws', user_id: 'u1', created_at: '2026-10-18T08:00:00Z' }],
    conversations: [{ id: 'c1', status: 'open', created_at: '2026-10-18T08:00:00Z', updated_at: '2026-10-18T08:00:00Z', metadata: {} }],
    conversation_messages: names.map((name, i) => ({
      id: `m${i}`, conversation_id: 'c1', sender_type: 'system', sender_id: null, body: `${name} joined the conversation.`,
      created_at: `2026-10-18T08:0${i + 1}:00Z`, metadata: { kind: 'routing_agent_joined', agent_name: name },
    })),
  };
}

describe('a join in the requester\'s support chat', () => {
  it('a stored stand-in or an email is no name: the app writes its team word', async () => {
    joins('a colleague', 'An operator', 'sara@team.example', '  ');
    const history = await supportHistory(CONFIG, 'u1');
    expect(history.items.map((i) => [i.kind, i.senderName])).toEqual([
      ['joined', null], ['joined', null], ['joined', null], ['joined', null],
    ]);
  });

  it('a real name is kept', async () => {
    joins('Sara');
    const history = await supportHistory(CONFIG, 'u1');
    expect(history.items.map((i) => i.senderName)).toEqual(['Sara']);
  });
});
