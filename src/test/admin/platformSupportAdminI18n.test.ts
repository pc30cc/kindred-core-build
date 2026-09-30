/**
 * Super Admin's side of platform support (docs/PLATFORM_SUPPORT.md) — every
 * word of it in all three languages.
 *
 * `t()` does not fail on a missing key (it renders the dotted path), and the
 * TypeScript key type is too wide to catch one, so the keys the card asks
 * for are resolved against the real locale objects here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const CARD = 'src/pages/admin/support/PlatformSupportCard.tsx';
const PAGE = 'src/pages/admin/CoreSettingsPage.tsx';
const TEMPLATES = 'src/components/admin/EmailTemplatesTab.tsx';
const LOCALES = { en, fa, tr } as const;

function resolves(locale: unknown, path: string): boolean {
  let current: unknown = locale;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.trim() !== '';
}

function literalKeys(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]))];
}

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** The whole card: an on switch and a workspace. Tickets and their emails are gone. */
const SUPPORT_KEYS = [
  'title', 'hint', 'loadFailed',
  'enabledLabel', 'enabledOnHint', 'enabledOffHint', 'noWorkspace',
  'workspaceLabel', 'workspaceHint', 'workspaceNone', 'workspaceMissing', 'clear', 'suggestions',
  'searchPlaceholder', 'searching', 'searchEmpty', 'searchFailed',
];
const REMOVED_SUPPORT_KEYS = [
  'ticketsLabel', 'ticketsOnHint', 'ticketsOffHint',
  'notifyLabel', 'notifyHint', 'notifyPlaceholder', 'notifyInvalid', 'notifyTooMany',
];

describe('Core settings → Support', () => {
  const keys = [...literalKeys(CARD), ...literalKeys(PAGE)];

  it('finds the keys it is meant to check', () => {
    expect(keys).toContain('admin.coreSettings.tabSupport');
    const used = keys.filter((k) => k.startsWith('admin.coreSettings.support.'))
      .map((k) => k.slice('admin.coreSettings.support.'.length));
    expect(used.sort()).toEqual([...SUPPORT_KEYS].sort());
  });

  it('has exactly the keys the card uses, in every language', () => {
    for (const locale of Object.values(LOCALES)) {
      expect(Object.keys(locale.admin.coreSettings.support).sort()).toEqual([...SUPPORT_KEYS].sort());
    }
  });

  it('no longer offers tickets or notification emails', () => {
    const source = readFileSync(CARD, 'utf8');
    for (const name of ['ticketsEnabled', 'notifyEmails', 'parseEmails', 'MAX_EMAILS', 'Textarea']) {
      expect(source).not.toContain(name);
    }
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const key of REMOVED_SUPPORT_KEYS) {
        expect(resolves(locale, `admin.coreSettings.support.${key}`), `${name}: ${key}`).toBe(false);
      }
    }
  });

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`every key resolves in ${name}`, () => {
      expect(keys.filter((k) => !resolves(locale, k))).toEqual([]);
    });
  }

  it('keeps the whole Core settings tree identical in every language', () => {
    const expected = leaves(en.admin.coreSettings).sort();
    expect(leaves(fa.admin.coreSettings).sort()).toEqual(expected);
    expect(leaves(tr.admin.coreSettings).sort()).toEqual(expected);
  });

  it('tells the admin what operators see and where their messages land', () => {
    expect(en.admin.coreSettings.support.hint).toContain('Online support');
    expect(en.admin.coreSettings.support.hint).toContain('Site user');
    expect(en.admin.coreSettings.support.hint).toContain('leave a message');
    expect(en.admin.coreSettings.support.hint).toContain('business hours');
    expect(fa.admin.coreSettings.support.hint).toContain('کاربر سایت');
    expect(fa.admin.coreSettings.support.hint).toContain('ساعات کاری');
    expect(tr.admin.coreSettings.support.hint).toContain('Site kullanıcısı');
    expect(tr.admin.coreSettings.support.hint).toContain('çalışma saatleri');
    for (const locale of Object.values(LOCALES)) {
      expect(locale.admin.coreSettings.support.hint).not.toMatch(/ticket|e-?mail|تیکت|ایمیل|talep|e-posta/i);
    }
  });

  it('writes Persian with Persian letters, not Arabic ي and ك', () => {
    expect(Object.values(fa.admin.coreSettings.support).join('\n')).not.toMatch(/[\u064A\u0643]/);
  });

  it('talks to the admin API through the shared admin client', () => {
    const source = readFileSync(CARD, 'utf8');
    expect(source).toContain("from '@/hooks/useAdmin'");
    expect(source).toContain('/api/admin/platform-support/settings');
    expect(source).toContain('/api/admin/platform-support/workspaces?search=');
  });
});

describe('support ticket email templates', () => {
  // Tickets are gone (docs/PLATFORM_SUPPORT.md): nothing sends these any more.
  const slugs = ['platform_support_ticket_created', 'platform_support_ticket_reply'];

  it('are no longer offered in Branding → Email templates', () => {
    const source = readFileSync(TEMPLATES, 'utf8');
    for (const slug of slugs) expect(source).not.toContain(slug);
    expect(source).not.toContain("key: 'support'");
  });

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`have neither a name nor a category in ${name}`, () => {
      expect(resolves(locale, 'admin.brandingPage.emailTemplates.categories.support')).toBe(false);
      for (const slug of slugs) {
        expect(resolves(locale, `admin.brandingPage.emailTemplates.slugs.${slug}`)).toBe(false);
      }
    });
  }
});

describe('the support_reply push event', () => {
  it('is named in every language', () => {
    expect(en.admin.notifications.events.support_reply).toBe('Support reply');
    expect(fa.admin.notifications.events.support_reply).toBe('پاسخ پشتیبانی');
    expect(tr.admin.notifications.events.support_reply).toBe('Destek yanıtı');
  });
});
