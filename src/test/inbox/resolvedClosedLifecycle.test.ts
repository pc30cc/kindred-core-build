import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * resolved / closed lifecycle for a NEW inbound customer message.
 *
 *   resolved + real customer message → same conversation, reopened to `open`
 *   closed   + real customer message → old thread untouched, NEW conversation
 *
 * Part 1 drives the real shared helpers against a fake conversations table
 * (CAS atomicity, single event, realtime echo, concurrency, idempotency).
 * Part 2 pins the ingest wiring of every channel so Widget, Telegram, Bale,
 * WhatsApp and Instagram cannot drift apart again.
 */

const events: any[] = [];
const published: any[] = [];
let rows: Record<string, { status: string }> = {};
/** Serializes CAS updates the way a Postgres row lock does. */
let lock: Promise<unknown> = Promise.resolve();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (_t: string) => {
      const state: any = { id: null, ws: null, from: null, patch: null };
      const api: any = {
        update(patch: any) { state.patch = patch; return api; },
        eq(col: string, val: string) {
          if (col === 'id') state.id = val;
          if (col === 'workspace_id') state.ws = val;
          if (col === 'status') state.from = val;
          return api;
        },
        select() { return api; },
        maybeSingle() {
          const run = lock.then(() => {
            const row = rows[state.id];
            if (!row || row.status !== state.from) return { data: null, error: null };
            row.status = state.patch.status;
            return { data: { id: state.id, status: row.status, updated_at: 'now' }, error: null };
          });
          lock = run;
          return run;
        },
      };
      return api;
    },
  }),
}));

vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: any, input: any) => { events.push(input); return { ok: true }; },
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async (_c: any, p: any) => { published.push(p); },
}));

const {
  reopenConversationIfResolved,
  applyInboundConversationLifecycle,
  decideInboundConversationLifecycle,
  INBOUND_REUSABLE_STATUSES,
} = await import('../../../server/services/conversationLifecycle');

const base = { workspaceId: 'ws1', conversationId: 'c1' };
const customerText = (text = 'سلام دوباره') => ({ senderType: 'contact', direction: 'inbound' as const, text });
const customerAttachment = () => ({
  senderType: 'contact',
  direction: 'inbound' as const,
  text: '',
  attachmentCount: 1,
});

beforeEach(() => {
  events.length = 0;
  published.length = 0;
  rows = { c1: { status: 'resolved' } };
  lock = Promise.resolve();
});

describe('decision table', () => {
  it('maps every status to the canonical decision', () => {
    expect(decideInboundConversationLifecycle('open')).toBe('reuse');
    expect(decideInboundConversationLifecycle('pending')).toBe('resume_pending');
    expect(decideInboundConversationLifecycle('resolved')).toBe('reopen_resolved');
    expect(decideInboundConversationLifecycle('closed')).toBe('create_new_after_closed');
  });

  it('closed is never a reusable inbound status', () => {
    expect([...INBOUND_REUSABLE_STATUSES]).toEqual(['open', 'pending', 'resolved']);
    expect(INBOUND_REUSABLE_STATUSES).not.toContain('closed');
  });
});

describe('resolved → open on a real customer message', () => {
  for (const source of ['widget', 'telegram', 'whatsapp', 'bale', 'instagram']) {
    it(`${source}: same conversation, reopened`, async () => {
      const r = await applyInboundConversationLifecycle({} as any, {
        ...base, source, message: customerText(), messageId: 'm1',
      });
      expect(r.transition).toBe('reopened_resolved');
      expect(rows.c1.status).toBe('open');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        conversationId: 'c1', eventType: 'reopened', actorType: 'visitor', actorId: null,
      });
      expect(events[0].payload).toMatchObject({
        from: 'resolved', to: 'open', reason: 'customer_replied_after_resolution', source, message_id: 'm1',
      });
    });
  }

  it('widget attachment with empty body also reopens', async () => {
    const r = await reopenConversationIfResolved({} as any, {
      ...base, source: 'widget', message: customerAttachment(),
    });
    expect(r).toEqual({ reopened: true, reason: 'customer_replied_after_resolution' });
    expect(rows.c1.status).toBe('open');
  });

  it('publishes exactly one conversation_updated realtime envelope', async () => {
    await reopenConversationIfResolved({} as any, { ...base, source: 'widget', message: customerText() });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 'conversation_updated',
      conversation_id: 'c1',
      workspace_id: 'ws1',
      reason: 'customer_replied_after_resolution',
    });
    expect(published[0].changes).toEqual({ status: { from: 'resolved', to: 'open' } });
  });

  it('concurrent customer replies produce ONE transition', async () => {
    const [a, b] = await Promise.all([
      reopenConversationIfResolved({} as any, { ...base, source: 'telegram', message: customerText('A') }),
      reopenConversationIfResolved({} as any, { ...base, source: 'telegram', message: customerText('B') }),
    ]);
    expect([a.reopened, b.reopened].filter(Boolean)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(rows.c1.status).toBe('open');
  });

  it('duplicate webhook redelivery does not reopen twice', async () => {
    await reopenConversationIfResolved({} as any, { ...base, source: 'telegram', message: customerText() });
    const again = await reopenConversationIfResolved({} as any, { ...base, source: 'telegram', message: customerText() });
    expect(again).toEqual({ reopened: false, reason: 'not_resolved' });
    expect(events).toHaveLength(1);
  });

  it('agent / AI / system / echo / menu events never reopen', async () => {
    const nope = [
      { senderType: 'agent', direction: 'inbound' as const, text: 'hi' },
      { senderType: 'ai', direction: 'inbound' as const, text: 'hi' },
      { senderType: 'contact', direction: 'outbound' as const, text: 'hi' },
      { senderType: 'contact', direction: 'inbound' as const, text: '/start', isMenuEvent: true },
      { senderType: 'contact', direction: 'inbound' as const, text: 'echo', isEcho: true },
      { senderType: 'contact', direction: 'inbound' as const, text: '   ' },
    ];
    for (const message of nope) {
      const r = await reopenConversationIfResolved({} as any, { ...base, message });
      expect(r.reopened).toBe(false);
    }
    expect(rows.c1.status).toBe('resolved');
    expect(events).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

describe('other statuses are untouched by the resolved path', () => {
  it('open stays open and emits nothing', async () => {
    rows = { c1: { status: 'open' } };
    const r = await applyInboundConversationLifecycle({} as any, { ...base, message: customerText() });
    expect(r.transition).toBe('none');
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(0);
  });

  it('pending still resumes with the unchanged customer_replied reason', async () => {
    rows = { c1: { status: 'pending' } };
    const r = await applyInboundConversationLifecycle({} as any, {
      ...base, source: 'widget', message: customerText(),
    });
    expect(r.transition).toBe('resumed_pending');
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ from: 'pending', to: 'open', reason: 'customer_replied' });
  });

  it('closed is never reopened by the lifecycle helpers', async () => {
    rows = { c1: { status: 'closed' } };
    const r = await applyInboundConversationLifecycle({} as any, {
      ...base, source: 'telegram', message: customerText(),
    });
    expect(r.transition).toBe('none');
    expect(rows.c1.status).toBe('closed');
    expect(events).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

/* ── Part 2 — ingest wiring (source-level contract) ─────────────────── */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('channel ingest wiring (Telegram / Bale / WhatsApp / Instagram)', () => {
  const src = read('server/services/channels/inboundProcessing.ts');

  it('reuses only open/pending/resolved threads → closed spawns a new conversation', () => {
    expect(src).toContain(".in('status', INBOUND_REUSABLE_STATUSES");
    expect(src).not.toContain(".in('status', ['open', 'pending'])");
  });

  it('applies the shared lifecycle AFTER the message insert', () => {
    const insertAt = src.indexOf("from('conversation_messages')");
    const lifecycleAt = src.indexOf('applyInboundConversationLifecycle(config');
    expect(insertAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(insertAt);
  });

  it('new conversations are born open and record a created event', () => {
    expect(src).toContain("status: 'open'");
    expect(src).toContain("eventType: 'created'");
  });
});

describe('widget ingest wiring', () => {
  const src = read('server/routes/widget.ts');

  it('never silently flips resolved/closed to open', () => {
    expect(src).not.toContain("if (['closed', 'resolved'].includes(conv.status))");
    expect(src).not.toContain(".in('status', ['resolved', 'closed'])");
  });

  it('a closed thread passed by the client forces a new conversation', () => {
    expect(src).toContain("if (conv.status === 'closed') convId = null;");
  });

  it('continuity lookups exclude closed threads', () => {
    expect(src).not.toContain(".in('status', ['open', 'pending'])");
    expect(src.match(/INBOUND_REUSABLE_STATUSES as unknown as string\[\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('applies the shared lifecycle after the visitor message insert', () => {
    const insertAt = src.indexOf("from('conversation_messages').insert");
    const lifecycleAt = src.indexOf('applyInboundConversationLifecycle(config');
    expect(insertAt).toBeGreaterThan(-1);
    expect(lifecycleAt).toBeGreaterThan(insertAt);
  });

  it('manual panel reopen uses its own reason and refuses closed threads', () => {
    expect(src).toContain('manual_reopen_by_visitor');
    expect(src).toContain('closed: true');
  });
});
