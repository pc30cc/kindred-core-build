/**
 * The call center settings page's pure rules (src/lib/call-center-api.ts),
 * 2026-10 call widget design, contract §5.1 and B4/B7/B8:
 *
 *   - the migration-277 keys a save may send: only those the loaded settings
 *     have (a backend or database without 277 has none) and only when the
 *     admin changed them (an old backend reading a database that already has
 *     277 returns the columns, but its strict PUT refuses them);
 *   - the callback hours the server stores (`{}` or the strict business
 *     hours shape): the client check agrees with the server's schema;
 *   - the default hours a new schedule starts from, per edition;
 *   - the reference code visitors see on screen 19 and the callbacks search;
 *   - a 503 migration_pending answer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CALL_WIDGET_DESIGN_KEYS,
  callCenterApi,
  callWidgetDesignPatch,
  cleanCallWidgetTheme,
  callbackMatchesSearch,
  callbackReference,
  defaultCallbackHours,
  effectiveCallWidgetLocales,
  isCallbackHoursStrict,
  isMigrationPendingError,
  type CallbackRequest,
} from '@/lib/call-center-api';
import { CALL_WIDGET_DESIGN_COLUMNS, computeEffectiveCallCenterLocales } from '../../../server/services/callCenter/settings';
import { callbackHoursSchema } from '../../../server/services/callCenter/presentation';

describe('the migration-277 keys a save sends', () => {
  it('are the columns migration 277 adds (the server list)', () => {
    expect([...CALL_WIDGET_DESIGN_KEYS].sort()).toEqual([...CALL_WIDGET_DESIGN_COLUMNS].sort());
  });

  it('settings loaded without them (an old backend or a database without 277): none is sent, whatever the draft holds', () => {
    const loaded = { display_name: 'Support' };
    const draft = { display_name: 'Support', launcher_style: 'pill', callback_slots_enabled: true, callback_slot_minutes: 15 };
    expect(callWidgetDesignPatch(loaded, draft)).toEqual({});
  });

  it('loaded and unchanged: none is sent', () => {
    const loaded = {
      launcher_style: 'round_label', callback_slots_enabled: false, callback_slot_minutes: 30, callback_days_ahead: 4, callback_slot_capacity: null,
    };
    expect(callWidgetDesignPatch(loaded, { ...loaded })).toEqual({});
  });

  it('loaded and changed: exactly the changed ones, with the draft value (an emptied capacity is null)', () => {
    const loaded = {
      launcher_style: 'round_label', callback_slots_enabled: false, callback_slot_minutes: 30, callback_days_ahead: 4, callback_slot_capacity: 3,
    };
    const draft = { ...loaded, launcher_style: 'card', callback_slot_capacity: null };
    expect(callWidgetDesignPatch(loaded, draft)).toEqual({ launcher_style: 'card', callback_slot_capacity: null });
  });

  it('a key the loaded settings have but the draft lost is not sent (never undefined in the body)', () => {
    expect(callWidgetDesignPatch({ launcher_style: 'pill' }, {})).toEqual({});
  });
});

describe('callback hours the server stores', () => {
  const cases: Array<[string, unknown]> = [
    ['empty object', {}],
    ['weekly only', { weekly: { mon: [{ from: '09:00', to: '17:00' }] } }],
    ['full', {
      enabled: true, timezone: 'Asia/Tehran',
      weekly: { sat: [{ from: '09:00', to: '13:00' }, { from: '14:00', to: '17:00' }], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
      overrides: [{ date: '2026-10-29', closed: true, label: 'Holiday' }, { date: '2026-11-02', intervals: [{ from: '10:00', to: '12:00' }] }],
    }],
    ['legacy free JSON', { foo: 1 }],
    ['no weekly', { enabled: true, timezone: 'UTC' }],
    ['bad time', { weekly: { mon: [{ from: '9:00', to: '17:00' }] } }],
    ['empty time (a cleared field)', { weekly: { mon: [{ from: '', to: '17:00' }] } }],
    ['24:00', { weekly: { mon: [{ from: '09:00', to: '24:00' }] } }],
    ['unknown day', { weekly: { monday: [] } }],
    ['extra interval key', { weekly: { mon: [{ from: '09:00', to: '17:00', note: 'x' }] } }],
    ['seven intervals', { weekly: { mon: Array.from({ length: 7 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` })) } }],
    ['six intervals', { weekly: { mon: Array.from({ length: 6 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` })) } }],
    ['unknown zone', { timezone: 'Mars/Olympus', weekly: {} }],
    ['zone not a string', { timezone: 3, weekly: {} }],
    ['enabled not boolean', { enabled: 'yes', weekly: {} }],
    ['bad override date', { weekly: {}, overrides: [{ date: '2026-13-01', closed: true }] }],
    ['override extra key', { weekly: {}, overrides: [{ date: '2026-10-01', why: 'x' }] }],
    ['long label', { weekly: {}, overrides: [{ date: '2026-10-01', label: 'x'.repeat(121) }] }],
    ['61 overrides', { weekly: {}, overrides: Array.from({ length: 61 }, () => ({ date: '2026-10-01', closed: true })) }],
    ['null', null],
    ['array', []],
    ['string', 'x'],
  ];

  it.each(cases)('%s: the client check agrees with the server schema', (_name, value) => {
    expect(isCallbackHoursStrict(value)).toBe(callbackHoursSchema.safeParse(value).success);
  });

  it('the default hours pass the server schema in both editions', () => {
    for (const edition of ['iran', 'international'] as const) {
      expect(callbackHoursSchema.safeParse(defaultCallbackHours(edition, 'Europe/London')).success).toBe(true);
    }
  });

  it('Iran: Tehran time, Saturday to Wednesday 09:00–17:00', () => {
    const h = defaultCallbackHours('iran', 'Europe/London');
    expect(h.timezone).toBe('Asia/Tehran');
    for (const d of ['sat', 'sun', 'mon', 'tue', 'wed'] as const) expect(h.weekly[d]).toEqual([{ from: '09:00', to: '17:00' }]);
    for (const d of ['thu', 'fri'] as const) expect(h.weekly[d]).toEqual([]);
  });

  it('International: the browser zone given, Monday to Friday 09:00–17:00; an unknown zone falls back to UTC', () => {
    const h = defaultCallbackHours('international', 'Europe/London');
    expect(h.timezone).toBe('Europe/London');
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) expect(h.weekly[d]).toEqual([{ from: '09:00', to: '17:00' }]);
    for (const d of ['sat', 'sun'] as const) expect(h.weekly[d]).toEqual([]);
    expect(defaultCallbackHours('international', 'Not/AZone').timezone).toBe('UTC');
    expect(defaultCallbackHours('international', undefined).timezone).toBe('UTC');
  });
});

describe('the callback reference code', () => {
  const cb = (over: Partial<CallbackRequest>): CallbackRequest => ({
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', workspace_id: 'ws', status: 'requested', channel: 'voice', created_at: '2026-10-19T10:00:00Z', ...over,
  });

  it('is the first eight characters of the id, upper-cased (what screen 19 shows)', () => {
    expect(callbackReference('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('3FA85F64');
  });

  it('the search finds a callback by its code, in any case, with a leading # or spaces', () => {
    const c = cb({});
    for (const q of ['3FA85F64', '3fa85f64', '#3FA85F64', '  3fa85 ', 'FA85F6']) expect(callbackMatchesSearch(c, q)).toBe(true);
    expect(callbackMatchesSearch(c, '5717')).toBe(false);
  });

  it('still finds name, subject, notes, e-mail and phone; an empty search matches all', () => {
    const c = cb({ metadata: { name: 'Sara Ahmadi', subject: 'Invoice' }, notes: 'call after 5', contact_email: 'sara@x.test', contact_phone: '+98 912' });
    for (const q of ['sara a', 'INVOICE', 'after 5', 'x.test', '+98 9', '']) expect(callbackMatchesSearch(c, q)).toBe(true);
    expect(callbackMatchesSearch(c, 'reza')).toBe(false);
  });
});

describe('a save the server answers 503 migration_pending', () => {
  it('is recognised by status and code', () => {
    expect(isMigrationPendingError(Object.assign(new Error('migration_pending'), { status: 503, code: 'migration_pending' }))).toBe(true);
    expect(isMigrationPendingError(Object.assign(new Error('x'), { status: 503, code: null }))).toBe(false);
    expect(isMigrationPendingError(Object.assign(new Error('x'), { status: 400, code: 'invalid_body' }))).toBe(false);
    expect(isMigrationPendingError(null)).toBe(false);
  });
});

describe('review fixes (verify round 4)', () => {
  const cb = (over: Partial<CallbackRequest>): CallbackRequest => ({
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', workspace_id: 'ws', status: 'requested', channel: 'voice', created_at: '2026-10-19T10:00:00Z', ...over,
  });

  it('the search reads a code typed with Persian or Arabic-Indic digits (a Persian keyboard) as the code', () => {
    const c = cb({});
    expect(callbackMatchesSearch(c, '۳FA۸۵F۶۴')).toBe(true);
    expect(callbackMatchesSearch(c, '٣fa٨٥f٦٤')).toBe(true);
    // A phone stored with Persian digits is found by Latin digits and the other way round.
    const p = cb({ contact_phone: '۰۹۱۲ ۳۴۵ ۶۷۸۹' });
    expect(callbackMatchesSearch(p, '0912 345')).toBe(true);
    expect(callbackMatchesSearch(cb({ contact_phone: '0912 345 6789' }), '۰۹۱۲')).toBe(true);
    expect(callbackMatchesSearch(c, '۹۹۹۹')).toBe(false);
  });

  it('an old backend refusing a migration-277 key (its strict schema, a rolling deploy) reads as "the server is being updated"', () => {
    const old = (form: string[]) => Object.assign(new Error('invalid_body'), {
      status: 400, code: 'invalid_body', details: { formErrors: form, fieldErrors: {} },
    });
    expect(isMigrationPendingError(old(["Unrecognized key(s) in object: 'launcher_style'"]))).toBe(true);
    expect(isMigrationPendingError(old(["Unrecognized key(s) in object: 'callback_slot_minutes', 'callback_days_ahead'"]))).toBe(true);
    // Any other refusal is a real error.
    expect(isMigrationPendingError(old(["Unrecognized key(s) in object: 'avatar_url'"]))).toBe(false);
    expect(isMigrationPendingError(old([]))).toBe(false);
    expect(isMigrationPendingError(Object.assign(new Error('x'), { status: 400, code: 'invalid_body', details: { fieldErrors: { launcher_style: ['Invalid enum value'] } } }))).toBe(false);
  });

  it('a failed request keeps the server details on the error (what tells an old backend apart)', async () => {
    const details = { formErrors: ["Unrecognized key(s) in object: 'launcher_style'"], fieldErrors: {} };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_body', details }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const err = await callCenterApi.updateSettings('ws-1', { launcher_style: 'pill' }).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ status: 400, code: 'invalid_body', details });
      expect(isMigrationPendingError(err)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const PLATFORM = { widget_available_locales: ['fa', 'en', 'tr'], widget_default_locale: 'fa' };
  const localeCases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['nothing chosen by the workspace: the platform', PLATFORM, { widget_default_locale: null, widget_enabled_locales: null }],
    ['an empty list: the platform', PLATFORM, { widget_default_locale: null, widget_enabled_locales: [] }],
    ['own list and default', PLATFORM, { widget_default_locale: 'en', widget_enabled_locales: ['en', 'tr'] }],
    ['own default outside its list', PLATFORM, { widget_default_locale: 'fa', widget_enabled_locales: ['en', 'tr'] }],
    ['a language the platform dropped', { widget_available_locales: ['fa'], widget_default_locale: 'fa' }, { widget_default_locale: 'en', widget_enabled_locales: ['en'] }],
    ['platform default not offered', { widget_available_locales: ['en', 'tr'], widget_default_locale: 'fa' }, { widget_default_locale: null, widget_enabled_locales: null }],
    ['no platform languages', { widget_available_locales: [], widget_default_locale: 'fa' }, { widget_default_locale: null, widget_enabled_locales: null }],
  ];

  it.each(localeCases)('the preview speaks the languages the bootstrap would (%s)', (_name, platform, workspace) => {
    const server = computeEffectiveCallCenterLocales(platform as never, workspace as never);
    expect(effectiveCallWidgetLocales(platform, workspace)).toEqual({ default_locale: server.default_locale, available: server.available });
  });
});

describe('cleanCallWidgetTheme: only #rrggbb reaches the strict save', () => {
  it('drops emptied colours (the default again), spells #rgb out, lower-cases', () => {
    expect(cleanCallWidgetTheme({ primary: '', accent: '  ', surface: '#FFF', text: '112233', muted: '#AbCdEf', radius: 'lg', density: 'compact' }))
      .toEqual({ theme: { surface: '#ffffff', text: '#112233', muted: '#abcdef', radius: 'lg', density: 'compact' }, invalid: null });
  });
  it('names the first colour the server would refuse', () => {
    expect(cleanCallWidgetTheme({ primary: '#12', danger: 'red' }).invalid).toBe('primary');
    expect(cleanCallWidgetTheme(null)).toEqual({ theme: {}, invalid: null });
  });
});
