import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * pending → open lifecycle.
 *
 * Part 1 exercises the real transition helper against a fake conversations
 * table (atomicity, eligibility, single event, realtime echo).
 * Part 2 pins the ingest wiring that decides WHICH events ever reach it.
 */

type Recorded = Record<string, unknown> & { payload: Record<string, unknown> };
const events: Recorded[] = [];
const published: Array<Record<string, unknown>> = [];
let rows: Record<string, { status: string }> = {};
/** Serializes CAS updates the way a Postgres row lock does. */
let lock: Promise<unknown> = Promise.resolve();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (_t: string) => {
      const state: { id: string | null; ws: string | null; from: string | null; patch: { status: string } | null } = {
        id: null, ws: null, from: null, patch: null,
      };
      type Api = {
        update(patch: { status: string }): Api;
        eq(col: string, val: string): Api;
        select(): Api;
        maybeSingle(): Promise<unknown>;
      };
      const api: Api = {
        update(patch: { status: string }) { state.patch = patch; return api; },
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
  recordConversationEvent: async (_c: unknown, input: Recorded) => { events.push(input); return { ok: true }; },
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async (_c: unknown, p: Record<string, unknown>) => { published.push(p); },
}));

const { resumeConversationIfPending } = await import('../../../server/services/conversationPending');
const { isInboundCustomerMessageEligibleForResume } = await import(
  '../../../server/services/conversationResumeEligibility'
);
type ResumeCandidate = Parameters<typeof isInboundCustomerMessageEligibleForResume>[0];

const base = { workspaceId: 'ws1', conversationId: 'c1' };
const customerText = (text = 'سلام') => ({ senderType: 'contact', direction: 'inbound' as const, text });
const customerMedia = (kind: string) => ({
  senderType: 'contact',
  direction: 'inbound' as const,
  text: '',
  attachmentCount: 1,
  kind,
});

beforeEach(() => {
  events.length = 0;
  published.length = 0;
  rows = { c1: { status: 'pending' } };
  lock = Promise.resolve();
});

describe('customer messages resume a parked thread', () => {
  it('widget text', async () => {
    const r = await resumeConversationIfPending({} as never, { ...base, source: 'widget', message: customerText() });
    expect(r).toEqual({ resumed: true, reason: 'customer_replied' });
    expect(rows.c1.status).toBe('open');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'status_changed', actorType: 'visitor', actorId: null });
    expect(events[0].payload).toMatchObject({ from: 'pending', to: 'open', reason: 'customer_replied', source: 'widget' });
  });

  it('widget attachment with empty body', async () => {
    const r = await resumeConversationIfPending({} as never, {
      ...base, source: 'widget',
      message: { senderType: 'contact', direction: 'inbound', text: '', attachmentCount: 1 },
    });
    expect(r.resumed).toBe(true);
    expect(rows.c1.status).toBe('open');
  });

  it.each(['telegram', 'bale', 'whatsapp', 'instagram'])('%s customer text', async (provider) => {
    const r = await resumeConversationIfPending({} as never, { ...base, source: provider, message: customerText() });
    expect(r.resumed).toBe(true);
    expect(events[0].payload.source).toBe(provider);
  });

  it.each([
    ['telegram', 'photo'], ['telegram', 'voice'], ['telegram', 'document'],
    ['whatsapp', 'image'], ['whatsapp', 'document'], ['whatsapp', 'voice'],
    ['whatsapp', 'audio'], ['whatsapp', 'video'], ['whatsapp', 'sticker'],
    ['bale', 'photo'], ['instagram', 'image'],
  ])('%s customer %s media', async (provider, kind) => {
    const r = await resumeConversationIfPending({} as never, {
      ...base, source: provider, message: customerMedia(kind),
    });
    expect(r.resumed).toBe(true);
    expect(rows.c1.status).toBe('open');
  });
});

describe('non-customer traffic never resumes', () => {
  const cases: Array<[string, ResumeCandidate]> = [
    ['agent reply', { senderType: 'agent', direction: 'outbound', text: 'hi' }],
    ['ai reply', { senderType: 'ai', direction: 'outbound', text: 'hi' }],
    ['bot/automation message', { senderType: 'bot', direction: 'outbound', text: 'hi' }],
    ['internal note', { senderType: 'contact', direction: 'inbound', text: 'note', isInternalNote: true }],
    ['system/assignment/status/workflow event', { senderType: 'system', direction: 'inbound', text: 'assigned' }],
    ['synthetic system row', { senderType: 'contact', direction: 'inbound', text: 'x', isSystemGenerated: true }],
    ['provider outbound echo', { senderType: 'contact', direction: 'inbound', text: 'x', isEcho: true }],
    ['outbound direction', { senderType: 'contact', direction: 'outbound', text: 'x' }],
    ['menu/callback navigation', { senderType: 'contact', direction: 'inbound', text: '/start', isMenuEvent: true }],
    ['empty message', { senderType: 'contact', direction: 'inbound', text: '   ', attachmentCount: 0 }],
  ];

  it.each(cases)('%s stays pending', async (_label, message) => {
    const r = await resumeConversationIfPending({} as never, { ...base, message });
    expect(r.resumed).toBe(false);
    expect(rows.c1.status).toBe('pending');
    expect(events).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

describe('atomicity and idempotency', () => {
  it('a duplicate inbound webhook replay produces exactly one transition', async () => {
    await resumeConversationIfPending({} as never, { ...base, message: customerText() });
    const second = await resumeConversationIfPending({} as never, { ...base, message: customerText() });
    const third = await resumeConversationIfPending({} as never, { ...base, message: customerText() });
    expect([second.resumed, third.resumed]).toEqual([false, false]);
    expect(second.reason).toBe('not_pending');
    expect(events).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('two simultaneous customer messages yield one status event', async () => {
    const [a, b] = await Promise.all([
      resumeConversationIfPending({} as never, { ...base, message: customerText('one'), messageId: 'm1' }),
      resumeConversationIfPending({} as never, { ...base, message: customerText('two'), messageId: 'm2' }),
    ]);
    expect([a.resumed, b.resumed].filter(Boolean)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(rows.c1.status).toBe('open');
  });

  it('customer message on an already-open thread emits no status_changed', async () => {
    rows.c1.status = 'open';
    const r = await resumeConversationIfPending({} as never, { ...base, message: customerText() });
    expect(r).toEqual({ resumed: false, reason: 'not_pending' });
    expect(events).toHaveLength(0);
  });

  it('does not touch resolved or closed threads', async () => {
    for (const status of ['resolved', 'closed']) {
      rows.c1.status = status;
      const r = await resumeConversationIfPending({} as never, { ...base, message: customerText() });
      expect(r.resumed).toBe(false);
      expect(rows.c1.status).toBe(status);
    }
    expect(events).toHaveLength(0);
  });
});

describe('realtime + counters', () => {
  it('publishes a conversation_updated status patch so buckets move without refresh', async () => {
    await resumeConversationIfPending({} as never, { ...base, message: customerText(), messageId: 'm9' });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 'conversation_updated',
      conversation_id: 'c1',
      workspace_id: 'ws1',
      actor_id: null,
      reason: 'customer_replied',
      changes: { status: { from: 'pending', to: 'open' } },
    });
    expect(events[0].payload.message_id).toBe('m9');
  });
});

describe('shared eligibility guard', () => {
  it('reports a machine-readable rejection reason', () => {
    expect(isInboundCustomerMessageEligibleForResume({ senderType: 'agent', direction: 'outbound' }))
      .toEqual({ eligible: false, reason: 'not_inbound' });
    expect(isInboundCustomerMessageEligibleForResume({ senderType: 'ai', direction: 'inbound', text: 'x' }))
      .toEqual({ eligible: false, reason: 'sender_not_customer' });
    expect(isInboundCustomerMessageEligibleForResume({ senderType: 'contact', direction: 'inbound', text: 'x', isMenuEvent: true }))
      .toEqual({ eligible: false, reason: 'menu_navigation' });
    expect(isInboundCustomerMessageEligibleForResume({ senderType: 'contact', direction: 'inbound', text: 'hi' }))
      .toEqual({ eligible: true, reason: 'customer_replied' });
  });
});

// ── Part 2: ingest wiring ────────────────────────────────────────────────
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const inbound = read('server/services/channels/inboundProcessing.ts');
const widget = read('server/routes/widget.ts');
const waNorm = read('server/services/channels/whatsapp/toBotUpdate.ts');
const igNorm = read('server/services/channels/instagram/toBotUpdate.ts');
const ingestRoute = read('server/routes/internalChannels.ts');
const conversationsRoute = read('server/routes/conversations.ts');

describe('ingest wiring', () => {
  it('channels resume AFTER dedupe and AFTER message persistence', () => {
    const dedupe = inbound.indexOf("from('channel_inbound_events')");
    const insert = inbound.indexOf("sender_type: 'contact'");
    const resume = inbound.indexOf('await applyInboundConversationLifecycle');
    expect(dedupe).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(dedupe);
    expect(resume).toBeGreaterThan(insert);
  });

  it('channels pass the menu verdict into the guard', () => {
    expect(inbound).toContain('isMenuEvent: Boolean(menuCommand)');
  });

  it('widget resumes only after the visitor message row exists', () => {
    const insert = widget.indexOf("sender_type: 'contact'");
    const resume = widget.indexOf('await applyInboundConversationLifecycle');
    expect(resume).toBeGreaterThan(insert);
    // The guard gained a `!duplicate` clause — a replay must not resume the
    // conversation either — so it is matched on the two conditions that make
    // it correct rather than on the whole line.
    expect(widget).toMatch(/if \([^)]*\bconvId\b[^)]*insertedMsg\?\.id[^)]*\) \{/);
  });

  it('widget continuity performs no silent status change at all', () => {
    expect(widget).not.toContain("['closed', 'resolved', 'pending'].includes(conv.status)");
    expect(widget).not.toContain("if (['closed', 'resolved'].includes(conv.status))");
    expect(widget).not.toContain(".in('status', ['resolved', 'closed'])");
    // A closed one is left (never revived): the message goes to the visitor's
    // live conversation, else a new one (one current conversation per visitor).
    expect(widget).toMatch(/if \(conv\.status === 'closed'\) \{\s*convId = null;\s*namedUnusable = true;/);
  });

  it('WhatsApp statuses (sent/delivered/read/failed) never become messages', () => {
    expect(waNorm).toContain("const messages: any[] = Array.isArray(value?.messages) ? value.messages : [];");
    expect(waNorm).not.toContain('value?.statuses');
    // interactive/button replies are routed to the menu router, not chat content
    expect(waNorm).toContain('callback_query:');
  });

  it('Instagram echoes, reads, deliveries and reactions are dropped', () => {
    expect(igNorm).toContain('if (event?.message?.is_echo || event?.read || event?.delivery || event?.reaction) continue;');
  });

  it('callback queries are handled before canonical processing', () => {
    const cb = ingestRoute.indexOf('if (parsed.data.update?.callback_query)');
    const proc = ingestRoute.indexOf('await processInboundMessage');
    expect(cb).toBeGreaterThan(-1);
    expect(cb).toBeLessThan(proc);
    expect(ingestRoute).toContain("return res.json({ status: 'menu_handled' });");
  });

  it('manual status change carries a reason distinct from customer_replied', () => {
    expect(conversationsRoute).toContain("? 'manually_reopened'");
    expect(conversationsRoute).toContain("source: 'operator_status_change'");
  });
});
