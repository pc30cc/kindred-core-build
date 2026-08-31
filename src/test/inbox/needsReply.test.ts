/**
 * NEEDS REPLY semantics — "who is waiting for whom".
 *
 * Needs Reply is derived (never stored) from the message stream and is a
 * THIRD axis, independent of `status` and of `unread`:
 *   • open + last turn = customer            → needs reply
 *   • open + last customer-facing answer     → NOT needs reply (status stays open)
 *   • pending / resolved / closed            → never needs reply
 *   • marking messages seen (unread → 0)     → does NOT answer anything
 *
 * The actionable-customer-turn guard is the SAME one the pending/resolved
 * resume lifecycle uses, so receipts, menu taps, echoes, system rows and empty
 * events can never open or close a reply cycle.
 */
import { describe, it, expect } from 'vitest';
import {
  computeNeedsReply,
  isActionableCustomerTurn,
  isQualifiedReply,
} from '../../../server/services/needsReply';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString();
const customer = (n: number, body = 'قیمت چنده؟') => ({ sender_type: 'contact', body, created_at: at(n) });
const agent = (n: number, body = '۱۰۰ هزار تومان', metadata: any = {}) => ({ sender_type: 'agent', body, created_at: at(n), metadata });
const ai = (n: number, body = 'AI answer') => ({ sender_type: 'ai', body, created_at: at(n) });
const system = (n: number) => ({ sender_type: 'system', body: 'Agent joined the conversation.', created_at: at(n), metadata: { kind: 'routing_agent_joined' } });
const menuTap = (n: number) => ({ sender_type: 'contact', body: '/start', created_at: at(n), metadata: { channel_menu_event: 'true' } });
const echo = (n: number) => ({ sender_type: 'contact', body: 'echo', created_at: at(n), metadata: { provider_echo: true } });

describe('needs reply — core matrix', () => {
  it('open + last turn is the customer → needs reply', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0)] })).toBe(true);
  });

  it('open + agent answered → NOT needs reply even though status is still open', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5)] })).toBe(false);
  });

  it('status open alone is never treated as needs reply', () => {
    expect(computeNeedsReply({ status: 'open', messages: [] })).toBe(false);
  });

  it('pending means the business waits for the customer → false', () => {
    expect(computeNeedsReply({ status: 'pending', messages: [customer(0), agent(5)] })).toBe(false);
  });

  it('resolved and closed are never needs reply', () => {
    expect(computeNeedsReply({ status: 'resolved', messages: [customer(0)] })).toBe(false);
    expect(computeNeedsReply({ status: 'closed', messages: [customer(0)] })).toBe(false);
  });

  it('pending → open after a customer reply becomes needs reply', () => {
    // The lifecycle flips the status first; the derivation then sees the new turn.
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5), customer(60)] })).toBe(true);
  });

  it('resolved → open after a customer reply becomes needs reply', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5), customer(120)] })).toBe(true);
  });
});

describe('needs reply — what closes and what does not close the cycle', () => {
  it('AI reply is a real customer-facing answer and closes the cycle', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), ai(2)] })).toBe(false);
  });

  it('system/routing messages never close the cycle', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), system(1)] })).toBe(true);
    expect(isQualifiedReply(system(1) as any)).toBe(false);
  });

  it('a bot menu response is not an answer', () => {
    const bot = { sender_type: 'bot', body: 'menu', created_at: at(1) };
    expect(isQualifiedReply(bot as any)).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), bot] })).toBe(true);
  });

  it('an empty agent row is not an answer', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(3, '   ')] })).toBe(true);
  });

  it('an agent message rejected by the transport does NOT close the cycle', () => {
    const failed = agent(3, 'reply', { channel_delivery: 'failed', channel_delivery_error: 'bot_blocked' });
    expect(isQualifiedReply(failed as any)).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), failed] })).toBe(true);
  });

  it('a delivered agent message closes the cycle', () => {
    const sent = agent(3, 'reply', { channel_delivery: 'sent' });
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), sent] })).toBe(false);
  });

  it('an agent attachment with no text still counts as an answer', () => {
    const withFile = { sender_type: 'agent', body: '', created_at: at(4), metadata: { attachment_id: 'a1' } };
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), withFile] })).toBe(false);
  });
});

describe('needs reply — actionable customer turn guard', () => {
  it('menu navigation is not a customer turn', () => {
    expect(isActionableCustomerTurn(menuTap(1) as any)).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(2), menuTap(9)] })).toBe(false);
  });

  it('a provider echo is not a customer turn', () => {
    expect(isActionableCustomerTurn(echo(9) as any)).toBe(false);
  });

  it('an empty customer event is not a customer turn', () => {
    expect(isActionableCustomerTurn({ sender_type: 'contact', body: '  ', created_at: at(1) } as any)).toBe(false);
  });

  it('a customer attachment with no text IS a customer turn', () => {
    const media = { sender_type: 'contact', body: '', created_at: at(1), attachment_count: 1 };
    expect(isActionableCustomerTurn(media as any)).toBe(true);
    expect(computeNeedsReply({ status: 'open', messages: [agent(0), media] })).toBe(true);
  });

  it('two customer messages before a reply are ONE waiting obligation', () => {
    const msgs = [customer(0, 'A'), customer(2, 'B')];
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(true);
    // the agent reply closes both at once
    expect(computeNeedsReply({ status: 'open', messages: [...msgs, agent(5)] })).toBe(false);
  });

  it('a duplicate inbound row does not change the obligation', () => {
    const dup = [customer(0, 'A'), customer(0, 'A'), agent(5)];
    expect(computeNeedsReply({ status: 'open', messages: dup })).toBe(false);
  });

  it('a duplicate outbound retry does not re-open the obligation', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(5), agent(5)] })).toBe(false);
  });

  it('message order in the input array does not matter', () => {
    expect(computeNeedsReply({ status: 'open', messages: [agent(5), customer(0)] })).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(9), agent(5), customer(0)] })).toBe(true);
  });

  it('durations/ordering use canonical UTC timestamps, not local clocks', () => {
    const utc = { sender_type: 'contact', body: 'late', created_at: '2026-01-01T23:30:00.000Z' };
    const earlierLocalLooking = { sender_type: 'agent', body: 'earlier', created_at: '2026-01-01T21:00:00.000Z' };
    expect(computeNeedsReply({ status: 'open', messages: [earlierLocalLooking, utc] })).toBe(true);
  });
});

describe('needs reply — independence from unread', () => {
  const unreadOf = (msgs: any[]) =>
    msgs.filter((m) => m.sender_type === 'contact' && !m.seen_at && !(m.metadata?.channel_menu_event)).length;

  it('a new customer message is both unread and needs reply', () => {
    const msgs = [{ ...customer(0), seen_at: null }];
    expect(unreadOf(msgs)).toBe(1);
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(true);
  });

  it('marking read clears unread but NOT needs reply', () => {
    const msgs = [{ ...customer(0), seen_at: at(1) }];
    expect(unreadOf(msgs)).toBe(0);
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(true);
  });

  it('answering clears needs reply while unread may already be 0', () => {
    const msgs = [{ ...customer(0), seen_at: at(1) }, agent(5)];
    expect(unreadOf(msgs)).toBe(0);
    expect(computeNeedsReply({ status: 'open', messages: msgs })).toBe(false);
  });
});

describe('needs reply — existing data regression fixtures', () => {
  const fixtures = [
    { name: 'open + last customer', status: 'open', messages: [agent(0), customer(9)], expected: true },
    { name: 'open + last agent', status: 'open', messages: [customer(0), agent(9)], expected: false },
    { name: 'pending', status: 'pending', messages: [customer(0), agent(9)], expected: false },
    { name: 'resolved', status: 'resolved', messages: [customer(0), agent(9)], expected: false },
    { name: 'closed', status: 'closed', messages: [customer(0)], expected: false },
    { name: 'legacy thread with no messages', status: 'open', messages: [], expected: false },
  ];
  for (const f of fixtures) {
    it(`${f.name} → needs_reply=${f.expected}`, () => {
      expect(computeNeedsReply({ status: f.status, messages: f.messages as any })).toBe(f.expected);
    });
  }
});
