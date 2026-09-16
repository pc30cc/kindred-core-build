import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  systemMessageText, invitationStatusText, formatCallDuration,
} from '@/lib/systemMessageText';

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
];

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
          .not.toMatch(/\{(actor|to|name|op|duration|m)\}/);
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
    expect(CONVERSATIONS_ROUTE).toContain('system_meta: meta?.kind ? meta : null,');
    expect(CONVERSATIONS_ROUTE).not.toContain('actor_name: meta?.actor_name ? String(meta.actor_name) : null,');
    expect(CONTACTS_ROUTE).toContain('last_message_meta:');
    expect(CONTACTS_ROUTE).toContain("select('conversation_id, sender_type, sender_id, body, created_at, metadata')");
  });
});
