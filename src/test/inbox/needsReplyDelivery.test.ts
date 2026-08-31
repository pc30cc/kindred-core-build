/**
 * NEEDS REPLY × OUTBOUND DELIVERY — the obligation is only satisfied by an
 * answer the customer was ACTUALLY sent through a valid delivery path.
 *
 * Real runtime contract (traced, not guessed):
 *   • Core enqueues a `*_outbound_message|media` channel job; the message row
 *     starts with NO `channel_delivery` key (in flight).
 *   • The Channels Worker retries with backoff; attempts land in
 *     `channel_delivery_attempts` and never touch conversation_messages.
 *   • Core is told the outcome ONLY via POST /internal/channels/outbound-result
 *     and writes `metadata.channel_delivery = 'sent' | 'failed'`.
 *   • Terminal failure = non-retryable provider error OR retry exhaustion.
 *   • Widget has no provider hop: DB commit + realtime IS the success boundary.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeNeedsReply,
  computeWaitingSince,
  isQualifiedCustomerFacingAnswer,
  isPermanentlyUndelivered,
} from '../../../server/services/needsReply';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString();
const customer = (n: number, body = 'سلام') => ({ sender_type: 'contact', body, created_at: at(n) });
const agent = (n: number, metadata: any = {}, body = 'پاسخ') => ({ sender_type: 'agent', body, created_at: at(n), metadata });
const ai = (n: number, metadata: any = {}) => ({ sender_type: 'ai', body: 'AI answer', created_at: at(n), metadata });
const sent = { channel_delivery: 'sent', channel_delivery_at: at(6) };
const failed = { channel_delivery: 'failed', channel_delivery_error: 'telegram_403' };

describe('delivery states — only terminal failure invalidates an answer', () => {
  it('an accepted/queued reply (no delivery key yet) satisfies the obligation', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5)] })).toBe(false);
  });

  it('transient states never flip Needs Reply back on', () => {
    for (const state of ['queued', 'pending', 'retrying', 'temporarily_unavailable', 'sending']) {
      const m = agent(5, { channel_delivery: state });
      expect(isPermanentlyUndelivered(m as any)).toBe(false);
      expect(computeNeedsReply({ status: 'open', messages: [customer(0), m] })).toBe(false);
    }
  });

  it("'sent' satisfies the obligation", () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5, sent)] })).toBe(false);
  });

  it('late PERMANENT failure restores the obligation', () => {
    const msgs = [customer(0), agent(5)];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
    // …worker exhausts retries, Core writes channel_delivery = 'failed'
    const after = [customer(0), agent(5, failed)];
    expect(computeNeedsReply({ status: 'open', messages: after })).toBe(true);
  });

  it('a routing-skipped message is not an answer either', () => {
    const skipped = agent(5, { channel_delivery_skip: 'true', telegram_offline_screen_queued: true });
    expect(isQualifiedCustomerFacingAnswer(skipped as any)).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), skipped] })).toBe(true);
  });
});

describe('a failure only restores what is actually unanswered', () => {
  it('C1 → A1 delivered, A2 later fails → still answered', () => {
    const msgs = [customer(0), agent(5, sent), agent(9, failed)];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
  });

  it('C1 → A1 fails, A2 succeeds → answered', () => {
    const msgs = [customer(0), agent(5, failed), agent(9, sent)];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
  });

  it('C1 → A1 fails → new customer message → exactly one current obligation', () => {
    const msgs = [customer(0, 'C1'), agent(5, failed), customer(9, 'C2')];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(true);
    // The wait is measured from C1: nothing in between ever reached the customer.
    expect(computeWaitingSince({ status: 'open', messages: msgs })).toBe(at(0));
  });

  it('AI answer delivered → satisfied; AI answer permanently failed → owed', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), ai(4, sent)] })).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), ai(4, failed)] })).toBe(true);
  });

  it('sender_type alone never satisfies the obligation', () => {
    expect(isQualifiedCustomerFacingAnswer(agent(5, failed) as any)).toBe(false);
    expect(isQualifiedCustomerFacingAnswer(ai(5, failed) as any)).toBe(false);
  });

  it('widget success boundary: committed row with no provider hop counts', () => {
    // Widget messages carry no channel_delivery metadata at all.
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5, {})] })).toBe(false);
  });

  it('a duplicate failure report cannot change the derived result twice', () => {
    const once = [customer(0), agent(5, failed)];
    const twice = [customer(0), agent(5, { ...failed, channel_delivery_at: at(20) })];
    expect(computeNeedsReply({ status: 'open', messages: once })).toBe(
      computeNeedsReply({ status: 'open', messages: twice }),
    );
  });
});

describe('waiting age — ranking input', () => {
  it('waiting_since is the FIRST unanswered customer turn, not the newest', () => {
    const msgs = [customer(0, 'C1'), customer(3, 'C2'), customer(7, 'C3')];
    expect(computeWaitingSince({ status: 'open', messages: msgs })).toBe(at(0));
  });

  it('a delivered answer resets the wait', () => {
    const msgs = [customer(0), agent(5, sent), customer(30)];
    expect(computeWaitingSince({ status: 'open', messages: msgs })).toBe(at(30));
  });

  it('null when nothing is owed', () => {
    expect(computeWaitingSince({ status: 'open', messages: [customer(0), agent(5, sent)] })).toBeNull();
    expect(computeWaitingSince({ status: 'pending', messages: [customer(0)] })).toBeNull();
  });

  it('sorting by waiting age puts the longest-waiting customer first', () => {
    const rows = [
      { id: 'young', needs_reply: true, waiting_since: at(50), updated_at: at(59) },
      { id: 'old', needs_reply: true, waiting_since: at(1), updated_at: at(2) },
      { id: 'answered', needs_reply: false, waiting_since: null, updated_at: at(58) },
    ];
    const sorted = [...rows].sort((a: any, b: any) => {
      const na = a.needs_reply ? 1 : 0;
      const nb = b.needs_reply ? 1 : 0;
      if (na !== nb) return nb - na;
      if (na === 1 && nb === 1) {
        const wa = a.waiting_since ?? '';
        const wb = b.waiting_since ?? '';
        if (wa && wb && wa !== wb) return wa < wb ? -1 : 1;
      }
      return 0;
    });
    expect(sorted.map((r) => r.id)).toEqual(['old', 'young', 'answered']);
  });

  it('unread stays independent of the delivery transition', () => {
    const seenCustomer = { ...customer(0), seen_at: at(1) };
    const unread = (msgs: any[]) => msgs.filter((m) => m.sender_type === 'contact' && !m.seen_at).length;
    const before = [seenCustomer, agent(5)];
    const after = [seenCustomer, agent(5, failed)];
    expect(unread(before)).toBe(0);
    expect(unread(after)).toBe(0); // failure does not create unread
    expect(computeNeedsReply({ status: 'open', messages: before })).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: after })).toBe(true);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('runtime wiring — retry exhaustion and realtime', () => {
  const worker = read('worker/channels/index.ts');
  const core = read('server/routes/internalChannels.ts');
  const listHook = read('src/hooks/useInboxListRealtime.ts');

  it('the worker reports retry exhaustion of outbound message jobs to Core', () => {
    expect(worker).toMatch(/outcome === 'failed' && isOutboundMessageJob\(job\.job_type\)/);
    expect(worker).toContain('retries_exhausted');
  });

  it('the worker still never writes canonical message rows itself', () => {
    expect(worker).not.toMatch(/from\('conversation_messages'\)/);
  });

  it('Core dedupes a repeated terminal failure report', () => {
    expect(core).toMatch(/previousOutcome === data\.outcome && data\.outcome === 'failed'/);
  });

  it("Core never downgrades an already 'sent' delivery", () => {
    expect(core).toMatch(/previousOutcome === 'sent' && data\.outcome === 'failed'/);
  });

  it('Core publishes a realtime event on permanent failure', () => {
    expect(core).toContain("reason: 'outbound_delivery_failed'");
    expect(core).toContain('publishOperatorEvent');
  });

  it('the Inbox invalidates (not patches) on that reason, so the badge returns without refresh', () => {
    expect(listHook).toContain("=== 'outbound_delivery_failed'");
    expect(listHook).toMatch(/outbound_delivery_failed[\s\S]{0,400}invalidateQueries/);
  });

  it('no denormalized needs_reply column was introduced', () => {
    const migrations = fs.readdirSync(path.join(process.cwd(), 'supabase/migrations'));
    for (const f of migrations) {
      const sql = read(`supabase/migrations/${f}`);
      expect(sql).not.toMatch(/needs_reply/i);
    }
  });
});
