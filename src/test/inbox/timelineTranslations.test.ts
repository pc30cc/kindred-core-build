/**
 * The inbox Activity timeline: every event type, reason, channel, method,
 * source and availability value the server writes to conversation_events
 * (inventory of server/services/conversationEvents.ts writers) reads as
 * translated text in English, Persian and Turkish — never a raw code such
 * as "operator_cancelled" or "visitor_id", and never a key.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { describeEvent } from '@/components/inbox/timelineMeta';
import type { TimelineEvent } from '@/hooks/useConversationTimeline';

/** The app's lookup: nested sections, with flat dotted keys inside a section. */
function translator(messages: Record<string, unknown>) {
  return (path: string): string => {
    const keys = path.split('.');
    let current: unknown = messages;
    for (let i = 0; i < keys.length; i += 1) {
      if (!current || typeof current !== 'object') return path;
      const obj = current as Record<string, unknown>;
      let matched = false;
      for (let j = keys.length; j > i; j -= 1) {
        const candidate = keys.slice(i, j).join('.');
        if (Object.prototype.hasOwnProperty.call(obj, candidate)) {
          current = obj[candidate];
          i = j - 1;
          matched = true;
          break;
        }
      }
      if (!matched) return path;
    }
    return typeof current === 'string' ? current : path;
  };
}

function event(event_type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  return { id: event_type, event_type, payload, created_at: '2026-10-16T00:00:00Z', actor_type: 'system' } as unknown as TimelineEvent;
}

const ASSIGNED_METHODS = ['auto', 'round_robin', 'last_agent', 'owner_fallback', 'timeout_reassign', 'take_over', 'manual', 'first_reply'];
const UNASSIGNED_METHODS = [
  'manual', 'timeout_release', 'transfer_department', 'reopen_release', 'assignee_unavailable',
  'member_removed', 'member_suspended', 'member_role_changed',
];

const EVENTS: TimelineEvent[] = [
  event('created', { source: 'widget' }),
  ...['telegram', 'bale', 'whatsapp', 'instagram', 'x', 'platform_support'].map((source) => event('created', { source })),
  event('conversation_started', { source: 'visitor_outreach' }),
  ...['email', 'phone', 'visitor_id', 'prechat', 'token'].map((method) => event('identified', { method })),
  event('assigned', { method: 'manual_claim' }),
  // Chat routing's and the Inbox's ways of giving a conversation and taking
  // it away (server/services/chatRouting.ts, conversationAssignment.ts).
  ...ASSIGNED_METHODS.map((method) => event('assigned', { method })),
  event('assigned', { method: 'manual', source: 'transfer' }),
  event('assigned', { method: 'manual', source: 'visitor_outreach' }),
  event('unassigned'),
  ...UNASSIGNED_METHODS.map((method) => event('unassigned', { method })),
  event('status_changed', { from: 'pending', to: 'open', reason: 'customer_replied' }),
  event('status_changed', { from: 'open', to: 'pending', reason: 'manual_status_change' }),
  event('status_changed', { to: 'pending', reason: 'waiting_for_customer' }),
  event('resolved', { to: 'resolved', reason: 'resolved_after_reply' }),
  event('resolved', { from: 'open', to: 'closed', reason: 'manual_status_change' }),
  // The inactivity close (migration 284): from open or pending as PATCH
  // files it, from resolved as a status change; its race reopen.
  event('resolved', { from: 'open', to: 'closed', reason: 'inactivity', source: 'inactivity_timer', idle_hours: 24 }),
  event('resolved', { from: 'pending', to: 'closed', reason: 'inactivity', source: 'inactivity_backlog', idle_hours: 48 }),
  event('status_changed', { from: 'resolved', to: 'closed', reason: 'inactivity', source: 'inactivity_timer', idle_hours: 24 }),
  event('status_changed', { from: 'resolved', to: 'closed', reason: 'manual_status_change' }),
  event('resolved', { from: 'open', to: 'closed', reason: 'inactivity' }),
  event('reopened', { from: 'closed', to: 'open', reason: 'customer_replied_after_inactivity_close', message_id: 'm' }),
  event('reopened', { from: 'resolved', to: 'open', reason: 'manually_reopened' }),
  event('reopened', { from: 'resolved', to: 'open', reason: 'customer_replied_after_resolution' }),
  event('reopened', { from: 'resolved', to: 'open', reason: 'manual_reopen_by_visitor' }),
  event('priority_changed', { from: 'low', to: 'urgent' }),
  event('department_assigned', { department_name: 'Sales', source: 'auto' }),
  event('escalation_requested', { source: 'widget_button' }),
  ...['within_hours', 'outside_hours', 'override_closed', 'always_offline', 'no_operators_online', 'disabled']
    .map((availability_reason) => event('captured_offline', { availability_reason })),
  event('rated', { score: 4 }),
  event('rated', { score: 5, comment: 'خیلی خوب بود', closed_id: 'c', operator_id: 'o', source: 'widget' }),
  event('rated', { score: 4, closed_id: 'c', operator_id: null, subject: 'ai', source: 'widget' }),
  event('transcript_emailed', { status: 'sent', to: 'a•••@example.com', messages: 4, source: 'widget' }),
  event('transcript_emailed', { status: 'failed', to: 'a•••@example.com', messages: 4, source: 'widget' }),
  event('call_queued', { channel: 'audio' }),
  event('call_offered', { channel: 'video' }),
  event('call_accepted', { channel: 'audio' }),
  event('call_cancelled', { channel: 'audio', reason: 'visitor_cancelled' }),
  event('call_cancelled', { channel: 'video', reason: 'operator_cancelled' }),
  event('call_expired', { channel: 'audio' }),
  event('call_missed', { channel: 'audio', reason: 'sla_breach' }),
  event('call_missed', { channel: 'video', reason: 'no_answer' }),
  event('callback_requested', { channel: 'audio' }),
  event('callback_completed'),
  event('callback_offered', { channel: 'audio' }),
  event('sla_breached', { wait_seconds: 95 }),
  event('queue_long_wait', { wait_seconds: 40 }),
  ...['audio', 'video', 'screenshare', 'meeting'].flatMap((call_type) =>
    ['operator_ended', 'visitor_ended', 'system_ended', 'failed'].map((end_reason) =>
      event('call_ended', { call_type, end_reason, duration_seconds: 125 }))),
  event('call_invited', { channel: 'video' }),
  event('call_invitation_joined'),
  event('call_invitation_expired'),
  event('call_invitation_cancelled', { reason: 'operator_cancelled' }),
  event('call_invitation_declined'),
];

/** Codes the server writes that must never reach the screen as they are. */
const RAW = /\b(?:[a-z]+_[a-z_]+|inbox\.|audio|video|screenshare|widget|prechat|token|email|phone)\b/;

describe('Activity timeline translations', () => {
  for (const [locale, messages] of Object.entries({ en, fa, tr })) {
    it(`${locale}: every event reads as translated text`, () => {
      const t = translator(messages as unknown as Record<string, unknown>);
      const bad: string[] = [];
      for (const ev of EVENTS) {
        const { primary, secondary } = describeEvent(ev, t);
        const text = `${primary} | ${secondary ?? ''}`;
        // English legitimately says "Verified email"/"Verified phone"/"Video"; only flag codes.
        const check = locale === 'en'
          ? /\b[a-z]+_[a-z_]+\b|inbox\./.test(text)
          : RAW.test(text);
        if (check) bad.push(`${ev.event_type} ${JSON.stringify(ev.payload)} → ${text}`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('names how a conversation was given or taken away in every language, not by its code', () => {
    for (const [locale, messages] of Object.entries({ en, fa, tr })) {
      const t = translator(messages as unknown as Record<string, unknown>);
      for (const method of new Set([...ASSIGNED_METHODS, ...UNASSIGNED_METHODS])) {
        const key = `inbox.timeline.method.${method}`;
        expect(t(key), `${locale} ${method}`).not.toBe(key);
      }
      expect(t('inbox.timeline.source.transfer'), locale).not.toBe('inbox.timeline.source.transfer');
    }
    const faT = translator(fa as unknown as Record<string, unknown>);
    expect(describeEvent(event('assigned', { method: 'last_agent' }), faT).secondary).toBe('بازدیدکنندهٔ بازگشتی: همان اپراتور قبلی');
    expect(describeEvent(event('assigned', { method: 'manual', source: 'transfer' }), faT).secondary).toBe('واگذاری دستی · انتقال توسط اپراتور');
    expect(describeEvent(event('unassigned', { method: 'member_removed' }), faT))
      .toEqual({ primary: 'لغو واگذاری', secondary: 'اپراتور از تیم خارج شد' });
  });

  it('shows the real values: Persian reason, channel and duration', () => {
    const t = translator(fa as unknown as Record<string, unknown>);
    expect(describeEvent(event('call_cancelled', { channel: 'video', reason: 'operator_cancelled' }), t))
      .toEqual({ primary: 'تماس لغو شد', secondary: 'تصویری · لغو توسط اپراتور' });
    expect(describeEvent(event('identified', { method: 'visitor_id' }), t).secondary).toBe('بازدیدکننده بازگشتی');
    expect(describeEvent(event('call_ended', { call_type: 'audio', end_reason: 'visitor_ended', duration_seconds: 125 }), t).secondary)
      .toBe('صوتی · پایان توسط بازدیدکننده · 2:05');
  });

  it('a visitor\'s rating shows the score and their comment, quoted in the interface\'s style', () => {
    const enT = translator(en as unknown as Record<string, unknown>);
    const faT = translator(fa as unknown as Record<string, unknown>);
    expect(describeEvent(event('rated', { score: 4, comment: 'Great {{text}} $&' }), enT))
      .toEqual({ primary: 'Visitor rated the conversation', secondary: '★★★★ 4/5 · “Great {{text}} $&”' });
    expect(describeEvent(event('rated', { score: 5, comment: 'عالی' }), faT).secondary).toBe('★★★★★ 5/5 · «عالی»');
    expect(describeEvent(event('rated', { score: 3, comment: '  ' }), enT).secondary).toBe('★★★ 3/5');
  });

  it('a rating of a conversation only the AI answered rates the AI agent', () => {
    for (const [locale, messages] of Object.entries({ en, fa, tr })) {
      const t = translator(messages as unknown as Record<string, unknown>);
      const ai = describeEvent(event('rated', { score: 4, subject: 'ai' }), t);
      const human = describeEvent(event('rated', { score: 4, subject: 'operator' }), t);
      expect(ai.primary, locale).toBe(t('inbox.timeline.ratedAi'));
      expect(ai.primary, locale).not.toBe(human.primary);
      expect(ai.secondary, locale).toBe('★★★★ 4/5');
    }
    expect(describeEvent(event('rated', { score: 5, subject: 'ai' }), translator(en as unknown as Record<string, unknown>)).primary)
      .toBe('Visitor rated the AI agent');
    expect(describeEvent(event('rated', { score: 5, subject: 'ai' }), translator(fa as unknown as Record<string, unknown>)).primary)
      .toBe('بازدیدکننده به دستیار هوش مصنوعی امتیاز داد');
  });

  it('a transcript mailed to the visitor shows the masked address, and says so when it failed', () => {
    const t = translator(fa as unknown as Record<string, unknown>);
    expect(describeEvent(event('transcript_emailed', { status: 'sent', to: 'a•••@example.com' }), t))
      .toEqual({ primary: 'متن گفتگو برای بازدیدکننده ایمیل شد', secondary: 'a•••@example.com' });
    expect(describeEvent(event('transcript_emailed', { status: 'failed', to: 'a•••@example.com' }), translator(tr as unknown as Record<string, unknown>)).primary)
      .toBe('Döküm ziyaretçiye e-postayla gönderilemedi');
  });

  it('an unknown code reads as words, not as a key', () => {
    const t = translator(en as unknown as Record<string, unknown>);
    expect(describeEvent(event('call_cancelled', { reason: 'some_new_reason' }), t).secondary).toBe('Some new reason');
    expect(describeEvent(event('brand_new_event'), t).primary).toBe('Brand new event');
  });
});
