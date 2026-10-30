/**
 * Super Admin → Branding → Email templates lists the simple billing's mails,
 * each with the variables its sender really fills, and billing v2's old
 * mails too, under "No longer sent": every template the platform keeps is
 * viewable there (owner, 2026-10-30), and none is hidden because nothing
 * sends it any more.
 *
 * The tab draws its list from the server's catalog
 * (server/services/email/templateCatalog.ts), so the catalog is what is
 * checked against the sender (notify.ts BillingEmailSlug) and against the
 * content the migration chain seeds today (291): a billing mail added there
 * and forgotten here fails in this test. The saved card's mails (262) are
 * sent in the International edition only; the Iranian edition lists them
 * too, as rows it keeps and never sends, and the balance's renewal mail
 * names no card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { catalogView } from '../../../server/services/email/templateCatalog.js';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => `[${k}]`, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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

const EmailTemplatesTab = (await import('@/components/admin/EmailTemplatesTab')).default;

const SLUG_KEY = 'admin.brandingPage.emailTemplates.slugs';
const LOCALES = { en, fa, tr } as const;

/** The variables each mail fills besides the ones every billing mail has. */
const OWN_VARIABLES: Record<string, string[]> = {
  billing_renewal_reminder: ['{plan_name}', '{new_plan_name}', '{amount}', '{balance}', '{period_end}', '{days_left}'],
  billing_renewed: ['{plan_name}', '{old_plan_name}', '{amount}', '{balance}', '{period_start}', '{period_end}'],
  billing_expired: ['{plan_name}', '{expired_at}'],
  billing_plan_changed: ['{plan_name}', '{old_plan_name}', '{amount}', '{balance}', '{period_start}', '{period_end}'],
  billing_change_scheduled: ['{plan_name}', '{new_plan_name}', '{effective_at}'],
  billing_payment_receipt: ['{receipt_url}', '{receipt_number}', '{amount}', '{balance}'],
  billing_plan_activated: ['{plan_name}', '{period_end}', '{amount}', '{balance}'],
  billing_trial_ending: ['{trial_end}', '{days_left}'],
  billing_trial_ended: [],
  billing_card_renewed: ['{plan_name}', '{old_plan_name}', '{amount}', '{balance}', '{period_start}', '{period_end}', '{card}'],
  billing_card_payment_failed: ['{plan_name}', '{amount}', '{card}', '{failure_reason}', '{due_at}'],
  billing_card_removed: ['{card}', '{reason}', '{plan_name}', '{period_end}'],
  billing_locked_data_deletion: ['{plan_name}', '{days_left}', '{deletion_date}', '{locked_summary}', '{export_url}'],
  billing_ai_pack_purchased: ['{pack_name}', '{credit}', '{amount}', '{balance}', '{ai_balance}'],
};
const CARD_SLUGS = ['billing_card_renewed', 'billing_card_payment_failed', 'billing_card_removed'];
const EVERY_BILLING_MAIL = ['{brand}', '{year}', '{support_email}', '{workspace}', '{billing_url}'];
/** Billing v2's mails (seeded by 239, retired with billing v2 in 267 and 268), which nothing sends. */
const BILLING_V2 = [
  'invoice_issued', 'invoice_reminder', 'invoice_due', 'invoice_past_due', 'payment_success', 'payment_failed',
  'payment_received', 'subscription_renewed', 'subscription_cancelled', 'subscription_restored',
  'subscription_free_fallback', 'wallet_autopay_insufficient',
];

/** The slugs the sender knows (BillingEmailSlug in notify.ts). */
function senderSlugs(): string[] {
  const source = readFileSync('server/services/billing/account/notify.ts', 'utf8');
  const start = source.indexOf('export type BillingEmailSlug =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Every {placeholder} migration 291 (the content every sent template has now) writes for a slug, in any language. */
function seededPlaceholders(): Map<string, Set<string>> {
  const sql = readFileSync('database/migrations/291_email_templates_redesign.sql', 'utf8');
  const out = new Map<string, Set<string>>();
  const rows = sql.split(/^ {2}-- ([a-z_]+) \((?:fa|en|tr)\)$/m);
  for (let i = 1; i < rows.length; i += 2) {
    const found = out.get(rows[i]) ?? new Set<string>();
    const body = rows[i + 1].split(/\n\);?\n|;\n/)[0];
    for (const v of body.matchAll(/\{[a-z_]+\}/g)) found.add(v[0]);
    out.set(rows[i], found);
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

/** The slugs a list group shows, in order. */
function listed(group: 'sent' | 'legacy'): string[] {
  const box = screen.queryByTestId(`email-templates-${group}`);
  if (!box) return [];
  return within(box).queryAllByRole('button').map((b) => (b.getAttribute('data-testid') ?? '').replace(/^email-template-/, ''));
}

function variableChips(): string[] {
  return within(screen.getByTestId('email-template-variables')).queryAllByText(/^\{[a-z_]+\}$/).map((e) => e.textContent ?? '');
}

let edition: 'iran' | 'international' = 'international';

async function renderTab() {
  render(<EmailTemplatesTab />);
  await waitFor(() => expect(screen.getByTestId('email-templates-edition')).toBeInTheDocument());
}

describe('Branding → Email templates: the billing mails', () => {
  const slugs = Object.keys(OWN_VARIABLES);

  beforeEach(() => {
    edition = 'international';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(url).endsWith('/catalog')
        ? { edition, locales: { offered: edition === 'iran' ? ['fa'] : ['en', 'fa', 'tr'], fallback: 'en' }, templates: catalogView(edition) }
        : String(url).endsWith('/preview') && init?.method === 'POST'
          ? { subject: 's', html: '<p>h</p>', text: 't', problems: [] }
          : { templates: [], edition };
      return { ok: true, status: 200, json: async () => body };
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are the mails the sender sends', () => {
    expect(senderSlugs().sort()).toEqual([...slugs].sort());
    const billing = catalogView('international').filter((v) => v.category === 'billing');
    expect(billing.filter((v) => v.status === 'sent').map((v) => v.slug).sort()).toEqual([...slugs].sort());
  });

  it('are the billing category, and billing v2\'s old mails are listed as no longer sent', async () => {
    await renderTab();
    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.categories.billing]'));
    expect(listed('sent')).toEqual(slugs);
    expect(listed('legacy')).toEqual(BILLING_V2);

    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.allCategories]'));
    for (const slug of slugs) expect(listed('sent')).toContain(slug);
    for (const legacy of BILLING_V2) expect(listed('legacy')).toContain(legacy);
    // Billing v2's archived names never had a row in this table.
    expect([...listed('sent'), ...listed('legacy')]).not.toContain('trial_expired');
  });

  it('in the Iranian edition list the card mails as not sent here; the renewal mail (the balance\'s) names no card', async () => {
    edition = 'iran';
    await renderTab();
    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.categories.billing]'));
    expect(listed('sent')).toEqual(slugs);
    for (const slug of slugs) {
      const marked = within(screen.getByTestId(`email-template-${slug}`)).queryByText('[admin.brandingPage.emailTemplates.groups.notSentHere]');
      expect(Boolean(marked), slug).toBe(CARD_SLUGS.includes(slug));
    }
    fireEvent.click(screen.getByTestId('email-template-billing_card_removed'));
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.notSentInEdition]');
    fireEvent.click(screen.getByTestId('email-template-billing_renewed'));
    expect(variableChips().sort()).toEqual([...EVERY_BILLING_MAIL, ...OWN_VARIABLES.billing_renewed].sort());
    expect(variableChips()).not.toContain('{card}');
  });

  it('offer the variables each mail fills, covering everything the seeds print', async () => {
    const seeded = seededPlaceholders();
    await renderTab();
    fireEvent.click(screen.getByText('[admin.brandingPage.emailTemplates.categories.billing]'));
    for (const slug of slugs) {
      fireEvent.click(screen.getByTestId(`email-template-${slug}`));
      const chips = variableChips();
      expect(chips.sort(), slug).toEqual([...EVERY_BILLING_MAIL, ...OWN_VARIABLES[slug]].sort());
      expect(seeded.get(slug)?.size, `${slug} is seeded`).toBeGreaterThan(0);
      for (const v of seeded.get(slug) ?? []) expect(chips, `${slug} ${v}`).toContain(v);
    }
  });

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`have a name in ${name}`, () => {
      expect([...slugs, ...BILLING_V2].filter((slug) => !resolves(locale, `${SLUG_KEY}.${slug}`))).toEqual([]);
    });
  }

  it('write Persian with Persian letters, not Arabic ي and ك', () => {
    const names = [...slugs, ...BILLING_V2].map((slug) => (fa.admin.brandingPage.emailTemplates.slugs as Record<string, string>)[slug]);
    expect(names.join('\n')).not.toMatch(/[يك]/);
  });
});
