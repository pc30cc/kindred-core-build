/**
 * AI credit packs' shared rules (shared/aiPacks.ts, phase 5): what Super
 * Admin may save (decision D16), which packs are offered, and how the AI
 * wallet (IRR) is shown in the account currency.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PACK_CURRENCIES,
  AI_PACK_LIMITS,
  activePacks,
  bonusPercent,
  creditToWallet,
  currencyExponent,
  packLabel,
  validateAiPacks,
  walletToMinor,
} from '../../../../shared/aiPacks';
import { LEDGER_KINDS, TOPUP_LIMITS } from '../../../../shared/simpleBilling';

const pack = (over: Record<string, unknown> = {}) => ({ id: 'm', price_minor: 2000, credit_minor: 2200, ...over });

describe('validateAiPacks', () => {
  it('normalises: every edition currency present, active explicit, labels trimmed and empty ones dropped', () => {
    const res = validateAiPacks({ USD: [pack({ label: { en: '  Medium ', fa: '  ', tr: undefined } })] }, 'international');
    expect(res).toEqual({
      ok: true,
      packs: { USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200, active: true, label: { en: 'Medium' } }], TRY: [] },
    });
    const off = validateAiPacks({ USD: [pack({ active: false })] }, 'international');
    expect(off.ok && off.packs.USD[0].active).toBe(false);
  });

  it('per edition currencies: Iran IRR only; abroad USD and TRY', () => {
    expect(AI_PACK_CURRENCIES).toEqual({ iran: ['IRR'], international: ['USD', 'TRY'] });
    expect(validateAiPacks({ USD: [pack()] }, 'iran')).toMatchObject({ ok: false, error: 'AI_PACKS_INVALID', field: 'USD', reason: 'currency' });
    expect(validateAiPacks({ IRR: [pack({ price_minor: 2_000_000 })] }, 'international')).toMatchObject({ ok: false, field: 'IRR' });
    expect(validateAiPacks({}, 'iran')).toEqual({ ok: true, packs: { IRR: [] } });
  });

  it('refuses a duplicate id in a currency (the same id in two currencies is fine)', () => {
    expect(validateAiPacks({ USD: [pack(), pack({ price_minor: 5000 })] }, 'international'))
      .toMatchObject({ ok: false, field: 'USD.1.id', reason: 'duplicate' });
    expect(validateAiPacks({ USD: [pack()], TRY: [pack({ price_minor: 20_000 })] }, 'international').ok).toBe(true);
  });

  it('ids: lowercase letters, digits, _ and -, starting with a letter or digit, at most 24', () => {
    for (const id of ['s', 'p1', 'big_pack-2', 'a'.repeat(24)]) {
      expect(validateAiPacks({ USD: [pack({ id })] }, 'international').ok, id).toBe(true);
    }
    for (const id of ['', '-x', 'Big', 'a b', 'a'.repeat(25), 5]) {
      expect(validateAiPacks({ USD: [pack({ id })] }, 'international'), String(id)).toMatchObject({ ok: false, field: 'USD.0.id' });
    }
  });

  it('IRR prices are whole Toman (a multiple of 10 Rial)', () => {
    expect(validateAiPacks({ IRR: [pack({ price_minor: 2_000_000 })] }, 'iran').ok).toBe(true);
    expect(validateAiPacks({ IRR: [pack({ price_minor: 2_000_005 })] }, 'iran')).toMatchObject({ ok: false, field: 'IRR.0.price_minor' });
    // Not a rule for cents.
    expect(validateAiPacks({ USD: [pack({ price_minor: 2005 })] }, 'international').ok).toBe(true);
  });

  it('price: an integer from 1 to the top-up maximum; credit: an integer from 1 to 10^12', () => {
    const max = TOPUP_LIMITS.USD.max;
    expect(validateAiPacks({ USD: [pack({ price_minor: max })] }, 'international').ok).toBe(true);
    for (const price_minor of [0, -1, 1.5, max + 1, '2000', null]) {
      expect(validateAiPacks({ USD: [pack({ price_minor })] }, 'international'), String(price_minor))
        .toMatchObject({ ok: false, field: 'USD.0.price_minor', reason: 'invalid' });
    }
    expect(validateAiPacks({ USD: [pack({ credit_minor: AI_PACK_LIMITS.maxCreditMinor })] }, 'international').ok).toBe(true);
    for (const credit_minor of [0, 2.5, AI_PACK_LIMITS.maxCreditMinor + 1, undefined]) {
      expect(validateAiPacks({ USD: [pack({ credit_minor })] }, 'international'), String(credit_minor))
        .toMatchObject({ ok: false, field: 'USD.0.credit_minor' });
    }
  });

  it('labels: fa/en/tr only, strings of at most 40 characters', () => {
    expect(validateAiPacks({ USD: [pack({ label: { de: 'x' } })] }, 'international')).toMatchObject({ ok: false, field: 'USD.0.label.de' });
    expect(validateAiPacks({ USD: [pack({ label: { en: 'x'.repeat(41) } })] }, 'international')).toMatchObject({ ok: false, field: 'USD.0.label.en' });
    expect(validateAiPacks({ USD: [pack({ label: { en: 5 } })] }, 'international')).toMatchObject({ ok: false, field: 'USD.0.label.en' });
    expect(validateAiPacks({ USD: [pack({ label: 'x' })] }, 'international')).toMatchObject({ ok: false, field: 'USD.0.label' });
    expect(validateAiPacks({ IRR: [pack({ price_minor: 2_000_000, label: { fa: 'بسته‌ی کوچک' } })] }, 'iran').ok).toBe(true);
  });

  it('at most 8 packs per currency', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => pack({ id: `p${i + 1}` }));
    expect(validateAiPacks({ USD: list(8) }, 'international').ok).toBe(true);
    expect(validateAiPacks({ USD: list(9) }, 'international')).toMatchObject({ ok: false, field: 'USD', reason: 'too_many' });
  });

  it('refuses shapes that are not lists of packs', () => {
    expect(validateAiPacks(null, 'iran')).toMatchObject({ ok: false, field: 'packs' });
    expect(validateAiPacks({ IRR: {} }, 'iran')).toMatchObject({ ok: false, field: 'IRR' });
    expect(validateAiPacks({ IRR: ['x'] }, 'iran')).toMatchObject({ ok: false, field: 'IRR.0' });
    expect(validateAiPacks({ USD: [pack({ active: 'yes' })] }, 'international')).toMatchObject({ ok: false, field: 'USD.0.active' });
  });
});

describe('activePacks', () => {
  it('offers the active, well formed packs of a currency in their saved order', () => {
    const stored = {
      USD: [
        pack({ id: 'b', price_minor: 5000, credit_minor: 6000 }),
        pack({ id: 'off', active: false }),
        { id: 'bad', price_minor: '100', credit_minor: 100 },
        pack({ id: 'a', label: { en: ' Small ', fa: '' } }),
        pack({ id: 'a', price_minor: 1 }),
        'junk',
      ],
    };
    expect(activePacks(stored, 'usd')).toEqual([
      { id: 'b', price_minor: 5000, credit_minor: 6000, active: true },
      { id: 'a', price_minor: 2000, credit_minor: 2200, active: true, label: { en: 'Small' } },
    ]);
    expect(activePacks(stored, 'TRY')).toEqual([]);
    expect(activePacks(null, 'USD')).toEqual([]);
    expect(activePacks({ USD: 'x' }, 'USD')).toEqual([]);
  });
});

describe('amounts', () => {
  it('walletToMinor rounds down to the currency minor unit; null without a rate', () => {
    // USD at 600,000 Rial per dollar: 3,000,000 Rial is $5.00.
    expect(walletToMinor(3_000_000, 600_000, 'USD')).toBe(500);
    // 3,005,999 Rial is $5.0099…: shown as $5.00, never more than there is.
    expect(walletToMinor(3_005_999, 600_000, 'USD')).toBe(500);
    expect(walletToMinor(3_006_000, 600_000, 'USD')).toBe(501);
    // Rial is shown as Rial (the page turns it into Toman).
    expect(walletToMinor(1_234_567.9, 1, 'IRR')).toBe(1_234_567);
    expect(walletToMinor(0, 600_000, 'USD')).toBe(0);
    expect(walletToMinor(-5, 1, 'IRR')).toBe(0);
    expect(walletToMinor(100, null, 'USD')).toBeNull();
    expect(walletToMinor(100, 0, 'USD')).toBeNull();
    // Binary noise does not lose a cent: 0.29 * 100 is 28.999… in floating point.
    expect(walletToMinor(0.29, 1, 'USD')).toBe(29);
  });

  it('creditToWallet is what the SQL adds to the AI wallet', () => {
    expect(creditToWallet(500, 600_000, 'USD')).toBe(3_000_000);
    expect(creditToWallet(2_000_000, 1, 'IRR')).toBe(2_000_000);
    expect(creditToWallet(500, null, 'USD')).toBeNull();
  });

  it('bonusPercent: the credit over the price, in whole percent rounded down', () => {
    expect(bonusPercent({ price_minor: 2000, credit_minor: 2200 })).toBe(10);
    expect(bonusPercent({ price_minor: 3000, credit_minor: 3100 })).toBe(3);
    expect(bonusPercent({ price_minor: 2000, credit_minor: 2000 })).toBe(0);
    expect(bonusPercent({ price_minor: 2000, credit_minor: 1500 })).toBe(0);
    expect(bonusPercent({ price_minor: 0, credit_minor: 1500 })).toBe(0);
  });

  it('currencyExponent: IRR whole Rial, the rest cents', () => {
    expect(currencyExponent('IRR')).toBe(0);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('TRY')).toBe(2);
  });

  it('packLabel: the label in the language, else the fallback', () => {
    const p = { label: { fa: 'بسته‌ی کوچک', en: 'Small' } };
    expect(packLabel(p, 'fa', 'x')).toBe('بسته‌ی کوچک');
    expect(packLabel(p, 'en-US', 'x')).toBe('Small');
    expect(packLabel(p, 'tr', '$5.00')).toBe('$5.00');
    expect(packLabel(null, 'en', 'x')).toBe('x');
  });

  it('the ledger knows the pack return kind', () => {
    expect(LEDGER_KINDS).toContain('ai_pack');
    expect(LEDGER_KINDS).toContain('ai_pack_return');
  });
});
