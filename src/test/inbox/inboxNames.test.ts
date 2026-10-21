/**
 * What people are called, the same everywhere.
 *
 * I-07 — a visitor: the lock screen said «ali.r» (the push names an
 * email-only visitor by the email's local part, as the phone apps' lists do)
 * while the web Inbox said «بازدیدکننده از تهران · K7M4», so the operator
 * found no such row. One rule now (shared/contactName.ts) for the push, the
 * web Inbox and the contact pages.
 *
 * I-10 — an operator without a profile name: «پشتیبانی» on their bubbles,
 * their email's local part in the list, «شما» in a colleague's preview when
 * the server sent no name. Colleagues now read their name, else their
 * email's local part, else «اپراتور»; "You" only for one's own messages. The
 * VISITOR never reads an email: an operator who typed theirs as their name
 * goes out without a name on messages, typing, and the widget's team stack,
 * and the widget writes its own word for an operator.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fa from '@/i18n/locales/fa';
import en from '@/i18n/locales/en';
import { contactOwnName, emailLocalPart, realContactName } from '../../../shared/contactName';
import { contactDisplayName as webContactName } from '@/lib/contact-display';
import { contactDisplayName as pushContactName } from '../../../server/services/push/contactName';
import { operatorDisplayName, previewOperatorLabel } from '@/lib/operatorName';
import { visitorMessagePayload } from '../../../server/services/realtime/publish';
import { resolveOperatorIdentities } from '../../../server/services/widget/senderIdentity';
import { widgetTeamName } from '../../../shared/widgetTeam';

const FSI = '\u2068';
const PDI = '\u2069';

function t(bundle: { inbox: Record<string, unknown> }) {
  return (key: string, vars?: Record<string, string>) => {
    let value = String(bundle.inbox[key.replace(/^inbox\./, '')] ?? key);
    for (const [k, v] of Object.entries(vars ?? {})) value = value.split(`{{${k}}}`).join(v);
    return value;
  };
}
const faT = t(fa as unknown as { inbox: Record<string, unknown> });
const enT = t(en as unknown as { inbox: Record<string, unknown> });

describe('a visitor has one name on the phone and on the web', () => {
  it('the shared rule: their name, else the email before the @, else none', () => {
    expect(contactOwnName({ name: 'Sara', email: 's@x.test' })).toBe('Sara');
    expect(contactOwnName({ name: null, email: 'ali.r@example.com' })).toBe('ali.r');
    expect(contactOwnName({ name: 'Visitor', email: 'ali@example.com' })).toBe('ali');
    expect(contactOwnName({ name: '  ', visitor_code: 'K7M4' })).toBeNull();
    expect(realContactName(' visitor ')).toBeNull();
    expect(emailLocalPart('@odd')).toBe('@odd');
  });

  it('the lock screen and the web Inbox row read the same for an email-only visitor', () => {
    const contact = { name: null, email: 'ali.r@example.com', visitor_code: 'K7M4' };
    const push = pushContactName(contact, 'fa');
    const web = webContactName(contact, 'c1', faT, { city: 'Tehran', country_code: 'IR', region: 'Tehran' }, 'fa');
    expect(push).toBe('ali.r');
    // The web isolates the Latin run inside a Persian line; the name is the same.
    expect(web).toBe(`${FSI}ali.r${PDI}`);
    expect(web.replace(/[\u2068\u2069]/g, '')).toBe(push);
  });

  it('an anonymous visitor is still named by their code on both', () => {
    const contact = { name: null, email: null, visitor_code: 'K7M4' };
    expect(pushContactName(contact, 'fa')).toBe('بازدیدکننده K7M4');
    expect(webContactName(contact, 'c1', faT, null, 'fa')).toContain('K7M4');
  });
});

describe('an operator without a name, as colleagues read the Inbox', () => {
  it('their name; else their email\'s local part; else «اپراتور» — never «پشتیبانی»', () => {
    expect(operatorDisplayName({ name: 'Sara' }, faT)).toBe('Sara');
    expect(operatorDisplayName({ name: null, known: { full_name: '', email: 'reza.k@shop.test' } }, faT)).toBe('reza.k');
    expect(operatorDisplayName({ name: null, known: null }, faT)).toBe('اپراتور');
    expect(operatorDisplayName({ name: '  ' }, enT)).toBe('Operator');
    // An English stand-in once stored as a name is no name.
    expect(operatorDisplayName({ name: 'An operator' }, faT)).toBe('اپراتور');
  });

  it('a list preview says "You" only for the reader\'s own message', () => {
    expect(previewOperatorLabel({ id: 'me', name: 'Me Myself' }, 'me', faT)).toBe('شما');
    // A colleague whose name did not come: never «شما».
    expect(previewOperatorLabel({ id: 'colleague', name: null }, 'me', faT)).toBe('اپراتور');
    expect(previewOperatorLabel({ id: 'colleague', name: 'Ali' }, 'me', faT)).toBe('Ali');
    expect(previewOperatorLabel({ id: 'colleague', name: null, known: { email: 'ali@x.test' } }, 'me', enT)).toBe('ali');
  });
});

describe('the visitor never reads an operator\'s email', () => {
  it('a message envelope drops an email (or a placeholder) as sender_name, keeps a real name and the AI\'s', () => {
    expect(visitorMessagePayload({ id: 'm1', sender_name: 'sara@shop.test', sender_id: 'u1' })).toEqual({ id: 'm1', sender_name: null });
    expect(visitorMessagePayload({ id: 'm2', sender_name: 'An operator' }).sender_name).toBeNull();
    expect(visitorMessagePayload({ id: 'm3', sender_name: 'Sara' }).sender_name).toBe('Sara');
    expect(visitorMessagePayload({ id: 'm4', sender_name: 'AI Assistant' }).sender_name).toBe('AI Assistant');
    expect(visitorMessagePayload({ id: 'm5', sender_name: null }).sender_name).toBeNull();
  });

  it('the identities every visitor-facing route reads (messages, typing, list, rating card) carry no email as a name', async () => {
    const profiles = [
      { id: 'u1', full_name: 'sara@shop.test', avatar_storage_key: null },
      { id: 'u2', full_name: 'Reza', avatar_storage_key: null },
      { id: 'u3', full_name: null, avatar_storage_key: null },
    ];
    const supabase = {
      from: () => ({ select: () => ({ in: async () => ({ data: profiles.map((p) => ({ ...p })), error: null }) }) }),
    };
    const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
    const out = await resolveOperatorIdentities(config, supabase, ['u1', 'u2', 'u3']);
    expect(out.get('u1')?.name).toBeNull();
    expect(out.get('u2')?.name).toBe('Reza');
    expect(out.get('u3')?.name).toBeNull();
  });

  it('the widget\'s team stack (public config) writes the widget\'s word for an operator instead of an email', () => {
    expect(widgetTeamName('sara@shop.test', 'fa')).toBe('اپراتور');
    expect(widgetTeamName('sara@shop.test', 'en')).toBe('Operator');
    expect(widgetTeamName('Sara', 'tr')).toBe('Sara');
  });
});
