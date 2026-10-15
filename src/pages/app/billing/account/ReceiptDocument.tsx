/**
 * The printable body of one receipt: the seller and the buyer as they were
 * when the money came in, what was paid for, the amount, the VAT (only when
 * there was VAT) and the total. Everything comes from the ledger row the
 * server froze. Shown by the workspace's receipt page and by Super Admin's
 * account detail (phase 6), so both print the same document.
 *
 * It is drawn as a sheet of paper in the brand's colours: always light, in the
 * app's dark mode too and on paper, with the edition's logo at its head
 * (RESPOK's horizontal logo abroad, WebYar's Persian logotype in Iran, the app
 * mark and name before the edition is known).
 */
import type { CSSProperties, ReactNode } from 'react';
import { BadgeCheck } from 'lucide-react';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { LedgerEntry } from '@/lib/accountBillingApi';
import { useBrandTokens } from '@/lib/brand';
import { INTL_BRAND, useInternationalMode } from '@/lib/internationalMode';
import { WEBYAR_BRAND, useWebyarKit } from '@/lib/webyarBrand';
import { SHIPS_IRAN_KIT } from '../../../../../shared/buildBrand';
import { Ltr, billingDate, money } from '../shared';
import { gatewayLabel } from './accountUi';
import { SELLER_KEYS, BILLING_PROFILE_KEYS } from '../../../../../shared/simpleBilling';
import { isPaddleProvider } from '../../../../../shared/testGateways';

const LTR_KEYS = new Set(['economic_code', 'national_id', 'registration_number', 'vat_id', 'postal_code', 'phone', 'email', 'invoice_email', 'website']);

/** The brand kits' accent colours (shared/webyarBrand.ts, RESPOK's logo). */
const RESPOK_ACCENT = '#FF5A3C';

/**
 * On the screen, and on paper: the customer page has no print view of its
 * own, so printing shows only the sheet (the admin dialog adds its own rules).
 */
const RECEIPT_SHEET_CSS = `@media print {
  @page { margin: 12mm; }
  body * { visibility: hidden !important; }
  [data-receipt-sheet], [data-receipt-sheet] * { visibility: visible !important; }
  [data-receipt-sheet] { position: absolute !important; inset-inline: 0 !important; top: 0 !important; margin: 0 !important; }
  [data-receipt-sheet], [data-receipt-sheet] * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

function BrandHead({ international, kit }: { international: boolean; kit: boolean }) {
  const { locale } = useTranslation();
  const { brand } = useBrandTokens(locale);
  if (international) {
    return <img src={INTL_BRAND.horizontal.light} alt={brand} className="h-10 w-auto" draggable={false} data-receipt-logo="intl" />;
  }
  if (SHIPS_IRAN_KIT && kit) {
    return <img src={WEBYAR_BRAND.logo.light} alt={WEBYAR_BRAND.name} className="h-11 w-auto" draggable={false} data-receipt-logo="webyar" />;
  }
  return (
    <div className="flex items-center gap-3" data-receipt-logo="app">
      <BrandLogo className="h-10 w-10 rounded-xl" />
      <span className="text-lg font-bold tracking-tight">{brand}</span>
    </div>
  );
}

function PartyCard({ title, party, keys, nameKey }: {
  title: string;
  party: Record<string, unknown> | null;
  keys: readonly string[];
  nameKey: string;
}) {
  const { t } = useTranslation();
  const p = party ?? {};
  const name = typeof p[nameKey] === 'string' && p[nameKey] ? String(p[nameKey]) : typeof p.workspace_name === 'string' ? String(p.workspace_name) : '';
  const rows = keys.filter((k) => k !== nameKey && typeof p[k] === 'string' && p[k]);
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--receipt-accent)]">{title}</h2>
      {name ? <p className="mb-1 text-base font-semibold text-slate-900">{name}</p> : <p className="text-slate-400">—</p>}
      <div className="space-y-0.5">
        {rows.map((k) => (
          <p key={k} className="text-slate-600">
            <span className="text-slate-500">{t(`billing.account.profile.fields.${k}` as TranslationKey)}: </span>
            {LTR_KEYS.has(k) ? <Ltr>{String(p[k])}</Ltr> : String(p[k])}
          </p>
        ))}
      </div>
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-end gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{children}</dd>
    </div>
  );
}

export interface ReceiptDocumentProps {
  receipt: LedgerEntry;
  locale: string;
  dir: 'ltr' | 'rtl';
}

export default function ReceiptDocument({ receipt, locale, dir }: ReceiptDocumentProps) {
  const { t } = useTranslation();
  const { siteUrl, supportEmail } = useBrandTokens(locale);
  const international = useInternationalMode();
  const kit = useWebyarKit() && !international;
  const accent = international ? RESPOK_ACCENT : SHIPS_IRAN_KIT && kit ? WEBYAR_BRAND.themeColor : 'hsl(var(--primary))';

  const currency = receipt.currency;
  const net = receipt.net_minor ?? receipt.amount_minor;
  const tax = receipt.tax_minor ?? 0;
  const total = net + tax;
  const purpose = typeof receipt.description?.purpose === 'string' ? receipt.description.purpose : 'topup';
  const item = purpose === 'topup'
    ? t('billing.account.receipt.itemTopup')
    : t(`billing.account.history.kinds.${purpose}` as TranslationKey);
  const planName = typeof receipt.plan_name === 'string' && receipt.plan_name ? receipt.plan_name : '';
  const period = receipt.period_start && receipt.period_end
    ? `${billingDate(receipt.period_start, locale)} – ${billingDate(receipt.period_end, locale)}`
    : '';
  const providerId = typeof receipt.description?.provider === 'string' ? receipt.description.provider : '';
  const providerNames = receipt.description?.provider_name;
  const provider = providerId
    ? gatewayLabel(providerNames && typeof providerNames === 'object' ? (providerNames as Record<string, string>) : null, providerId, locale)
    : '';
  const site = siteUrl ? siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';

  return (
    <article
      dir={dir}
      data-receipt-sheet=""
      style={{ '--receipt-accent': accent } as CSSProperties}
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl shadow-slate-900/5 print:rounded-none print:border-0 print:shadow-none"
    >
      <style>{RECEIPT_SHEET_CSS}</style>
      {/* The brand's band across the top of the sheet. */}
      <div className="h-2 w-full bg-[var(--receipt-accent)]" aria-hidden />
      <div className="h-1 w-full bg-[var(--receipt-accent)] opacity-30" aria-hidden />

      <div className="space-y-8 p-6 sm:p-10">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="space-y-2">
            <BrandHead international={international} kit={kit} />
            {site && <p className="text-xs text-slate-500"><bdi dir="ltr">{site}</bdi></p>}
          </div>
          <div className="space-y-3 text-end">
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{t('billing.account.receipt.title')}</h1>
            <dl className="space-y-1 text-sm">
              <Meta label={t('billing.account.receipt.number')}><Ltr>{receipt.receipt_number}</Ltr></Meta>
              <Meta label={t('billing.account.receipt.date')}>{billingDate(receipt.created_at, locale)}</Meta>
            </dl>
          </div>
        </header>

        {/* The amount at a glance, stamped paid. */}
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[color-mix(in_srgb,var(--receipt-accent)_8%,white)] p-5 sm:p-6">
          <div className="space-y-1">
            <p className="text-sm text-slate-600">{t('billing.account.receipt.total')}</p>
            <p className="text-3xl font-extrabold tabular-nums tracking-tight text-[var(--receipt-accent)] sm:text-4xl">{money(total, locale, currency)}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-emerald-600 px-4 py-1.5 text-sm font-bold uppercase tracking-wider text-emerald-700" data-receipt-paid="">
            <BadgeCheck className="h-4 w-4" aria-hidden />
            {t('billing.account.receipt.paid')}
          </span>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <PartyCard title={t('billing.account.receipt.seller')} party={receipt.seller} keys={SELLER_KEYS} nameKey="legal_name" />
          <PartyCard title={t('billing.account.receipt.buyer')} party={receipt.buyer} keys={BILLING_PROFILE_KEYS} nameKey="company" />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="px-4 py-3 text-start text-xs font-semibold uppercase tracking-wider">{t('billing.account.receipt.item')}</th>
                <th className="px-4 py-3 text-end text-xs font-semibold uppercase tracking-wider">{t('billing.account.receipt.net')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-200">
                <td className="px-4 py-4 align-top">
                  <p className="font-medium text-slate-900">{planName ? `${item} · ${planName}` : item}</p>
                  {period && <p className="mt-1 text-xs text-slate-500">{t('billing.account.receipt.period')}: {period}</p>}
                </td>
                <td className="px-4 py-4 text-end align-top font-medium tabular-nums">{money(net, locale, currency)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex justify-end">
          <dl className="w-full space-y-2 text-sm sm:w-80">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{t('billing.account.receipt.net')}</dt>
              <dd className="tabular-nums">{money(net, locale, currency)}</dd>
            </div>
            {receipt.tax_percent !== null && tax > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('billing.account.receipt.vat', { percent: String(receipt.tax_percent) })}</dt>
                <dd className="tabular-nums">{money(tax, locale, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t-2 border-slate-900 pt-3 text-base font-bold">
              <dt>{t('billing.account.receipt.total')}</dt>
              <dd className="tabular-nums text-[var(--receipt-accent)]">{money(total, locale, currency)}</dd>
            </div>
          </dl>
        </div>

        <footer className="space-y-4 border-t border-dashed border-slate-300 pt-6 text-xs text-slate-500">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {provider && (
              <p>{t('billing.account.receipt.paidWith')}: <bdi className="font-medium text-slate-700">{provider}</bdi></p>
            )}
            {receipt.payment_id && (
              <p>{t('billing.account.receipt.reference')}: <Ltr>{receipt.payment_id}</Ltr></p>
            )}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-800">{t('billing.account.receipt.thanks')}</p>
              <p>{t('billing.account.receipt.electronic')}</p>
              {/* Paddle is the merchant of record: the buyer's tax was added on top
                  and is on Paddle's own invoice, never in this account's credit. */}
              {isPaddleProvider(providerId) && <p data-receipt-paddle-tax="">{t('billing.account.receipt.paddleTax')}</p>}
            </div>
            {(site || supportEmail) && (
              <p className="flex flex-wrap gap-x-3 text-slate-400">
                {site && <bdi dir="ltr">{site}</bdi>}
                {supportEmail && <bdi dir="ltr">{supportEmail}</bdi>}
              </p>
            )}
          </div>
        </footer>
      </div>
    </article>
  );
}
