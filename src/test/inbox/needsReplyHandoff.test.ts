/**
 * The AI's hand-over line is not an answer (R-16).
 *
 * When the AI hands a conversation to a person it writes "I'll connect you
 * with a colleague" (responder.ts, sender `ai`, `metadata.handoff`). That
 * line used to count as the reply, so exactly the conversations waiting for a
 * person lost their "Needs reply" badge and their waiting time in the Inbox.
 * It is transparent now: the visitor still waits, since their own message.
 */
import { describe, expect, it } from 'vitest';
import {
  computeNeedsReply,
  computeWaitingSince,
  isQualifiedCustomerFacingAnswer,
  type NeedsReplyMessage,
} from '../../../server/services/needsReply';

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 10, n)).toISOString();
const customer = (n: number): NeedsReplyMessage => ({ sender_type: 'contact', body: 'سفارشم کجاست؟', created_at: at(n) });
const ai = (n: number): NeedsReplyMessage => ({ sender_type: 'ai', body: 'سفارش شما در راه است.', created_at: at(n), metadata: { source: 'ai_agent' } });
const handoff = (n: number, value: unknown = true): NeedsReplyMessage => ({
  sender_type: 'ai', body: 'شما را به یکی از همکارانمان وصل می‌کنم.', created_at: at(n), metadata: { handoff: value, source: 'ai_agent' },
});
const agent = (n: number, metadata: Record<string, unknown> = {}): NeedsReplyMessage => ({ sender_type: 'agent', body: 'سلام، در خدمتم', created_at: at(n), metadata });

describe('the AI handing over to a person', () => {
  it('answers nothing: the visitor still waits, since their own message', () => {
    expect(isQualifiedCustomerFacingAnswer(handoff(1))).toBe(false);
    expect(isQualifiedCustomerFacingAnswer(handoff(1, 'true'))).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), handoff(1)] })).toBe(true);
    expect(computeWaitingSince({ status: 'open', messages: [customer(0), handoff(1)] })).toBe(at(0));
  });

  it('an earlier AI answer still counts: the wait starts with the turn after it', () => {
    expect(computeWaitingSince({ status: 'open', messages: [customer(0), ai(1), customer(2), handoff(3)] })).toBe(at(2));
  });

  it('the person who answers after it closes the cycle', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), handoff(1), agent(2)] })).toBe(false);
  });

  it('only the AI\'s own hand-over line: an AI reply without the flag, or an operator\'s message carrying it, is an answer', () => {
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), handoff(1, false)] })).toBe(false);
    expect(computeNeedsReply({ status: 'open', messages: [customer(0), agent(1, { handoff: true })] })).toBe(false);
  });
});
