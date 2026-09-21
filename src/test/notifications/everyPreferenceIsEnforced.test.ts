/**
 * A switch an operator turns off has to turn something off.
 *
 * Nine of the sixteen on Settings → Notifications did not. Six email ones
 * with no sender behind them anywhere in the codebase, a "visitor is
 * browsing" one for an event nothing emits, and the two presence ones the
 * resolver never consulted. Each saved, answered 200, and changed nothing —
 * and an operator who turns one off believes it, which is the whole problem.
 * The report that arrived was "the Notifications section does not work", and
 * it was right.
 *
 * This is the cheap version of that discovery. Every preference the API
 * offers has to be named by something that acts on it, and the three
 * descriptions of the same row — the endpoint's defaults, the browser's type
 * and the phone's coding keys — have to agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = 'server/routes/notifications.ts';
const WEB_TYPE = 'src/lib/notifications-api.ts';
const IOS_MODEL = 'ios/WebyarNative/Sources/Core/Models/NotificationPrefs.swift';

/** Where a preference may be enforced. Each is a place that ACTS. */
const ENFORCEMENT = [
  // Before the server sends to a phone.
  'server/services/push/recipients.ts',
  // Before the browser draws a banner.
  'src/features/notifications/operatorBrowserNotification.ts',
  // Before the browser plays its chime.
  'src/features/notifications/operatorMessageSound.ts',
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The keys of the route's `DEFAULTS` object. */
function routeKeys(): string[] {
  const source = read(ROUTE);
  const start = source.indexOf('const DEFAULTS = {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

/** The fields of the browser client's `NotificationPrefs` interface. */
function webKeys(): string[] {
  const source = read(WEB_TYPE);
  const start = source.indexOf('export interface NotificationPrefs {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

/** The wire names in the phone model's `CodingKeys`. */
function iosKeys(): string[] {
  const source = read(IOS_MODEL);
  const start = source.indexOf('enum CodingKeys');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n    }', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe('every notification preference', () => {
  const keys = routeKeys();

  it('the endpoint offers a set worth having', () => {
    // A guard on the guard: an empty parse would make everything below pass.
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });

  it('is read by something that acts on it', () => {
    const sources = ENFORCEMENT.map(read).join('\n');
    const unenforced = keys.filter((key) => !sources.includes(key));
    expect(unenforced).toEqual([]);
  });

  it('is described the same way by the browser and the phone', () => {
    expect([...webKeys()].sort()).toEqual([...keys].sort());
    expect([...iosKeys()].sort()).toEqual([...keys].sort());
  });
});

describe('the switches that enforced nothing', () => {
  // Kept by name so that reintroducing one is a deliberate act with a
  // sender behind it, rather than a copy-paste that ships another lie.
  const REMOVED = [
    'email_unread_messages',
    'email_transcripts',
    'email_user_ratings',
    'email_paid_invoices',
    'email_weekly_summary',
    'email_product_updates',
    'push_visitor_browsing',
  ];

  it('are gone from the endpoint', () => {
    const source = read(ROUTE);
    // The doc comment names them on purpose — it is the record of why they
    // went — so only the executable part of the file is searched.
    const code = source.slice(source.indexOf("import { Router }"));
    for (const key of REMOVED) expect(code).not.toContain(key);
  });

  it('are gone from both clients', () => {
    for (const path of [WEB_TYPE, IOS_MODEL, 'src/pages/app/settings/NotificationsPage.tsx']) {
      const source = read(path);
      for (const key of REMOVED) expect(source).not.toContain(key);
    }
  });

  it('and nothing in the product sends the email they described', () => {
    // The reason they went. If an unread digest or a transcript mail is ever
    // built, this is the test that says the switch may come back.
    const recipients = read('server/services/push/recipients.ts');
    for (const key of REMOVED) expect(recipients).not.toContain(key);
  });
});
