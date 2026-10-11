/**
 * Presentation helpers for the simple billing screens. Nothing here computes
 * money; it only turns server values into labels.
 */
import type { TranslationKey } from '@/i18n';
import type { CardView } from '@/lib/accountBillingApi';
import { formatDateTime } from '@/lib/date';
import { planPriceDecimals, planPriceFactor, planPriceToDisplay } from '@/lib/planPrice';

/** Server error → translated message, with the gateway's own reason when it refused a checkout or a card. */
export function accountErrorText(e: unknown, t: (k: TranslationKey) => string): string {
  const err = e as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'CHECKOUT_PROVIDER_ERROR') {
    const details = (err?.details ?? null) as { providerMessage?: unknown } | null;
    const reason = typeof details?.providerMessage === 'string' ? details.providerMessage.trim() : '';
    const label = t('billing.account.errors.CHECKOUT_PROVIDER_ERROR');
    return reason ? `${label} ${reason}` : label;
  }
  if (code === 'CARD_DECLINED') {
    // Paddle's reason, when it gave one more precise than "declined".
    const details = (err?.details ?? null) as { code?: unknown } | null;
    const kind = cardFailureKind(typeof details?.code === 'string' ? details.code : null);
    const label = t('billing.account.errors.CARD_DECLINED');
    return kind === 'declined' ? label : `${label} ${t(`billing.account.card.failure.${kind}` as TranslationKey)}`;
  }
  if (/^[A-Z_]+$/.test(code)) {
    const key = `billing.account.errors.${code}` as TranslationKey;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return t('billing.account.errors.generic');
}

/**
 * The public app origin the gateway returns to. In development behind a
 * preview proxy it is the deployed app origin (callbacks to a temporary host
 * are refused), like the invoice payment page.
 */
export function billingReturnOrigin(): string {
  if (!import.meta.env.DEV) return window.location.origin;
  const configured = import.meta.env.VITE_PREVIEW_PROXY_ORIGIN?.trim();
  const apiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');
  const candidate = configured || apiBase?.replace('://api.', '://app.');
  if (!candidate) return window.location.origin;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

/** Quick top-up amounts per currency, in the units people read (Toman, dollars, lira). */
export const QUICK_TOPUPS: Readonly<Record<string, readonly number[]>> = {
  IRR: [200_000, 500_000, 1_000_000, 2_000_000],
  USD: [10, 25, 50, 100],
  TRY: [250, 500, 1_000, 2_500],
  EUR: [10, 25, 50, 100],
  GBP: [10, 25, 50, 100],
};

/** A stored amount as the number people type (Toman for IRR, major units elsewhere). */
export function toDisplayAmount(minor: number, currency: string): number {
  return planPriceToDisplay(minor, currency);
}

/** What people typed (Toman / major units) as stored minor units; null when not a whole minor amount. */
export function toMinorAmount(display: number, currency: string): number | null {
  if (!Number.isFinite(display) || display <= 0) return null;
  const decimals = planPriceDecimals(currency);
  const factor = planPriceFactor(currency);
  const scaled = Math.round(display * 10 ** decimals) / 10 ** decimals;
  return Math.round(scaled * factor);
}

/** The label of a gateway in this locale. */
export function gatewayLabel(displayName: Record<string, string> | null | undefined, provider: string, locale: string): string {
  const names = displayName ?? {};
  return names[locale] || names.en || names.fa || provider;
}

/** The plan's name in this locale (billing_plans.localized), else its stored name. */
export function planLabel(name: string | null, localized: Record<string, unknown> | null | undefined, locale: string): string {
  const entry = localized?.[locale];
  if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
    const n = (entry as { name: string }).name.trim();
    if (n) return n;
  }
  return name || '';
}

/**
 * Sends the customer to the checkout the server started: Paddle's overlay
 * (after the caller's own dialog is closed: two modals would fight over
 * focus and pointer events), or the gateway's payment page. Paddle failing
 * to load or open after the dialog closed goes to `onError` (a toast), since
 * the dialog that would show it is gone; `onClosed` runs when the customer
 * closes the overlay without paying.
 */
export async function followCheckout(
  started: { paymentUrl?: string; clientCheckout?: { provider: string; [key: string]: unknown } },
  options: { locale: string; closeDialog: () => void; onError?: (e: unknown) => void; onClosed?: () => void },
): Promise<void> {
  const provider = started.clientCheckout?.provider;
  if (provider === 'paddle' || provider === 'paddle_sandbox') {
    options.closeDialog();
    try {
      const { openPaddleCheckout } = await import('@/lib/paddleCheckout');
      await openPaddleCheckout(started.clientCheckout as Parameters<typeof openPaddleCheckout>[0], {
        locale: options.locale,
        ...(options.onClosed ? { onClosed: options.onClosed } : {}),
      });
    } catch (e) {
      if (!options.onError) throw e;
      options.onError(Object.assign(new Error('CHECKOUT_PROVIDER_ERROR'), {
        code: 'CHECKOUT_PROVIDER_ERROR',
        details: { providerMessage: e instanceof Error ? e.message : '' },
      }));
    }
    return;
  }
  if (!started.paymentUrl) throw Object.assign(new Error('CHECKOUT_PROVIDER_ERROR'), { code: 'CHECKOUT_PROVIDER_ERROR' });
  window.location.href = started.paymentUrl;
}

// ─── The saved card (Multi Region automatic renewal) ──────────────────────

/** Paddle's card types (payments[].method_details.card.type) as they are printed on cards. */
const CARD_BRANDS: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  american_express: 'American Express',
  discover: 'Discover',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  union_pay: 'UnionPay',
  maestro: 'Maestro',
  mada: 'mada',
};

/**
 * "Visa •••• 4242": the brand and the last four digits, as one left-to-right
 * run (FSI…PDI) so a right-to-left sentence keeps it whole and its digits
 * Latin. An unknown brand reads as "Card".
 */
export function cardLabel(card: Pick<CardView, 'brand' | 'last4'>, t: (k: TranslationKey) => string): string {
  const type = (card.brand ?? '').trim().toLowerCase();
  const brand = CARD_BRANDS[type]
    ?? (type && type !== 'unknown'
      ? type.split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : t('billing.account.card.genericBrand'));
  return `\u2068${card.last4 ? `${brand} •••• ${card.last4}` : brand}\u2069`;
}

/** "08/27", or null when Paddle did not say. */
export function cardExpiry(card: Pick<CardView, 'exp_month' | 'exp_year'>): string | null {
  if (!card.exp_month || !card.exp_year) return null;
  return `\u2068${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year % 100).padStart(2, '0')}\u2069`;
}

export type CardFailureKind = 'expired' | 'funds' | 'authentication' | 'blocked' | 'temporary' | 'declined';

/** Paddle's payment error codes (ErrorCode) grouped into what the customer can do about them. */
const CARD_FAILURE_KINDS: Readonly<Record<string, CardFailureKind>> = {
  expired_card: 'expired',
  invalid_payment_details: 'expired',
  not_enough_balance: 'funds',
  authentication_failed: 'authentication',
  blocked_card: 'blocked',
  declined_not_retryable: 'blocked',
  fraud: 'blocked',
  transaction_not_permitted: 'blocked',
  prepaid_card_not_supported: 'blocked',
  canceled: 'blocked',
  issuer_unavailable: 'temporary',
  psp_error: 'temporary',
  system_error: 'temporary',
};

export function cardFailureKind(code: string | null | undefined): CardFailureKind {
  return (code && CARD_FAILURE_KINDS[code]) || 'declined';
}

/** A server time still ahead (a freeze may end while the page is open). */
export function isFuture(iso: string | null | undefined, now = Date.now()): boolean {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at > now;
}

/** A moment with its clock time (the card is charged, plan changes resume). */
export function billingMoment(iso: string, locale: string): string {
  return formatDateTime(iso, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }, locale);
}

/** The card as it was when Paddle's overlay opened to change it, so the return can tell when the change shows. */
export type CardBefore = Pick<CardView, 'id' | 'status' | 'brand' | 'last4' | 'exp_month' | 'exp_year'>;

const cardReturnKey = (workspaceId: string) => `billing:card-return:${workspaceId}`;

export function stashCardReturn(workspaceId: string, card: CardView): void {
  const before: CardBefore = {
    id: card.id,
    status: card.status,
    brand: card.brand,
    last4: card.last4,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
  };
  try {
    window.sessionStorage.setItem(cardReturnKey(workspaceId), JSON.stringify(before));
  } catch {
    /* storage unavailable: the return still refreshes the page */
  }
}

/** The stashed card (once: it is removed), or null. */
export function takeCardReturn(workspaceId: string): CardBefore | null {
  try {
    const raw = window.sessionStorage.getItem(cardReturnKey(workspaceId));
    window.sessionStorage.removeItem(cardReturnKey(workspaceId));
    const parsed = raw ? (JSON.parse(raw) as CardBefore | null) : null;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
