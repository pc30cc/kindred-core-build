/**
 * publishVisitorSeen (server/services/widget/visitorSeen.ts): the `seen`
 * envelope an operator's read sends to the visitor's widget (I-03). It
 * carries the conversation, when, and the visitor's own message ids only,
 * at most SEEN_IDS_CAP; nothing goes out when the workspace
 * turned read receipts off or nothing was newly read, and a failing
 * snapshot read does not stop it.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => [] as Array<{ ws: string; cid: string; event: { type: string; payload: Record<string, unknown> } }>);
const snapshot = vi.hoisted(() => ({ settings: { read_receipts_enabled: true } as Record<string, unknown> | null, fail: false }));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, event: { type: string; payload: Record<string, unknown> }) => {
    published.push({ ws, cid, event });
    return { ok: true };
  },
}));
vi.mock('../../../server/services/widget/configSnapshot.js', () => ({
  getWorkspaceWidgetSnapshot: async () => {
    if (snapshot.fail) throw new Error('db down');
    return { settings: snapshot.settings };
  },
}));

const { publishVisitorSeen, SEEN_IDS_CAP } = await import('../../../server/services/widget/visitorSeen.js');
const config = {} as Parameters<typeof publishVisitorSeen>[0];

beforeEach(() => {
  published.length = 0;
  snapshot.settings = { read_receipts_enabled: true };
  snapshot.fail = false;
});

describe('publishVisitorSeen', () => {
  it('publishes the ids on the conversation channel', async () => {
    await publishVisitorSeen(config, 'ws1', 'c1', ['m1', 'm2'], '2026-10-21T10:00:00.000Z');
    expect(published).toEqual([{
      ws: 'ws1', cid: 'c1',
      event: { type: 'seen', payload: { conversation_id: 'c1', seen_at: '2026-10-21T10:00:00.000Z', message_ids: ['m1', 'm2'] } },
    }]);
  });

  it('nothing when read receipts are off, or nothing was newly read', async () => {
    snapshot.settings = { read_receipts_enabled: false };
    await publishVisitorSeen(config, 'ws1', 'c1', ['m1'], 'now');
    snapshot.settings = { read_receipts_enabled: true };
    await publishVisitorSeen(config, 'ws1', 'c1', [], 'now');
    expect(published).toHaveLength(0);
  });

  it('an unreadable snapshot does not stop it; a long list is capped', async () => {
    snapshot.fail = true;
    const ids = Array.from({ length: SEEN_IDS_CAP + 5 }, (_, i) => `m${i}`);
    await publishVisitorSeen(config, 'ws1', 'c1', ids, 'now');
    expect(published).toHaveLength(1);
    const sent = published[0].event.payload.message_ids as string[];
    expect(sent).toHaveLength(SEEN_IDS_CAP);
    expect(sent[sent.length - 1]).toBe(`m${SEEN_IDS_CAP + 4}`);
  });
});
