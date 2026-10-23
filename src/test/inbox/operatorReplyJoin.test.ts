// @vitest-environment node
/**
 * When an operator's reply owes the visitor "X joined" first (owner,
 * 2026-10-23: when a chat goes from the AI to an operator, the thread first
 * says who joined, then what they wrote), and the per-conversation lock that
 * keeps two messages sent at once from writing two lines.
 *
 * The stretch runs from the newest AI message to now; an operator is
 * introduced in it by their own message, or by a visitor-visible join or
 * transfer naming them (rows written before this release). A thread the
 * visitor has not written in yet (Visitors → Start chat) owes nothing.
 * The route's side, on a real database: chatLifecycle278b.pg.test.ts B5.
 */
import { describe, expect, it } from 'vitest';
import { JOIN_WINDOW, joinOwed, lockConversationReplies, type JoinWindowRow } from '../../../server/services/operatorReplyJoin';

const ALI = 'ali';
const BAHAR = 'bahar';

let clock = Date.parse('2026-10-23T09:00:00.000Z');
const at = () => new Date((clock += 1000)).toISOString();
const contact = (): JoinWindowRow => ({ id: `c-${clock}`, sender_type: 'contact', created_at: at() });
const ai = (): JoinWindowRow => ({ id: `ai-${clock}`, sender_type: 'ai', created_at: at() });
const bot = (): JoinWindowRow => ({ id: `bot-${clock}`, sender_type: 'bot', created_at: at() });
const agent = (who: string): JoinWindowRow => ({ id: `a-${clock}`, sender_type: 'agent', sender_id: who, created_at: at() });
const system = (metadata: Record<string, unknown>): JoinWindowRow => ({ id: `s-${clock}`, sender_type: 'system', created_at: at(), metadata });

/** Oldest first, as a thread reads; joinOwed is given them in any order. */
const owed = (rows: JoinWindowRow[], who = ALI, windowFull = false) => joinOwed(rows, who, windowFull);

describe('joinOwed', () => {
  it('owed after the AI to an operator who has not written', () => {
    expect(owed([contact(), ai(), contact()])).toBe(true);
    // The AI handed over and said so; the visitor did not write again.
    expect(owed([contact(), ai()])).toBe(true);
  });

  it('not owed when the operator already wrote after the newest AI message', () => {
    expect(owed([contact(), ai(), contact(), agent(ALI), contact()])).toBe(false);
  });

  it('owed again after a later AI message', () => {
    expect(owed([contact(), ai(), agent(ALI), contact(), ai(), contact()])).toBe(true);
  });

  it('a smart rule\'s opening (`bot`) does not end the stretch', () => {
    expect(owed([contact(), ai(), agent(ALI), bot(), contact()])).toBe(false);
  });

  it('a visitor-visible join or transfer naming the operator in the stretch counts as introduced', () => {
    expect(owed([contact(), ai(), system({ kind: 'routing_agent_joined', agent_id: ALI, agent_name: 'Ali' }), contact()])).toBe(false);
    expect(owed([contact(), ai(), system({ kind: 'conversation_transferred', to_id: ALI, to_name: 'Ali', internal: false }), contact()])).toBe(false);
    // Before the newest AI message they do not.
    expect(owed([contact(), system({ kind: 'routing_agent_joined', agent_id: ALI }), ai(), contact()])).toBe(true);
  });

  it('the same rows marked internal do not', () => {
    expect(owed([contact(), ai(), system({ kind: 'routing_agent_joined', agent_id: ALI, internal: true }), contact()])).toBe(true);
    expect(owed([contact(), ai(), system({ kind: 'conversation_transferred', to_id: ALI, internal: true }), contact()])).toBe(true);
  });

  it('another operator\'s message, join or transfer does not introduce this one', () => {
    expect(owed([contact(), ai(), agent(BAHAR), contact()])).toBe(true);
    expect(owed([contact(), ai(), system({ kind: 'routing_agent_joined', agent_id: BAHAR }), contact()])).toBe(true);
    expect(owed([contact(), ai(), system({ kind: 'conversation_transferred', to_id: BAHAR }), contact()])).toBe(true);
    // A, then B, then A again in the same stretch: A owes no second line.
    expect(owed([contact(), ai(), agent(ALI), agent(BAHAR), contact()])).toBe(false);
  });

  it('a thread the visitor has not written in (outreach) owes nothing, unless the window may not reach back that far', () => {
    expect(owed([])).toBe(false);
    expect(owed([agent(BAHAR)])).toBe(false);
    expect(owed([system({ kind: 'routing_in_queue' })])).toBe(false);
    expect(owed([system({ kind: 'routing_in_queue' })], ALI, true)).toBe(true);
  });

  it('with no AI message at all, the first human answer is introduced too', () => {
    expect(owed([contact()])).toBe(true);
    expect(owed([contact(), agent(ALI), contact()])).toBe(false);
  });

  it('reads the rows in any order (it sorts them, newest first)', () => {
    const thread = [contact(), ai(), agent(ALI), contact(), ai(), contact()];
    expect(owed(thread.slice().reverse())).toBe(true);
    expect(owed([thread[3], thread[0], thread[5], thread[2], thread[4], thread[1]])).toBe(true);
    const answered = [contact(), ai(), contact(), agent(ALI)];
    expect(owed([answered[3], answered[1], answered[0], answered[2]])).toBe(false);
  });

  it('keeps the database\'s microseconds: an AI message a few microseconds after the operator\'s ends the stretch', () => {
    const rows: JoinWindowRow[] = [
      { id: 'z', sender_type: 'contact', created_at: '2026-10-23T09:00:00.000100+00:00' },
      { id: 'y', sender_type: 'agent', sender_id: ALI, created_at: '2026-10-23T09:00:01.000100+00:00' },
      { id: 'x', sender_type: 'ai', created_at: '2026-10-23T09:00:01.000900+00:00' },
    ];
    expect(owed(rows)).toBe(true);
    expect(owed(rows.slice(0, 2))).toBe(false);
  });

  it('reads at most JOIN_WINDOW rows', () => {
    expect(JOIN_WINDOW).toBe(200);
  });
});

describe('lockConversationReplies', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('two holders of the same conversation run in turn, first come first served', async () => {
    const order: string[] = [];
    const first = await lockConversationReplies('c1');
    const second = lockConversationReplies('c1').then((release) => { order.push('second'); return release; });
    const third = lockConversationReplies('c1').then((release) => { order.push('third'); return release; });
    await tick();
    expect(order).toEqual([]);
    // Another conversation is not held up.
    (await lockConversationReplies('c2'))();
    order.push('first done');
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(['first done', 'second', 'third']);
    // Released twice: harmless.
    first();
  });

  it('the wait cap lets the next one through when a holder stalls', async () => {
    const stalled = await lockConversationReplies('c3');
    const started = Date.now();
    const next = await lockConversationReplies('c3', 40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    // And the one after it waits for that one, not for the stalled holder.
    let through = false;
    const after = lockConversationReplies('c3', 5000).then((release) => { through = true; return release; });
    await tick();
    expect(through).toBe(false);
    next();
    (await after)();
    expect(through).toBe(true);
    stalled();
  });

  it('a released conversation leaves nothing behind: the next holder goes straight in', async () => {
    (await lockConversationReplies('c4'))();
    const started = Date.now();
    (await lockConversationReplies('c4', 1000))();
    expect(Date.now() - started).toBeLessThan(50);
  });
});
