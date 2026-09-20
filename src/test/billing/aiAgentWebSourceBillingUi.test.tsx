/**
 * What a plan card is allowed to promise, and in whose language.
 *
 * This file used to test a BillingPage that built its capability list from
 * the server capability registry and then filtered it through two
 * page-local maps: CAP_LABELS_FA / CAP_LABELS_TR for Persian and Turkish
 * labels, and MODULE_GATE to hide a limit whose module the plan does not
 * include. Both maps are gone — the billing screen was rebuilt as six tabs,
 * and the plan card in `PlansTab` now builds its list from two curated key
 * lists and labels them through the i18n catalogue.
 *
 * The mechanism changed; the two ways it can go wrong did not.
 *
 *  1. A key gets added to the list with no Persian or Turkish entry. `t()`
 *     falls back to English silently, so a Persian customer reads an English
 *     line in the middle of a Persian card — and if English is missing too,
 *     `getNestedValue` returns the key, so the card advertises
 *     "billing.plans.cap.some_key". That is the CAP_LABELS_FA defect wearing
 *     new clothes, and nothing in the type system catches it: the key lists
 *     are `as const` string tuples, and `t()` accepts them.
 *
 *  2. The card promises something the plan does not grant. The old guard was
 *     MODULE_GATE; the new rule is narrower and lives in two lines of
 *     `PlanFeatureList` — a limit is shown only when it is a finite non-zero
 *     number, a feature only when its entitlement is exactly `true`. Those
 *     two lines are the whole of what stops a free plan's card from listing
 *     paid features, so they are worth pinning.
 *
 * The key lists are module-private, so the coverage test reads them out of
 * the source. That is deliberate: importing a copy would let the copy drift
 * from the list the page actually renders, which is exactly the bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router-dom';

const PLANS_TAB = 'src/pages/app/billing/PlansTab.tsx';

/** Pull an `as const` string tuple out of the page source by name. */
function keyList(name: string): string[] {
  const source = readFileSync(PLANS_TAB, 'utf8');
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (!block) throw new Error(`${name} not found in ${PLANS_TAB} — did the plan card stop using it?`);
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

describe('every key the plan card can advertise is translated in all three languages', () => {
  const CAP_KEYS = keyList('CAP_KEYS');
  const FEATURE_KEYS = keyList('FEATURE_KEYS');

  // A catalogue is a plain nested object; walk it the way `t()` does.
  async function catalogue(locale: 'en' | 'fa' | 'tr') {
    const mod = await import(`@/i18n/locales/${locale}`);
    return (mod.default ?? mod[locale] ?? Object.values(mod)[0]) as Record<string, any>;
  }
  const at = (obj: any, path: string) =>
    path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);

  it('the lists are non-empty — a silent regex miss would pass every test below', () => {
    expect(CAP_KEYS.length).toBeGreaterThan(0);
    expect(FEATURE_KEYS.length).toBeGreaterThan(0);
    expect(CAP_KEYS).toContain('max_agents');
    expect(FEATURE_KEYS).toContain('ai_assistant');
  });

  for (const locale of ['en', 'fa', 'tr'] as const) {
    it(`${locale}: has a limit label for every CAP_KEYS entry`, async () => {
      const cat = await catalogue(locale);
      const missing = CAP_KEYS.filter((k) => typeof at(cat, `billing.plans.cap.${k}`) !== 'string');
      expect(missing, `untranslated in ${locale}`).toEqual([]);
    });

    it(`${locale}: has a feature label for every FEATURE_KEYS entry`, async () => {
      const cat = await catalogue(locale);
      const missing = FEATURE_KEYS.filter((k) => typeof at(cat, `billing.plans.feat.${k}`) !== 'string');
      expect(missing, `untranslated in ${locale}`).toEqual([]);
    });
  }

  it('every limit label interpolates the number — a label without {{value}} hides the limit it names', async () => {
    const en = await catalogue('en');
    for (const k of CAP_KEYS) {
      expect(at(en, `billing.plans.cap.${k}`), k).toContain('{{value}}');
    }
  });

  it('Persian and Turkish labels are actually translated, not English copied across', async () => {
    // The fallback makes an untranslated key *look* fine in the UI, so
    // "present" is not the bar — "different from English" is.
    const [en, fa, tr] = await Promise.all([catalogue('en'), catalogue('fa'), catalogue('tr')]);
    const english = (k: string) => at(en, `billing.plans.feat.${k}`);
    for (const k of FEATURE_KEYS) {
      // Proper nouns legitimately match (Telegram, WhatsApp, SSO, API).
      const faLabel = at(fa, `billing.plans.feat.${k}`);
      if (/^[A-Za-z0-9 ./+-]+$/.test(String(english(k)))) continue;
      expect(faLabel, `fa label for ${k} is still the English string`).not.toBe(english(k));
      expect(at(tr, `billing.plans.feat.${k}`), `tr label for ${k} is still the English string`)
        .not.toBe(english(k));
    }
  });
});

// ── The render half: what the card does with a plan's limits and entitlements.

let currentLocale: 'en' | 'fa' | 'tr' = 'en';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    locale: currentLocale,
    dir: currentLocale === 'fa' ? 'rtl' : 'ltr',
    // Echo the key plus the interpolated value: enough to tell *which* key
    // rendered and *what* number it carried, without pinning copy.
    t: (k: string, p?: Record<string, unknown>) => (p?.value === undefined ? k : `${k}=${p.value}`),
  }),
}));

const billingPlans = vi.fn();
vi.mock('@/lib/billingApi', () => ({
  billingPlans: (...a: unknown[]) => billingPlans(...a),
  billingPreviewPlanChange: vi.fn(),
  billingApplyPlanChange: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PlansTab = (await import('@/pages/app/billing/PlansTab')).default;

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    name: 'Pro',
    description: null,
    monthlyPriceIrr: 1_000_000,
    yearlyPriceIrr: 10_000_000,
    aiMonthlyAllowanceIrr: 0,
    limits: {},
    entitlements: {},
    features: null,
    isFree: false,
    ...overrides,
  };
}

async function renderCard(p: ReturnType<typeof plan>) {
  billingPlans.mockResolvedValue({
    currentPlanId: null,
    currentInterval: null,
    pendingPlanId: null,
    plans: [p],
  });
  render(
    <MemoryRouter initialEntries={['/acme/billing']}>
      <PlansTab workspaceId="ws-1" canManage reloadKey={0} onChanged={() => {}} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument());
}

describe('the plan card only promises what the plan grants', () => {
  beforeEach(() => {
    currentLocale = 'en';
    billingPlans.mockReset();
    vi.clearAllMocks();
  });

  it('lists a limit the plan actually sets', async () => {
    await renderCard(plan({ limits: { max_agents: 5 } }));
    expect(screen.getByText('billing.plans.cap.max_agents=5')).toBeInTheDocument();
  });

  it('a zero limit is not advertised — 0 means "not available", not "zero of them"', async () => {
    await renderCard(plan({ limits: { max_agents: 5, max_contacts: 0 } }));
    expect(screen.getByText('billing.plans.cap.max_agents=5')).toBeInTheDocument();
    expect(screen.queryByText(/cap\.max_contacts/)).not.toBeInTheDocument();
  });

  it('a limit the plan never mentions is not advertised', async () => {
    await renderCard(plan({ limits: { max_agents: 5 } }));
    expect(screen.queryByText(/cap\.storage_gb/)).not.toBeInTheDocument();
  });

  it('a non-numeric limit is not advertised as NaN', async () => {
    await renderCard(plan({ limits: { max_agents: 5, storage_gb: 'lots' } }));
    expect(screen.queryByText(/cap\.storage_gb/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('-1 reads as unlimited, never as "-1"', async () => {
    await renderCard(plan({ limits: { max_conversations: -1 } }));
    expect(
      screen.getByText('billing.plans.cap.max_conversations=billing.plans.unlimited'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/=-1$/)).not.toBeInTheDocument();
  });

  it('a feature is listed only when its entitlement is exactly true', async () => {
    await renderCard(
      plan({ entitlements: { chat_widget: true, telegram: 'true', whatsapp: 1, sms: false } }),
    );
    expect(screen.getByText('billing.plans.feat.chat_widget')).toBeInTheDocument();
    // A truthy-but-not-true entitlement is a data error, and a card that
    // reads it loosely sells a channel the enforcement layer will refuse.
    expect(screen.queryByText(/feat\.telegram/)).not.toBeInTheDocument();
    expect(screen.queryByText(/feat\.whatsapp/)).not.toBeInTheDocument();
    expect(screen.queryByText(/feat\.sms/)).not.toBeInTheDocument();
  });

  it('a plan that grants nothing shows no "included" block at all', async () => {
    await renderCard(plan({ isFree: true, limits: {}, entitlements: {} }));
    expect(screen.queryByText('billing.plans.includedTitle')).not.toBeInTheDocument();
  });

  it('Persian formats the number in Persian digits', async () => {
    currentLocale = 'fa';
    await renderCard(plan({ limits: { max_agents: 1500 } }));
    // fa-IR grouping, not "1,500".
    expect(screen.getByText(/۱٬۵۰۰/)).toBeInTheDocument();
  });
});
