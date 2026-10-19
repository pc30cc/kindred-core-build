import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  systemMessageText, invitationStatusText, formatCallDuration,
} from '@/lib/systemMessageText';
import { SYSTEM_MESSAGE_KINDS } from '../../../shared/systemMessages';

/**
 * System message bodies are written in English by the server and frozen into
 * the row at insert time, so every surface that shows one has to rebuild the
 * sentence from `metadata`. Four surfaces did that independently and each
 * knew a different subset of kinds — which is why an operator could read a
 * localized "X transferred this conversation" in the thread and a raw
 * English "Call ended · Duration 01:12" in the list beside it.
 */

/** Resolve like the app does: `inbox.` prefix into the inbox bundle. */
function translator(bundle: Record<string, unknown>) {
  const strings = (bundle.inbox ?? {}) as Record<string, string>;
  return (key: string) => strings[key.replace(/^inbox\./, '')] ?? key;
}
const T = {
  en: translator(en as Record<string, unknown>),
  fa: translator(fa as Record<string, unknown>),
  tr: translator(tr as Record<string, unknown>),
};

const KINDS = [
  { kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' },
  { kind: 'conversation_unassigned', actor_name: 'Ali' },
  { kind: 'routing_agent_joined', agent_name: 'Sara' },
  { kind: 'routing_no_agent_available' },
  { kind: 'routing_in_queue' },
  { kind: 'call_invitation', channel: 'video', operator_name: 'Ali', status: 'pending' },
  { kind: 'call_ended', ended_by: 'operator', duration_seconds: 72 },
  { kind: 'support_rating', internal: true, score: 4, comment: 'great help' },
  { kind: 'conversation_closed', by: 'agent', agent_name: 'Sara', operator_name: 'Sara', status: 'resolved' },
  { kind: 'conversation_closed', by: 'agent', agent_name: null, status: 'closed' },
  { kind: 'platform_support_requester', internal: true, user: { name: 'Sara' }, workspace_count: 1 },
  { kind: 'platform_support_requester', internal: true, user: { name: null } },
  { kind: 'conversation_transferred', to_name: 'Sara' },
  { kind: 'conversation_transferred' },
  { kind: 'conversation_unassigned' },
];

describe('every kind the server writes has a sentence', () => {
  it('covers SYSTEM_MESSAGE_KINDS in fa, en and tr, and Persian differs from English', () => {
    // A new kind is added to shared/systemMessages.ts first; this is what
    // makes the operator side follow.
    for (const kind of SYSTEM_MESSAGE_KINDS) {
      const sample = KINDS.find((m) => m.kind === kind);
      expect(sample, `no sample for ${kind}`).toBeTruthy();
      for (const [name, t] of Object.entries(T)) {
        expect(systemMessageText(sample, t), `${name} / ${kind}`).toBeTruthy();
      }
      expect(systemMessageText(sample, T.fa), kind).not.toBe(systemMessageText(sample, T.en));
    }
  });
});

describe('every system message kind has text, in every locale', () => {
  it('never falls through to null for a kind the product emits', () => {
    for (const meta of KINDS) {
      for (const [name, t] of Object.entries(T)) {
        const text = systemMessageText(meta, t);
        expect(text, `${name} / ${meta.kind}`).toBeTruthy();
        // A raw key leaking through means the locale is missing the string.
        expect(text, `${name} / ${meta.kind} leaked a key`).not.toMatch(/^inbox\./);
        expect(text, `${name} / ${meta.kind} leaked a key`).not.toMatch(/\binbox\.\w/);
      }
    }
  });

  it('actually translates — Persian is never the English string', () => {
    for (const meta of KINDS) {
      expect(systemMessageText(meta, T.fa), meta.kind)
        .not.toBe(systemMessageText(meta, T.en));
    }
  });

  it('substitutes every placeholder it is given', () => {
    for (const meta of KINDS) {
      for (const [name, t] of Object.entries(T)) {
        expect(systemMessageText(meta, t), `${name} / ${meta.kind}`)
          .not.toMatch(/\{(actor|to|name|op|duration|m|score|rating|comment)\}/);
      }
    }
  });

  it('returns null for a kind it does not know, so the caller can fall back', () => {
    // Showing nothing would be worse than showing the stored English body.
    expect(systemMessageText({ kind: 'something_new_next_quarter' }, T.en)).toBeNull();
    expect(systemMessageText({}, T.en)).toBeNull();
    expect(systemMessageText(null, T.en)).toBeNull();
  });
});

describe('the sentences say the right thing', () => {
  it('names who joined, and stays generic when it does not know', () => {
    expect(systemMessageText({ kind: 'routing_agent_joined', agent_name: 'Sara' }, T.en))
      .toContain('Sara');
    const generic = systemMessageText({ kind: 'routing_agent_joined' }, T.en)!;
    expect(generic).toBeTruthy();
    expect(generic).not.toContain('undefined');
  });

  it('calls the person on the other end "user", not "visitor", in Persian', () => {
    const text = systemMessageText(
      { kind: 'call_invitation', channel: 'video', operator_name: 'مجتبی داودی', status: 'pending' },
      T.fa,
    )!;
    expect(text).toContain('کاربر');
    expect(text).not.toContain('ویزیتور');
  });

  it('carries the live invitation status', () => {
    for (const status of ['pending', 'joined', 'expired', 'cancelled', 'declined']) {
      const text = systemMessageText(
        { kind: 'call_invitation', channel: 'audio', status }, T.en,
      )!;
      expect(text, status).toContain(invitationStatusText(T.en, status));
    }
  });

  it('reports who ended a call and how long it ran', () => {
    expect(systemMessageText({ kind: 'call_ended', ended_by: 'operator', duration_seconds: 72 }, T.en))
      .toBe('Call ended by operator · Duration 01:12');
    expect(systemMessageText({ kind: 'call_ended', ended_by: 'visitor', duration_seconds: 72 }, T.en))
      .toContain('visitor');
    expect(systemMessageText({ kind: 'call_ended', duration_seconds: 72 }, T.en))
      .toBe('Call ended · Duration 01:12');
  });

  it('says a call did not connect rather than reporting a zero duration', () => {
    for (const meta of [
      { kind: 'call_ended', ended_by: 'operator', duration_seconds: 0 },
      { kind: 'call_ended', ended_by: 'operator', duration_seconds: 30, end_reason: 'failed' },
    ]) {
      expect(systemMessageText(meta, T.en), JSON.stringify(meta)).toBe('Call did not connect');
    }
  });

  it('shows a site user\'s rating, with their comment when they left one', () => {
    const rated = { kind: 'support_rating', internal: true, score: 4, comment: 'great help' };
    expect(systemMessageText(rated, T.en)).toBe('Rated the conversation 4/5 — “great help”');
    expect(systemMessageText(rated, T.fa)).toBe('به این گفتگو 4 از ۵ امتیاز داد — «great help»');
    expect(systemMessageText(rated, T.tr)).toBe('Görüşmeye 5 üzerinden 4 puan verdi — “great help”');

    for (const comment of [null, undefined, '', '   ']) {
      expect(systemMessageText({ kind: 'support_rating', score: 5, comment }, T.en)).toBe('Rated the conversation 5/5');
    }
    expect(systemMessageText({ kind: 'support_rating', score: 2 }, T.fa)).toBe('به این گفتگو 2 از ۵ امتیاز داد');
  });

  it('names who closed the conversation (the line the visitor also sees), generic without a name', () => {
    const closed = { kind: 'conversation_closed', by: 'agent', agent_name: 'Sara', operator_name: 'Reza', status: 'resolved' };
    expect(systemMessageText(closed, T.en)).toBe('Sara closed the conversation');
    expect(systemMessageText(closed, T.fa)).toBe('Sara گفتگو را بست');
    expect(systemMessageText(closed, T.tr)).toBe('Sara sohbeti kapattı');
    for (const agent_name of [null, undefined, '', '  ']) {
      expect(systemMessageText({ kind: 'conversation_closed', agent_name }, T.en)).toBe('The conversation was closed');
    }
    expect(systemMessageText({ kind: 'conversation_closed' }, T.fa)).toBe('گفتگو بسته شد');
    expect(systemMessageText({ kind: 'conversation_closed' }, T.tr)).toBe('Sohbet kapatıldı');
    // A name is taken as typed.
    expect(systemMessageText({ kind: 'conversation_closed', agent_name: '$& {name}' }, T.en)).toBe('$& {name} closed the conversation');
  });

  it('takes the comment as typed, placeholders and all', () => {
    expect(systemMessageText({ kind: 'support_rating', score: 3, comment: '{rating} costs $& {score}' }, T.en))
      .toBe('Rated the conversation 3/5 — “{rating} costs $& {score}”');
  });

  it('falls back to the stored body when the score is not a rating', () => {
    for (const score of [undefined, null, 0, 6, 2.5, Number.NaN]) {
      expect(systemMessageText({ kind: 'support_rating', score }, T.en), String(score)).toBeNull();
    }
  });

  it('reads the queue line from the operator\'s side: the visitor waits, not "you"', () => {
    expect(systemMessageText({ kind: 'routing_in_queue' }, T.en)).toBe('The visitor is waiting in the support queue');
    expect(systemMessageText({ kind: 'routing_in_queue' }, T.fa)).toBe('کاربر در صف پشتیبانی منتظر است');
    expect(systemMessageText({ kind: 'routing_in_queue' }, T.tr)).toBe('Ziyaretçi destek kuyruğunda bekliyor');
    for (const t of Object.values(T)) {
      expect(systemMessageText({ kind: 'routing_in_queue' }, t)).not.toMatch(/You are|هستید|Sıradasınız/);
    }
  });

  it('a transfer or unassign without names never starts with a blank', () => {
    expect(systemMessageText({ kind: 'conversation_transferred', to_name: 'Sara' }, T.en))
      .toBe('This conversation was transferred to Sara');
    expect(systemMessageText({ kind: 'conversation_transferred', to_name: 'Sara' }, T.fa))
      .toBe('این گفتگو به Sara منتقل شد');
    expect(systemMessageText({ kind: 'conversation_transferred', actor_name: 'Ali' }, T.en))
      .toBe('This conversation was transferred');
    expect(systemMessageText({ kind: 'conversation_unassigned' }, T.tr))
      .toBe('Bu görüşmenin ataması kaldırıldı');
    expect(systemMessageText({ kind: 'conversation_unassigned', actor_name: '  ' }, T.en))
      .toBe('This conversation was unassigned');
    for (const meta of [
      { kind: 'conversation_transferred', to_name: 'Sara' },
      { kind: 'conversation_transferred' },
      { kind: 'conversation_unassigned' },
    ]) {
      for (const [name, t] of Object.entries(T)) {
        expect(systemMessageText(meta, t), `${name} / ${JSON.stringify(meta)}`).not.toMatch(/^\s/);
      }
    }
  });

  it('treats the English stand-ins once stored as a name as no name', () => {
    // chatRouting stored 'a colleague' as agent_name, which a Persian
    // sentence then printed in English.
    for (const agent_name of ['a colleague', ' A Colleague ', 'An operator']) {
      expect(systemMessageText({ kind: 'routing_agent_joined', agent_name }, T.fa)).toBe('یکی از همکاران به گفتگو پیوست');
      expect(systemMessageText({ kind: 'routing_agent_joined', agent_name }, T.en)).toBe('A colleague joined the conversation');
    }
    expect(systemMessageText({ kind: 'conversation_transferred', actor_name: 'An operator', to_name: 'Sara' }, T.en))
      .toBe('This conversation was transferred to Sara');
    expect(systemMessageText({ kind: 'conversation_closed', agent_name: 'a colleague' }, T.tr)).toBe('Sohbet kapatıldı');
  });

  it('writes the requester card as its title, with the name when there is one', () => {
    expect(systemMessageText({ kind: 'platform_support_requester', user: { name: 'Sara' } }, T.en)).toBe('Who is asking · Sara');
    expect(systemMessageText({ kind: 'platform_support_requester', user: { name: 'Sara' } }, T.fa)).toBe('مشخصات درخواست‌کننده · Sara');
    expect(systemMessageText({ kind: 'platform_support_requester', user: null }, T.tr)).toBe('Talep eden');
    expect(systemMessageText({ kind: 'platform_support_requester' }, T.en)).toBe('Who is asking');
  });

  it('prints names as typed, even when they look like placeholders', () => {
    expect(systemMessageText({ kind: 'conversation_transferred', actor_name: '{to}', to_name: '$&' }, T.en))
      .toBe('{to} transferred this conversation to $&');
    expect(systemMessageText({ kind: 'routing_agent_joined', agent_name: '$1 {name}' }, T.en))
      .toBe('$1 {name} joined the conversation');
  });

  it('formats durations past an hour', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(72)).toBe('01:12');
    expect(formatCallDuration(3661)).toBe('01:01:01');
    expect(formatCallDuration(-5)).toBe('00:00');
  });
});

describe('every surface reads from the one localizer', () => {
  const INBOX = readFileSync('src/pages/app/InboxPage.tsx', 'utf8');
  const CONTACT = readFileSync('src/pages/app/ContactDetailPage.tsx', 'utf8');
  const CONVERSATIONS_ROUTE = readFileSync('server/routes/conversations.ts', 'utf8');
  const CONTACTS_ROUTE = readFileSync('server/routes/contacts.ts', 'utf8');

  it('is used by the thread, the list preview and the contact page alike', () => {
    expect(INBOX).toContain("from '@/lib/systemMessageText'");
    expect(CONTACT).toContain("from '@/lib/systemMessageText'");
    // The list preview used to reimplement two kinds inline and know about
    // none of the rest.
    expect(INBOX).not.toContain('transferred this conversation to ${to}');
    expect(INBOX).not.toContain('joined the conversation`');
  });

  it('gets the whole metadata object from the server, not a field per kind', () => {
    // Shipping named fields meant every new kind needed a server change too,
    // and the list silently fell behind the thread when one was forgotten.
    expect(CONVERSATIONS_ROUTE).toContain('system_meta: meta?.kind ? (isSystem ? withoutPlaceholderNames(meta) : meta) : null,');
    expect(CONVERSATIONS_ROUTE).not.toContain('actor_name: meta?.actor_name ? String(meta.actor_name) : null,');
    expect(CONTACTS_ROUTE).toContain('last_message_meta:');
    expect(CONTACTS_ROUTE).toContain("select('conversation_id, sender_type, sender_id, body, created_at, metadata')");
  });

  it('the thread draws the closed line as a centred notice, not as a bubble', () => {
    // Every system row is a SystemNoticeRow (inboxSystemRows.test.tsx).
    const NOTICE = readFileSync('src/components/inbox/SystemNoticeRow.tsx', 'utf8');
    expect(INBOX).toContain('<SystemNoticeRow');
    expect(NOTICE).toContain("from '@/lib/systemMessageText'");
  });
});
