/**
 * The server writes a system row's sentence in the operator's language for
 * the clients that print `body` (server/services/operatorSystemText.ts),
 * with a copy of the dashboard's strings. The copy must stay the dashboard's
 * word for word, and hold every key the shared localizer reads.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { SYSTEM_MESSAGE_KINDS } from '../../../shared/systemMessages';
import {
  OPERATOR_SYSTEM_STRINGS, operatorSystemText, withOperatorSystemBody, withoutPlaceholderNames,
} from '../../../server/services/operatorSystemText';

const LOCALES = { fa, en, tr } as unknown as Record<'fa' | 'en' | 'tr', { inbox: Record<string, string> }>;

/** Every `inbox.*` key the localizer's sentences read (not the attachment previews). */
function keysTheLocalizerReads(): string[] {
  const src = readFileSync('shared/systemMessageText.ts', 'utf8');
  const body = src.slice(src.indexOf('export function invitationStatusText'), src.indexOf('// ─── Attachment-only previews'));
  return [...new Set((body.match(/'inbox\.[A-Za-z.]+'/g) || []).map((k) => k.slice(1, -1)))];
}

describe('the server copy of the operator strings', () => {
  it('equals the dashboard locale value, key for key, in fa, en and tr', () => {
    for (const locale of ['fa', 'en', 'tr'] as const) {
      for (const [key, value] of Object.entries(OPERATOR_SYSTEM_STRINGS[locale])) {
        expect(value, `${locale} ${key}`).toBe(LOCALES[locale].inbox[key.replace(/^inbox\./, '')]);
      }
    }
  });

  it('holds every key the shared localizer reads, and only those', () => {
    const read = keysTheLocalizerReads().sort();
    expect(read.length).toBeGreaterThan(20);
    for (const locale of ['fa', 'en', 'tr'] as const) {
      expect(Object.keys(OPERATOR_SYSTEM_STRINGS[locale]).sort(), locale).toEqual(read);
    }
  });
});

const SAMPLES: Record<string, Record<string, unknown>> = {
  routing_agent_joined: { kind: 'routing_agent_joined', agent_name: 'Sara' },
  routing_in_queue: { kind: 'routing_in_queue' },
  routing_no_agent_available: { kind: 'routing_no_agent_available' },
  conversation_transferred: { kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' },
  conversation_unassigned: { kind: 'conversation_unassigned', internal: true, actor_name: 'Ali' },
  conversation_closed: { kind: 'conversation_closed', agent_name: 'Sara' },
  call_invitation: { kind: 'call_invitation', channel: 'audio', status: 'pending' },
  call_ended: { kind: 'call_ended', ended_by: 'visitor', duration_seconds: 65 },
  platform_support_requester: { kind: 'platform_support_requester', internal: true, user: { name: 'Mina' } },
  support_rating: { kind: 'support_rating', internal: true, score: 5, comment: 'ممنون' },
};

describe('operatorSystemText', () => {
  it('writes every kind the server writes, in each language', () => {
    for (const kind of SYSTEM_MESSAGE_KINDS) {
      const fa_ = operatorSystemText(SAMPLES[kind], 'fa');
      const en_ = operatorSystemText(SAMPLES[kind], 'en');
      const tr_ = operatorSystemText(SAMPLES[kind], 'tr');
      expect(fa_ && en_ && tr_, kind).toBeTruthy();
      expect(fa_, kind).not.toBe(en_);
      expect(tr_, kind).not.toBe(en_);
      expect(`${fa_}${en_}${tr_}`, kind).not.toMatch(/inbox\.|\{(name|to|actor|op|duration|score|rating|comment)\}/);
    }
    expect(operatorSystemText({ kind: 'routing_in_queue' }, 'fa')).toBe('کاربر در صف پشتیبانی منتظر است');
    expect(operatorSystemText({ kind: 'conversation_closed', agent_name: 'Sara' }, 'tr')).toBe('Sara sohbeti kapattı');
  });

  it('is null for what it cannot write', () => {
    expect(operatorSystemText({ kind: 'order_status' }, 'fa')).toBeNull();
    expect(operatorSystemText({ kind: 'support_rating' }, 'fa')).toBeNull();
    expect(operatorSystemText({}, 'fa')).toBeNull();
    expect(operatorSystemText(null, 'fa')).toBeNull();
    expect(operatorSystemText('routing_in_queue', 'fa')).toBeNull();
  });
});

describe('withOperatorSystemBody', () => {
  it("replaces a system row's body and keeps every other field", () => {
    const row = { id: 'm1', sender_type: 'system', body: 'Your message is in the support queue.', metadata: { kind: 'routing_in_queue' }, created_at: 'x' };
    const out = withOperatorSystemBody(row, 'fa');
    expect(out).toEqual({ ...row, body: 'کاربر در صف پشتیبانی منتظر است' });
    expect(row.body).toBe('Your message is in the support queue.');
  });

  it('nulls the English stand-in name and writes the generic sentence', () => {
    const row = { sender_type: 'system', body: 'a colleague joined the conversation.', metadata: { kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: 'u1' } };
    const out = withOperatorSystemBody(row, 'fa');
    expect(out.body).toBe('یکی از همکاران به گفتگو پیوست');
    expect(out.metadata).toEqual({ kind: 'routing_agent_joined', agent_name: null, agent_id: 'u1' });
    expect(row.metadata.agent_name).toBe('a colleague');
  });

  it("keeps the requester card's stored details: macOS and the Electron app print them in the thread", () => {
    // requester.ts writes the whole card as the body for a client that draws
    // no card; one line ('Requester · Reza') would lose the email, the
    // workspaces and their plans for good.
    const body = 'Site user: Reza · reza@shop.ir · +98912 · Shop · member since 2025-01-01 · via web\n1 workspace\n• Shop (owner) — Pro (active)';
    const row = { sender_type: 'system', body, metadata: { kind: 'platform_support_requester', internal: true, user: { name: 'Reza', email: 'reza@shop.ir' } } };
    expect(withOperatorSystemBody(row, 'fa')).toBe(row);
    // The list preview and the transcript still read it as one line.
    expect(operatorSystemText(row.metadata, 'fa')).toBe('مشخصات درخواست‌کننده · Reza');
  });

  it('returns the same object for any other row', () => {
    const contact = { sender_type: 'contact', body: 'hi', metadata: { kind: 'routing_in_queue' } };
    const unknown = { sender_type: 'system', body: 'x', metadata: { kind: 'something_new' } };
    const plain = { sender_type: 'system', body: 'x', metadata: null };
    for (const row of [contact, unknown, plain]) expect(withOperatorSystemBody(row, 'fa')).toBe(row);
  });

  it('withoutPlaceholderNames keeps an object with real names as is', () => {
    const meta = { kind: 'conversation_transferred', actor_name: 'Ali', to_name: 'Sara' };
    expect(withoutPlaceholderNames(meta)).toBe(meta);
    expect(withoutPlaceholderNames(null)).toBeNull();
  });
});
