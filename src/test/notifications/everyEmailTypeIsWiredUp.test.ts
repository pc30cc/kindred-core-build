/**
 * An email type has to exist all the way down.
 *
 * Six email switches shipped on the operator's settings page with nothing
 * behind them — no sender, no template, no column that anything read. The
 * fix was to delete them; the guard against doing it again is this: a type
 * named in the registry must have a producer that queues it, copy in all
 * three languages, a column for the platform to switch it with, a column for
 * the operator to decline it with, and a control in the admin console.
 *
 * Every list is read from the file that owns it, so a type added in one
 * place and forgotten in another fails here rather than in somebody's empty
 * inbox.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const REGISTRY = 'server/services/notificationEmail/types.ts';
const PRODUCERS = 'server/services/notificationEmail/producers.ts';
const SETTINGS = 'server/services/notificationEmail/settings.ts';
const MIGRATION = 'database/migrations/206_operator_notification_emails.sql';
const HOSTED = 'supabase/migrations/20260921200000_operator_notification_emails.sql';
const WEB_CLIENT = 'src/lib/notifications-api.ts';
const ADMIN_TAB = 'src/components/admin/notifications/NotificationEmailTab.tsx';
const BRANDING = 'src/components/admin/EmailTemplatesTab.tsx';
const OPERATOR_PAGE = 'src/pages/app/settings/NotificationsPage.tsx';
const LOCALES = ['en', 'fa', 'tr'];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The types, from the registry that owns them. */
function types(): string[] {
  const source = read(REGISTRY);
  const start = source.indexOf('export const NOTIFICATION_EMAIL_TYPES = [');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('] as const;', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** The template slug each type renders through. */
function slugs(): string[] {
  const source = read(REGISTRY);
  return [...source.matchAll(/slug: '([a-z_]+)'/g)].map((m) => m[1]);
}

describe('every notification email type', () => {
  const declared = types();
  const declaredSlugs = slugs();

  it('is a list worth having', () => {
    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect(declaredSlugs).toHaveLength(declared.length);
  });

  it('has something that queues it', () => {
    // A type with no producer is a switch that saves and sends nothing,
    // which is the entire bug this work exists to close.
    const producers = read(PRODUCERS);
    const unproduced = declared.filter((type) => !producers.includes(`type: '${type}'`));
    expect(unproduced).toEqual([]);
  });

  it('has a platform switch and a default in the settings service', () => {
    const settings = read(SETTINGS);
    for (const type of declared) {
      expect(settings).toContain(`${type}_enabled`);
    }
  });

  it('has a column in both migration chains', () => {
    for (const path of [MIGRATION, HOSTED]) {
      const sql = read(path);
      for (const type of declared) {
        // The platform's switch…
        expect(sql).toContain(`${type}_enabled boolean`);
        // …and the operator's own.
        expect(sql).toMatch(new RegExp(`\\n  ${type} boolean NOT NULL DEFAULT true`));
      }
    }
  });

  it('has copy seeded in all three languages', () => {
    const sql = read(MIGRATION);
    for (const slug of declaredSlugs) {
      for (const locale of LOCALES) {
        expect(sql).toContain(`'${slug}', '${locale}'`);
      }
    }
  });

  it('is editable in Branding → Email templates', () => {
    const branding = read(BRANDING);
    for (const slug of declaredSlugs) {
      expect(branding).toContain(`'${slug}'`);
    }
  });

  it('has a name in every language\'s template list', () => {
    for (const locale of LOCALES) {
      const source = read(`src/i18n/locales/${locale}.ts`);
      for (const slug of declaredSlugs) {
        expect(source).toContain(`${slug}:`);
      }
    }
  });

  it('is switchable by an admin and by the operator', () => {
    const admin = read(ADMIN_TAB);
    const client = read(WEB_CLIENT);
    for (const type of declared) {
      expect(admin).toContain(`'${type}'`);
      expect(client).toContain(`'${type}'`);
    }
    // The operator's page draws its rows from `available`, so what it must
    // carry is a label for each type rather than a hardcoded list.
    const page = read(OPERATOR_PAGE);
    for (const type of declared) {
      expect(page).toContain(`${type}:`);
    }
  });

  it('is described the same way by the admin console and the server', () => {
    const admin = read(ADMIN_TAB);
    const start = admin.indexOf('const TYPES: EmailType[] = [');
    expect(start).toBeGreaterThan(-1);
    const end = admin.indexOf('];', start);
    const listed = [...admin.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...declared].sort());
  });
});

describe('the platform starts silent', () => {
  it('ships with every type off', () => {
    // A migration that starts mailing every operator on a platform the
    // moment it is applied would be a very bad morning.
    const sql = read(MIGRATION);
    expect(sql).toContain('enabled boolean NOT NULL DEFAULT false');
    for (const type of types()) {
      expect(sql).toContain(`${type}_enabled boolean NOT NULL DEFAULT false`);
    }

    const settings = read(SETTINGS);
    const start = settings.indexOf('NOTIFICATION_EMAIL_DEFAULTS');
    const end = settings.indexOf('};', start);
    const defaults = settings.slice(start, end);
    expect(defaults).not.toMatch(/_enabled: true/);
    expect(defaults).toContain('enabled: false');
  });

  it('and the queue refuses a second copy of the same mail', () => {
    for (const path of [MIGRATION, HOSTED]) {
      expect(read(path)).toContain('uq_notification_email_jobs_dedupe');
    }
  });
});
