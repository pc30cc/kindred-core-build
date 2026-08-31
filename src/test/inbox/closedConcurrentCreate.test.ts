import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Edge case: two genuinely DIFFERENT customer messages arriving concurrently
 * on a thread whose previous conversation is `closed`.
 *
 * Correct behaviour:
 *   • the closed conversation stays closed
 *   • exactly ONE new conversation is created (status `open`)
 *   • both messages land in that same new conversation
 *   • the loser of the race emits no duplicate `created` event
 *
 * Part 1 models `public.ensure_active_conversation` (migration 071): a
 * per-(workspace, identity) advisory lock serializing match-or-insert.
 * Part 2 pins the wiring so Widget and every channel actually use it.
 */

const root = (p: string) => resolve(process.cwd(), p);
const sql = readFileSync(root('database/migrations/071_atomic_inbound_conversation_getorcreate.sql'), 'utf8');
const inbound = readFileSync(root('server/services/channels/inboundProcessing.ts'), 'utf8');
const widget = readFileSync(root('server/routes/widget.ts'), 'utf8');

// ---------------------------------------------------------------- Part 1 ---

type Conv = { id: string; status: string; threadKey?: string | null; sessionId?: string | null; contactId?: string | null };

let convs: Conv[] = [];
let seq = 0;
/** One promise chain per lock key — the advisory lock. */
const locks = new Map<string, Promise<unknown>>();
let createdEvents: string[] = [];

/** Faithful model of ensure_active_conversation(). */
async function ensureActiveConversation(args: {
  workspaceId: string;
  lockKey: string;
  threadKey?: string | null;
  sessionId?: string | null;
  contactId?: string | null;
  /** simulated scheduling delay between the match and the insert */
  gap?: number;
}): Promise<{ id: string; created: boolean; matched_by: string }> {
  const key = `${args.workspaceId}|${args.lockKey}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const reusable = (c: Conv) => ['open', 'pending', 'resolved'].includes(c.status);
    let hit =
      (args.threadKey && convs.find((c) => reusable(c) && c.threadKey === args.threadKey)) ||
      (args.sessionId && convs.find((c) => reusable(c) && c.sessionId === args.sessionId)) ||
      (args.contactId && convs.find((c) => reusable(c) && c.contactId === args.contactId)) ||
      null;
    if (hit) return { id: hit.id, created: false, matched_by: 'match' };
    if (args.gap) await new Promise((r) => setTimeout(r, args.gap));
    const row: Conv = {
      id: `conv_${++seq}`,
      status: 'open',
      threadKey: args.threadKey ?? null,
      sessionId: args.sessionId ?? null,
      contactId: args.contactId ?? null,
    };
    convs.push(row);
    createdEvents.push(row.id);
    return { id: row.id, created: true, matched_by: 'created' };
  });
  locks.set(key, run.catch(() => undefined));
  return run;
}

describe('closed + concurrent distinct customer messages', () => {
  beforeEach(() => {
    convs = [];
    seq = 0;
    createdEvents = [];
    locks.clear();
  });

  it('Telegram: two distinct concurrent messages → one new conversation', async () => {
    convs.push({ id: 'old', status: 'closed', threadKey: 'telegram:int1:chat9' });

    const [a, b] = await Promise.all([
      ensureActiveConversation({ workspaceId: 'w1', lockKey: 'telegram:int1:chat9', threadKey: 'telegram:int1:chat9', gap: 5 }),
      ensureActiveConversation({ workspaceId: 'w1', lockKey: 'telegram:int1:chat9', threadKey: 'telegram:int1:chat9' }),
    ]);

    expect(a.id).toBe(b.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(createdEvents).toHaveLength(1);
    expect(convs.filter((c) => c.status === 'open')).toHaveLength(1);
    expect(convs.find((c) => c.id === 'old')!.status).toBe('closed');
  });

  it('WhatsApp: two distinct concurrent messages → one new conversation', async () => {
    convs.push({ id: 'old', status: 'closed', threadKey: 'whatsapp:int2:+9891' });

    const results = await Promise.all(
      [0, 1, 2].map((i) =>
        ensureActiveConversation({ workspaceId: 'w1', lockKey: 'whatsapp:int2:+9891', threadKey: 'whatsapp:int2:+9891', gap: i === 0 ? 5 : 0 }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(createdEvents).toHaveLength(1);
  });

  it('Widget: two distinct concurrent messages from one visitor → one new conversation', async () => {
    convs.push({ id: 'old', status: 'closed', sessionId: 'sess1', contactId: 'c1' });

    const [a, b] = await Promise.all([
      ensureActiveConversation({ workspaceId: 'w1', lockKey: 'sess1', sessionId: 'sess1', contactId: 'c1', gap: 5 }),
      ensureActiveConversation({ workspaceId: 'w1', lockKey: 'sess1', sessionId: 'sess1', contactId: 'c1' }),
    ]);

    expect(a.id).toBe(b.id);
    expect(createdEvents).toHaveLength(1);
    expect(convs.find((c) => c.id === 'old')!.status).toBe('closed');
  });

  it('the loser attaches its message to the winner (no loss, no orphan, no closed reuse)', async () => {
    convs.push({ id: 'old', status: 'closed', threadKey: 'bale:int3:chat1' });
    const messages: Array<{ text: string; convId: string }> = [];
    const deliver = async (text: string, gap: number) => {
      const r = await ensureActiveConversation({ workspaceId: 'w1', lockKey: 'bale:int3:chat1', threadKey: 'bale:int3:chat1', gap });
      messages.push({ text, convId: r.id });
    };
    await Promise.all([deliver('A', 5), deliver('B', 0)]);

    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((m) => m.convId)).size).toBe(1);
    expect(messages[0].convId).not.toBe('old');
  });

  it('new conversation is created with status open and never matches closed', async () => {
    convs.push({ id: 'old', status: 'closed', threadKey: 'instagram:int4:u1' });
    const r = await ensureActiveConversation({ workspaceId: 'w1', lockKey: 'instagram:int4:u1', threadKey: 'instagram:int4:u1' });
    expect(r.created).toBe(true);
    expect(convs.find((c) => c.id === r.id)!.status).toBe('open');
  });

  it('an active (open/pending/resolved) thread is still reused — no new conversation', async () => {
    convs.push({ id: 'live', status: 'resolved', threadKey: 'telegram:int1:chat9' });
    const r = await ensureActiveConversation({ workspaceId: 'w1', lockKey: 'telegram:int1:chat9', threadKey: 'telegram:int1:chat9' });
    expect(r.id).toBe('live');
    expect(createdEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Part 2 ---

describe('migration 071 contract', () => {
  it('locks per (workspace, identity) before matching', () => {
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/p_workspace_id::text \|\| '\|' \|\| COALESCE\(p_lock_key/);
  });

  it('never matches closed conversations and always inserts status open', () => {
    const matches = sql.match(/status IN \('open', 'pending', 'resolved'\)/g) || [];
    expect(matches.length).toBe(3); // thread key, session, contact
    expect(sql).not.toMatch(/'closed'/);
    expect(sql).toMatch(/VALUES \(\s*p_workspace_id, p_contact_id, 'open'/);
  });

  it('is service-role only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.ensure_active_conversation[\s\S]*FROM anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.ensure_active_conversation[\s\S]*TO service_role/);
  });
});

describe('runtime wiring', () => {
  it('channels ingest uses the atomic RPC, not a raw insert', () => {
    expect(inbound).toMatch(/rpc\('ensure_active_conversation'/);
    expect(inbound).toMatch(/p_lock_key: threadKey/);
    expect(inbound).not.toMatch(/from\('conversations'\)\s*\.insert\(/);
  });

  it('widget create branch uses the atomic RPC and only the winner emits created', () => {
    expect(widget).toMatch(/rpc\('ensure_active_conversation'/);
    expect(widget).toMatch(/const lockKey = body\.session_id \|\| body\.visitor_id/);
    expect(widget).toMatch(/if \(createdNewConversation\) \{/);
    expect(widget).not.toMatch(/from\('conversations'\)\.insert\(/);
  });
});
