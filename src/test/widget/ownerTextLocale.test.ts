/**
 * An automatic text the owner wrote per language reaches the visitor only
 * in the visitor's language; for any other, the built-in text in theirs
 * (owner, 2026-10-18: no automatic message in another language).
 *
 * The owner's English (or any other filled language) used to come first:
 * a Persian visitor got "Connecting you to our team now." when only English
 * was written, a Turkish one the Persian line when only Persian was. The
 * same held for the hand-over pre-chat card's subtitle (Core runtime.js)
 * and the availability labels and offline message (widget/availability.ts),
 * against its own rule: "offline_message_localized first, then
 * offline_message, then empty string".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ widget: null as Record<string, unknown> | null }));

vi.mock('../../../server/supabase.js', () => {
  const builder = (rows: Row[]) => {
    const api: Record<string, unknown> = {
      select: () => api, eq: () => api, in: () => api, is: () => api,
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      then: (res: (r: { data: Row[] }) => unknown) => Promise.resolve({ data: rows }).then(res),
    };
    return api;
  };
  return {
    getServiceClient: () => ({
      from: (table: string) => builder(table === 'widget_settings' && db.widget ? [db.widget] : []),
    }),
  };
});

const { pickHandoffAckMessage } = await import('../../../server/services/ai-agent/runtime/templates.js');
const { resolveAvailability } = await import('../../../server/services/widget/availability.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

const BUILT_IN_ACK = {
  fa: 'باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.',
  tr: 'Tamam — sizi bir temsilciye bağlıyorum.',
  en: "Sure — I'll connect you with a human agent.",
};

describe('the AI\'s hand-over acknowledgement (pickHandoffAckMessage)', () => {
  it('only English written: a Persian or Turkish visitor gets the built-in line in theirs', () => {
    const settings = { handoff_message_localized: { en: 'Connecting you to our team now.' } };
    expect(pickHandoffAckMessage(settings, 'fa')).toBe(BUILT_IN_ACK.fa);
    expect(pickHandoffAckMessage(settings, 'tr')).toBe(BUILT_IN_ACK.tr);
    expect(pickHandoffAckMessage(settings, 'en')).toBe('Connecting you to our team now.');
  });

  it('only Persian written: a Turkish visitor never gets the Persian line', () => {
    const settings = { handoff_message_localized: { fa: 'الان شما را به همکارم وصل می‌کنم.' } };
    expect(pickHandoffAckMessage(settings, 'tr')).toBe(BUILT_IN_ACK.tr);
    expect(pickHandoffAckMessage(settings, 'fa-IR')).toBe('الان شما را به همکارم وصل می‌کنم.');
  });

  it('a language the built-in lines lack still gets the owner\'s English before the built-in English', () => {
    const settings = { handoff_message_localized: { en: 'Connecting you to our team now.' } };
    expect(pickHandoffAckMessage(settings, 'de')).toBe('Connecting you to our team now.');
    expect(pickHandoffAckMessage({}, 'de')).toBe(BUILT_IN_ACK.en);
  });
});

describe('the availability labels and offline message (resolveAvailability)', () => {
  beforeEach(() => {
    db.widget = {
      business_hours: { enabled: false, timezone: 'UTC' },
      offline_mode: 'capture_message',
      availability_labels: { en: { online: 'Open', offline: 'Closed' } },
      offline_message_localized: { en: 'Leave us a note.' },
      offline_message: '',
    };
  });

  it('only English written: a Persian visitor reads the built-in Persian labels, not the English ones', async () => {
    const snap = await resolveAvailability(CONFIG, { workspaceId: 'ws-1', locale: 'fa' });
    expect(snap.labels).toEqual({ online: 'آنلاین هستیم', offline: 'آفلاین هستیم' });
    expect(snap.offline_message).toBe('');
    const en = await resolveAvailability(CONFIG, { workspaceId: 'ws-1', locale: 'en' });
    expect(en.labels).toEqual({ online: 'Open', offline: 'Closed' });
    expect(en.offline_message).toBe('Leave us a note.');
  });

  it('the legacy single offline message stays the fallback, as the resolver\'s rule says', async () => {
    db.widget = { ...db.widget, offline_message_localized: null, offline_message: 'پیام بگذارید' };
    expect((await resolveAvailability(CONFIG, { workspaceId: 'ws-1', locale: 'fa' })).offline_message).toBe('پیام بگذارید');
  });
});

describe('the hand-over pre-chat card\'s subtitle (Core runtime.js resolveHandoffPrechatSubtitle)', () => {
  // The function as shipped, with the closure's `ctx` and `t` handed in.
  const src = readFileSync('public/widget/runtime.js', 'utf8');
  const start = src.indexOf('function resolveHandoffPrechatSubtitle(locale) {');
  const end = src.indexOf('\n    }\n', start) + 6;
  const make = (localized: Record<string, string>) => new Function('ctx', 't', `${src.slice(start, end)}\nreturn resolveHandoffPrechatSubtitle;`)(
    { config: { aiAgent: { handoffPrechatMessageLocalized: localized } } },
    (key: string) => (key === 'handoffPrechatSubtitle' ? `built-in:${key}` : ''),
  ) as (locale: string) => string;

  it('only English written: a Persian visitor gets the widget\'s own subtitle', () => {
    expect(start).toBeGreaterThan(0);
    const pick = make({ en: 'Tell us who you are' });
    expect(pick('fa')).toBe('built-in:handoffPrechatSubtitle');
    expect(pick('en')).toBe('Tell us who you are');
  });

  it('their own language wins', () => {
    expect(make({ en: 'Tell us who you are', fa: 'خودتان را معرفی کنید' })('fa')).toBe('خودتان را معرفی کنید');
  });
});
