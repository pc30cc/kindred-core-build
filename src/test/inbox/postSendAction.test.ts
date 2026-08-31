import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Split Send — server-side status transition contract.
 * Covers: Send (no transition), Send & wait, Send & resolve, idempotent
 * double-click, and the fact that a failed send never reaches this layer.
 */

const events: any[] = [];
const published: any[] = [];
let rows: Record<string, { status: string }> = {};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (_table: string) => {
      const state: any = { id: null, ws: null, allowed: [] as string[], patch: null };
      const api: any = {
        update(patch: any) { state.patch = patch; return api; },
        eq(col: string, val: string) {
          if (col === 'id') state.id = val;
          if (col === 'workspace_id') state.ws = val;
          return api;
        },
        in(_col: string, vals: string[]) { state.allowed = vals; return api; },
        select() { return api; },
        async maybeSingle() {
          const row = rows[state.id];
          if (!row || !state.allowed.includes(row.status)) return { data: null, error: null };
          row.status = state.patch.status;
          return { data: { id: state.id, status: row.status, updated_at: 'now' }, error: null };
        },
      };
      return api;
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
});
