/**
 * Super Admin → Branding → Email templates lists the simple billing's mails
 * while billing v2 is off (shared/billingMode.ts), each with the variables
 * its sender really fills. Every platform mail is edited there, per edition;
 * a billing mail missing from the list could only be changed in SQL.
 *
 * The slugs are read from the sender (notify.ts) and the seed (migration
 * 261), so a mail added there and forgotten here fails in this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => `[${k}]`, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/lib/api', () => ({ API_BASE: '' }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['fa', 'en', 'tr'], canSwitchLanguage: true }),
}));
// A plain stand-in for the Radix select: each option is a button.
vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext } = await import('react');
  const Pick = createContext<(value: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: ReactNode }) => (
      <Pick.Provider value={onValueChange}>{children}</Pick.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const pick = useContext(Pick);
      return <button type="button" onClick={() => pick(value)}>{children}</button>;
    },
  };
});

const { LEGACY_BILLING_ENABLED } = await import('../../../shared/billingMode');
const EmailTemplatesTab = (await import('@/components/admin/EmailTemplatesTab')).default;

const SLUG_KEY = 'admin.brandingPage.emailTemplates.slugs';
const LOCALES = { en, fa, tr } as const;

/** The variables each mail fills besides the ones every billing mail has. */
const OWN_VARIABLES: Record<string, string[]> = {
  billing_renewal_reminder: ['{plan_name}', '{new_plan_name}', '{amount}', '{balance}', '{period_end}', '{days_left}'],
  billing_renewed: ['{plan_name}', '{amount}', '{balance}', '{period_start}', '{period_end}'],
  billing_expired: ['{plan_name}', '{expired_at}'],
  billing_plan_changed: ['{plan_name}', '{old_plan_name}', '{amount}', '{balance}', '{period_start}', '{period_end}'],
  billing_change_scheduled: ['{plan_name}', '{new_plan_name}', '{effective_at}'],
  billing_payment_receipt: ['{receipt_number}', '{amount}', '{balance}', '{receipt_url}'],
  billing_plan_activated: ['{plan_name}', '{amount}', '{balance}', '{period_end}'],
  billing_trial_ending: ['{trial_end}', '{days_left}'],
  billing_trial_ended: [],
};
const EVERY_BILLING_MAIL = ['{brand}', '{year}', '{support_email}', '{workspace}', '{billing_url}'];

/** The slugs the sender knows (BillingEmailSlug in notify.ts). */
function senderSlugs(): string[] {
  const source = readFileSync('server/services/billing/account/notify.ts', 'utf8');
  const start = source.indexOf('export type BillingEmailSlug =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every {placeholder} migration 261 seeds for a slug, in any language. */
function seededPlaceholders(): Map<string, Set<string>> {
  const sql = readFileSync('database/migrations/261_simple_billing_renewals.sql', 'utf8');
  const out = new Map<string, Set<string>>();
  for (const m of sql.matchAll(/^SELECT pg_temp\._email_261_seed\('([a-z_]+)', '[a-z]{2}',\n([\s\S]*?)'\);$/gm)) {
    const found = out.get(m[1]) ?? new Set<string>();
    for (const v of m[2].matchAll(/\{[a-z_]+\}/g)) found.add(v[0]);
    out.set(m[1], found);
  }
  return out;
}

function resolves(locale: unknown, path: string): boolean {
  let current: unknown = locale;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.trim() !== '';
}

/** The slugs in the template list, in order (each row is "[name key]slug"). */
function listedSlugs(): string[] {
  return screen.getAllByRole('button')
    .map((b) => (b.textContent ?? '').match(/^\[admin\.brandingPage\.emailTemplates\.slugs\.([a-z_]+)\]([a-z_]+)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[1] === m[2])
    .map((m) => m[1]);
}

function variableChips(): string[] {
  return screen.getAllByText(/^\{[a-z_]+\}$/).map((e) => e.textContent ?? '');
}

async function renderTab() {
  render(<EmailTemplatesTab />);
  await waitFor(() => expect(screen.getByTestId('email-templates-edition')).toBeInTheDocument());
}

describe('Branding → Email templates: the simple billing mails', () => {
  const slugs = Object.keys(OWN_VARIABLES);

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ templates: [], edition: 'iran' }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are the nine mails the sender sends', () => {
    expect(LEGACY_BILLING_ENABLED).toBe(false);
    expect(senderSlugs().sort()).toEqual([...slugs].sort());
  });

  it('are the billing category while billing v2 is off, and v2 mails are not listed', async () => {
    await renderTab();
    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.categories.billing]'));
    expect(listedSlugs()).toEqual(slugs);

    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.allCategories]'));
    const all = listedSlugs();
    for (const slug of slugs) expect(all).toContain(slug);
    for (const legacy of ['invoice_issued', 'payment_received', 'subscription_renewed', 'trial_expired']) {
      expect(all).not.toContain(legacy);
    }
  });

  it('offer the variables each mail fills, covering everything the seed uses', async () => {
    const seeded = seededPlaceholders();
    await renderTab();
    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.categories.billing]'));
    for (const slug of slugs) {
      fireEvent.click(screen.getByText(`[${SLUG_KEY}.${slug}]`));
      const chips = variableChips();
      expect(chips.sort(), slug).toEqual([...EVERY_BILLING_MAIL, ...OWN_VARIABLES[slug]].sort());
      expect(seeded.get(slug)?.size, `${slug} is seeded`).toBeGreaterThan(0);
      for (const v of seeded.get(slug) ?? []) expect(chips, `${slug} ${v}`).toContain(v);
    }
  });

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`have a name in ${name}`, () => {
      expect(slugs.filter((slug) => !resolves(locale, `${SLUG_KEY}.${slug}`))).toEqual([]);
    });
  }

  it('write Persian with Persian letters, not Arabic ي and ك', () => {
    const names = slugs.map((slug) => (fa.admin.brandingPage.emailTemplates.slugs as Record<string, string>)[slug]);
    expect(names.join('\n')).not.toMatch(/[يك]/);
  });
});
