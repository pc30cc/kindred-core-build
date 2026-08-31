import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Split Send — server-side status transition contract.
 * Covers: Send (no transition), Send & wait, Send & resolve, idempotent
 * double-click, the customer-replied race guard, and the rule that a failed
 * provider dispatch must never move the conversation.
 *
 * The transition itself lives in the DB function
 * `conversation_apply_post_send_action` (migration 070); this test emulates
 * its documented semantics faithfully (row lock + allowed-from + "no newer
 * customer message").
 */

const events: any[] = [];
const published: any[] = [];
let rows: Record<string, { status: string }> = {};
/** messages per conversation: { id, sender, seq } ordered by seq */
let messages: Record<string, { id: string; sender: string; seq: number }[]> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    async rpc(fn: string, args: any) {
      if (fn !== 'conversation_apply_post_send_action') throw new Error('unexpected rpc ' + fn);
      const row = rows[args.p_conversation_id];
      if (!row) return { data: [{ changed: false, blocked_reason: 'not_found' }], error: null };
      if (!args.p_allowed_from.includes(row.status)) {
        return { data: [{ changed: false, new_status: row.status, blocked_reason: 'status_conflict' }], error: null };
      }
      const list = messages[args.p_conversation_id] ?? [];
      const anchor = list.find(m => m.id === args.p_after_message_id);
      if (anchor && list.some(m => m.sender === 'contact' && m.seq > anchor.seq)) {
        return { data: [{ changed: false, new_status: row.status, blocked_reason: 'customer_replied' }], error: null };
      }
      row.status = args.p_target_status;
      return { data: [{ changed: true, new_status: row.status, changed_at: 'now', blocked_reason: null }], error: null };
    },
  }),
}));

vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordAuditAndEvent: async (_c: any, input: any) => { events.push(input); },
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async (_c: any, p: any) => { published.push(p); },
}));

const { applyPostSendAction } = await import('../../../server/services/conversationPostSend');

const base = {
  workspaceId: 'ws1',
  conversationId: 'c1',
  actorId: 'agent1',
  messageId: 'm1',
};

beforeEach(() => {
  events.length = 0;
  published.length = 0;
  rows = { c1: { status: 'open' } };
  messages = { c1: [{ id: 'm1', sender: 'agent', seq: 1 }] };
});

describe('applyPostSendAction', () => {
  it('Send: leaves the conversation open and writes no event', async () => {
    const r = await applyPostSendAction({} as any, { ...base, action: 'none' });
    expect(r.changed).toBe(false);
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(0);
  });

  it('Send & wait: open → pending with reason waiting_for_customer', async () => {
    const r = await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    expect(r).toMatchObject({ changed: true, status: 'pending', reason: 'waiting_for_customer' });
    expect(rows.c1.status).toBe('pending');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('status_changed');
    expect(events[0].payload.reason).toBe('waiting_for_customer');
    expect(events[0].payload.source).toBe('composer_send_action');
  });

  it('Send & resolve: open → resolved with a resolved timeline event', async () => {
    const r = await applyPostSendAction({} as any, { ...base, action: 'resolve' });
    expect(r).toMatchObject({ changed: true, status: 'resolved', reason: 'resolved_after_reply' });
    expect(rows.c1.status).toBe('resolved');
    expect(events[0].eventType).toBe('resolved');
  });

  it('multiple plain sends keep the thread open', async () => {
    for (let i = 0; i < 3; i++) {
      await applyPostSendAction({} as any, { ...base, action: 'none' });
    }
    expect(rows.c1.status).toBe('open');
  });

  it('double-click / retry produces exactly one transition + one event', async () => {
    await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    const second = await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    expect(second.changed).toBe(false);
    expect(events).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('never resolves/parks a conversation that is already closed', async () => {
    rows.c1.status = 'closed';
    const r = await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    expect(r.changed).toBe(false);
    expect(rows.c1.status).toBe('closed');
  });

  // ── Race 1 — customer replies between insert and transition ─────────
  it('Race 1: customer message arriving after the agent reply keeps it open', async () => {
    messages.c1.push({ id: 'v1', sender: 'contact', seq: 2 });
    const r = await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    expect(r.changed).toBe(false);
    expect(r.blocked).toBe('customer_replied');
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(0);
  });

  it('Race 1 (resolve): a newer customer message also blocks Send & resolve', async () => {
    messages.c1.push({ id: 'v1', sender: 'contact', seq: 2 });
    const r = await applyPostSendAction({} as any, { ...base, action: 'resolve' });
    expect(r.changed).toBe(false);
    expect(rows.c1.status).toBe('open');
  });

  it('an OLDER customer message (the one being answered) does not block', async () => {
    messages.c1 = [
      { id: 'v0', sender: 'contact', seq: 0 },
      { id: 'm1', sender: 'agent', seq: 1 },
    ];
    const r = await applyPostSendAction({} as any, { ...base, action: 'wait_for_customer' });
    expect(r.changed).toBe(true);
    expect(rows.c1.status).toBe('pending');
  });

  // ── Race 2 / 3 — provider dispatch failure ──────────────────────────
  it('Race 2: failed external dispatch must NOT park the conversation', async () => {
    const r = await applyPostSendAction({} as any, {
      ...base, action: 'wait_for_customer', deliveryAccepted: false,
    });
    expect(r.changed).toBe(false);
    expect(r.blocked).toBe('delivery_failed');
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(0);
  });

  it('Race 3: failed external dispatch must NOT resolve the conversation', async () => {
    const r = await applyPostSendAction({} as any, {
      ...base, action: 'resolve', deliveryAccepted: false,
    });
    expect(r.changed).toBe(false);
    expect(rows.c1.status).toBe('open');
  });

  it('accepted dispatch still transitions normally', async () => {
    const r = await applyPostSendAction({} as any, {
      ...base, action: 'wait_for_customer', deliveryAccepted: true,
    });
    expect(r.changed).toBe(true);
    expect(rows.c1.status).toBe('pending');
  });
});
