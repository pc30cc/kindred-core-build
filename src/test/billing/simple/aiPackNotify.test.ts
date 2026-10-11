/**
 * The mails after a pack paid online (services/billing/account/effects.ts,
 * phase 5): a settled 'ai_pack' payment sends its receipt, then
 * billing_ai_pack_purchased, never a plan mail and never entitlements. A
 * pack that could not be bought (it changed; the money stays in the balance)
 * sends the receipt only; a replayed purchase sends no pack mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const PAY = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  mails: [] as Array<{ slug: string; vars: Record<string, string> }>,
  afterPlanChange: vi.fn(async (..._a: unknown[]) => undefined),
  warn: vi.fn(),
  label: { fa: 'بسته‌ی بزرگ', en: 'Large' } as Record<string, string> | null,
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) b[m] = () => b;
      b.maybeSingle = async () => {
        if (table === 'billing_account_payments') {
          return { data: { workspace_id: WS, currency: 'IRR', amount_minor: 22_000_000, source: 'checkout', review: null, card_id: null }, error: null };
        }
        if (table === 'billing_account_ledger') return { data: { description: h.label ? { label: h.label } : {} }, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'workspace_ai_balance_lots' ? [{ source_type: 'PURCHASED', remaining_amount: 20_000_000, reserved_amount: 0, expires_at: null }] : null, error: null });
      return b;
    },
    rpc: async (name: string) => (name === 'billing_ai_wallet_rate' ? { data: 1, error: null } : { data: null, error: null }),
  }),
}));
vi.mock('../../../../server/services/ai-billing/mode.js', () => ({ getBillingMode: async () => 'ENFORCED' }));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  getBillingRegion: async () => ({ edition: 'iran', regionMode: 'iran', currency: 'IRR' }),
}));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccount: async () => ({ workspace_id: WS, currency: 'IRR', balance_minor: 0 }),
  getBillingSettings: async () => ({ edition: 'iran', seller: {}, vat_percent: {}, receipt_prefix: 'R', ai_packs: {} }),
}));
vi.mock('../../../../server/services/billing/account/plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/plans.js')>()),
  afterPlanChange: h.afterPlanChange,
}));
vi.mock('../../../../server/services/billing/account/notify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../server/services/billing/account/notify.js')>();
  return {
    ...real,
    sendBillingEmail: async (_c: unknown, _ws: string, slug: string, build: (ctx: unknown) => Record<string, string>) => {
      const ctx = {
        edition: 'iran',
        locale: 'fa',
        money: (minor: number | null | undefined, currency: string) => (minor == null ? '' : real.formatBillingMoney('iran', 'fa', currency, minor)),
        date: (iso: string) => iso,
        number: (n: number) => String(n),
      };
      h.mails.push({ slug, vars: build(ctx) });
      return { sent: true };
    },
  };
});

const { afterAccountSettlement } = await import('../../../../server/services/billing/account/effects.js');

const PURCHASED = {
  action: 'ai_pack', replayed: false, pack_ledger_id: 'led-1', lot_id: 'lot-1', pack_id: 'l',
  price_minor: 20_000_000, credit_minor: 20_000_000, currency: 'IRR', wallet_amount: 20_000_000, balance_minor: 0,
};
const settled = (purpose_result: Record<string, unknown> | null) => ({
  replayed: false, ledger_id: 'led-topup', payment_id: PAY, receipt_number: 'R-12', balance_minor: 0, purpose: 'ai_pack', purpose_result,
});

beforeEach(() => {
  h.mails.length = 0;
  h.afterPlanChange.mockClear();
  h.warn.mockReset();
  h.label = { fa: 'بسته‌ی بزرگ', en: 'Large' };
  vi.spyOn(console, 'warn').mockImplementation(h.warn);
});

describe('a pack paid online', () => {
  it('sends the receipt, then the pack mail in the mail\'s language and Toman; no plan mail', async () => {
    await afterAccountSettlement({} as never, settled(PURCHASED));
    expect(h.mails.map((m) => m.slug)).toEqual(['billing_payment_receipt', 'billing_ai_pack_purchased']);
    expect(h.mails[1].vars).toEqual({
      pack_name: 'بسته‌ی بزرگ',
      credit: '۲٬۰۰۰٬۰۰۰ تومان',
      amount: '۲٬۰۰۰٬۰۰۰ تومان',
      balance: '۰ تومان',
      ai_balance: '۲٬۰۰۰٬۰۰۰ تومان',
    });
    expect(h.afterPlanChange).not.toHaveBeenCalled();
  });

  it('a pack with no name in the mail\'s language is named generically, not by its credit (the body follows with {credit})', async () => {
    for (const label of [null, { en: 'Large' }]) {
      h.mails.length = 0;
      h.label = label;
      await afterAccountSettlement({} as never, settled(PURCHASED));
      expect(h.mails[1].vars.pack_name).toBe('بسته‌ی اعتبار هوش مصنوعی');
      expect(h.mails[1].vars.credit).toBe('۲٬۰۰۰٬۰۰۰ تومان');
    }
  });

  it('a pack that could not be bought: the receipt only (the money stays in the balance), logged', async () => {
    await afterAccountSettlement({} as never, settled({ error: 'billing_quote_changed' }));
    expect(h.mails.map((m) => m.slug)).toEqual(['billing_payment_receipt']);
    expect(h.afterPlanChange).not.toHaveBeenCalled();
    expect(String(h.warn.mock.calls[0]?.[0])).toContain('ai_pack could not be bought: billing_quote_changed');
  });

  it('a purchase the settlement replayed sends no pack mail', async () => {
    await afterAccountSettlement({} as never, settled({ ...PURCHASED, replayed: true }));
    expect(h.mails.map((m) => m.slug)).toEqual(['billing_payment_receipt']);
  });

  it('a replayed settlement sends nothing', async () => {
    await afterAccountSettlement({} as never, { ...settled(PURCHASED), replayed: true });
    expect(h.mails).toEqual([]);
  });
});
