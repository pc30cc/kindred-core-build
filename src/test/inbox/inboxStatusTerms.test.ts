/**
 * One name per conversation status on every operator surface (I-01), action
 * buttons as verbs (I-02), and the Inbox's last English labels (I-13).
 *
 *   - The Inbox called an open conversation «در حال مکالمه» / "Active", the
 *     contact page «باز»; a resolved one was «حل شده» in the Inbox and
 *     «بسته‌شده» on the contact page; the hints sent it back "to Active", a
 *     status nobody showed. Now `conversationStatusLabel` (the Inbox, the
 *     contact page and drawer, the timeline) reads one set of keys.
 *   - The timeline filed a move to `closed` as "Marked as resolved".
 *   - The send split button read «حل شد» (a state) in Persian.
 *   - Channel names "Email" / "Phone" were English in every panel.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { conversationStatusLabel, normalizeConversationStatus } from '@/lib/conversationStatus';
import { describeEvent } from '@/components/inbox/timelineMeta';
import { channelLabel } from '@/components/inbox/ChannelBadge';
import type { TimelineEvent } from '@/hooks/useConversationTimeline';

/** The app's lookup: nested sections, flat dotted keys inside a section; the key itself on a miss. */
function translator(messages: unknown) {
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
const T = { en: translator(en), fa: translator(fa), tr: translator(tr) };

describe('a conversation status has one name', () => {
  it('in Persian: open «باز», pending «در انتظار بازدیدکننده», resolved «حل‌شده», closed «بسته»', () => {
    expect(conversationStatusLabel(T.fa, 'open')).toBe('باز');
    expect(conversationStatusLabel(T.fa, 'pending')).toBe('در انتظار بازدیدکننده');
    expect(conversationStatusLabel(T.fa, 'resolved')).toBe('حل‌شده');
    expect(conversationStatusLabel(T.fa, 'closed')).toBe('بسته');
  });

  it('in English and Turkish', () => {
    expect(['open', 'pending', 'resolved', 'closed'].map((s) => conversationStatusLabel(T.en, s)))
      .toEqual(['Open', 'Waiting on visitor', 'Resolved', 'Closed']);
    expect(['open', 'pending', 'resolved', 'closed'].map((s) => conversationStatusLabel(T.tr, s)))
      .toEqual(['Açık', 'Ziyaretçi bekleniyor', 'Çözüldü', 'Kapalı']);
  });

  it('a resolved conversation is never called closed, nor a closed one resolved (the contact page did)', () => {
    for (const t of Object.values(T)) {
      expect(conversationStatusLabel(t, 'resolved')).not.toBe(conversationStatusLabel(t, 'closed'));
    }
  });

  it('an unknown or missing status reads as open, and a missing key falls back to English', () => {
    expect(normalizeConversationStatus(undefined)).toBe('open');
    expect(normalizeConversationStatus('snoozed')).toBe('open');
    expect(conversationStatusLabel((k) => k, 'pending')).toBe('Waiting on visitor');
  });

  it('no hint sends a conversation "back to Active" any more: they name the status the list shows', () => {
    for (const key of ['markAwaitingReplyHint', 'awaitingReplyActiveHint', 'backToActive']) {
      expect(fa.inbox[key as keyof typeof fa.inbox], key).not.toContain('فعال');
      expect(fa.inbox[key as keyof typeof fa.inbox], key).toContain('باز');
      expect(en.inbox[key as keyof typeof en.inbox], key).not.toContain('Active');
      expect(tr.inbox[key as keyof typeof tr.inbox], key).not.toContain('Aktif');
    }
  });
});

describe('the timeline', () => {
  const event = (event_type: string, payload: Record<string, unknown>) =>
    ({ id: event_type, event_type, payload, created_at: '2026-10-21T00:00:00Z', actor_type: 'agent' }) as unknown as TimelineEvent;

  it('says "Closed" for a move to closed (the PATCH files it as a resolved event), "Marked as resolved" otherwise', () => {
    expect(describeEvent(event('resolved', { from: 'open', to: 'closed', reason: 'manual_status_change' }), T.fa).primary).toBe('بسته شد');
    expect(describeEvent(event('resolved', { from: 'open', to: 'closed' }), T.en).primary).toBe('Closed');
    expect(describeEvent(event('resolved', { from: 'open', to: 'resolved' }), T.en).primary).toBe('Marked as resolved');
    expect(describeEvent(event('resolved', {}), T.tr).primary).toBe('Çözüldü olarak işaretlendi');
  });

  it('names statuses in a status change the way the list does', () => {
    expect(describeEvent(event('status_changed', { from: 'pending', to: 'open' }), T.fa).secondary)
      .toContain('در انتظار بازدیدکننده → باز');
  });
});

describe('action buttons are verbs, not the state they lead to', () => {
  it('Persian: «حل کردن», «ارسال و حل»; Turkish: «Çöz»', () => {
    expect(fa.inbox.resolve).toBe('حل کردن');
    expect(fa.inbox.sendAndResolveShort).toBe('ارسال و حل');
    expect(fa.inbox.sendAndWaitShort).toBe('ارسال و انتظار');
    expect(tr.inbox.resolve).toBe('Çöz');
    for (const [name, bundle] of Object.entries({ en, fa, tr })) {
      expect(bundle.inbox.resolve, name).not.toBe(bundle.inbox.resolved);
      expect(bundle.inbox.sendAndResolveShort, name).not.toBe(bundle.inbox.resolved);
    }
  });
});

describe('channel names', () => {
  it('Email and Phone are translated (they were English in every panel)', () => {
    expect(channelLabel('email', T.fa)).toBe('ایمیل');
    expect(channelLabel('phone', T.fa)).toBe('تلفن');
    expect(channelLabel('email', T.tr)).toBe('E-posta');
    expect(channelLabel('phone', T.en)).toBe('Phone');
    // Brands stay their own name.
    expect(channelLabel('whatsapp', T.fa)).toBe('WhatsApp');
  });
});
