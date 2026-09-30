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

describe('Core settings → Support', () => {
  const keys = [...literalKeys(CARD), ...literalKeys(PAGE)];

  it('finds the keys it is meant to check', () => {
    expect(keys).toContain('admin.coreSettings.tabSupport');
    expect(keys.filter((k) => k.startsWith('admin.coreSettings.support.')).length).toBeGreaterThan(15);
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
    expect(fa.admin.coreSettings.support.hint).toContain('کاربر سایت');
    expect(tr.admin.coreSettings.support.hint).toContain('Site kullanıcısı');
  });

  it('talks to the admin API through the shared admin client', () => {
    const source = readFileSync(CARD, 'utf8');
    expect(source).toContain("from '@/hooks/useAdmin'");
    expect(source).toContain('/api/admin/platform-support/settings');
    expect(source).toContain('/api/admin/platform-support/workspaces?search=');
  });
});

describe('support ticket email templates', () => {
  const slugs = ['platform_support_ticket_created', 'platform_support_ticket_reply'];

  it('are editable in Branding → Email templates, with their variables listed', () => {
    const source = readFileSync(TEMPLATES, 'utf8');
    for (const slug of slugs) {
      expect(source).toContain(`'${slug}'`);
      expect(source).toMatch(new RegExp(`\\n  ${slug}: \\[`));
    }
  });

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`have a name and a category in ${name}`, () => {
      expect(resolves(locale, 'admin.brandingPage.emailTemplates.categories.support')).toBe(true);
      for (const slug of slugs) {
        expect(resolves(locale, `admin.brandingPage.emailTemplates.slugs.${slug}`)).toBe(true);
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
