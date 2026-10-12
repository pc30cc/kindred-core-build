/**
 * The printable body of one receipt: the seller and the buyer as they were
 * when the money came in, what was paid for, the amount, the VAT (only when
 * there was VAT) and the total. Everything comes from the ledger row the
 * server froze. Shown by the workspace's receipt page and by Super Admin's
 * account detail (phase 6), so both print the same document.
 */
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { LedgerEntry } from '@/lib/accountBillingApi';
import { Ltr, billingDate, money } from '../shared';
import { gatewayLabel } from './accountUi';
import { SELLER_KEYS, BILLING_PROFILE_KEYS } from '../../../../../shared/simpleBilling';

const LTR_KEYS = new Set(['economic_code', 'national_id', 'registration_number', 'vat_id', 'postal_code', 'phone', 'email', 'invoice_email', 'website']);

function PartyBlock({ title, party, keys, nameKey }: {
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
    <section className="space-y-1 text-sm">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {name && <p className="font-semibold text-foreground">{name}</p>}
      {rows.map((k) => (
        <p key={k} className="text-muted-foreground">
          <span>{t(`billing.account.profile.fields.${k}` as TranslationKey)}: </span>
          {LTR_KEYS.has(k) ? <Ltr>{String(p[k])}</Ltr> : String(p[k])}
        </p>
      ))}
    </section>
  );
}

export interface ReceiptDocumentProps {
  receipt: LedgerEntry;
  locale: string;
  dir: 'ltr' | 'rtl';
}

export default function ReceiptDocument({ receipt, locale, dir }: ReceiptDocumentProps) {
  const { t } = useTranslation();
  const currency = receipt.currency;
  const net = receipt.net_minor ?? receipt.amount_minor;
  const tax = receipt.tax_minor ?? 0;
  const purpose = typeof receipt.description?.purpose === 'string' ? receipt.description.purpose : 'topup';
  const item = purpose === 'topup'
    ? t('billing.account.receipt.itemTopup')
    : t(`billing.account.history.kinds.${purpose}` as TranslationKey);
  const providerId = typeof receipt.description?.provider === 'string' ? receipt.description.provider : '';
  const providerNames = receipt.description?.provider_name;
  const provider = providerId
    ? gatewayLabel(providerNames && typeof providerNames === 'object' ? (providerNames as Record<string, string>) : null, providerId, locale)
    : '';

  return (
    <Card className="print:border-0 print:shadow-none" dir={dir}>
      <CardContent className="space-y-6 p-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <h1 className="text-xl font-bold text-foreground">{t('billing.account.receipt.title')}</h1>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('billing.account.receipt.number')}:</dt>
              <dd className="font-medium"><Ltr>{receipt.receipt_number}</Ltr></dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('billing.account.receipt.date')}:</dt>
              <dd>{billingDate(receipt.created_at, locale)}</dd>
            </div>
          </dl>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          <PartyBlock title={t('billing.account.receipt.seller')} party={receipt.seller} keys={SELLER_KEYS} nameKey="legal_name" />
          <PartyBlock title={t('billing.account.receipt.buyer')} party={receipt.buyer} keys={BILLING_PROFILE_KEYS} nameKey="company" />
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="py-2 text-start font-medium">{t('billing.account.receipt.item')}</th>
              <th className="py-2 text-end font-medium">{t('billing.account.receipt.net')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-3">{item}</td>
              <td className="py-3 text-end tabular-nums">{money(net, locale, currency)}</td>
            </tr>
          </tbody>
          <tfoot>
            {receipt.tax_percent !== null && tax > 0 && (
              <tr>
                <td className="py-2 text-muted-foreground">
                  {t('billing.account.receipt.vat', { percent: String(receipt.tax_percent) })}
                </td>
                <td className="py-2 text-end tabular-nums">{money(tax, locale, currency)}</td>
              </tr>
            )}
            <tr className="font-semibold">
              <td className="py-2">{t('billing.account.receipt.total')}</td>
              <td className="py-2 text-end tabular-nums">{money(net + tax, locale, currency)}</td>
            </tr>
          </tfoot>
        </table>

        {provider && (
          <p className="text-xs text-muted-foreground">
            {t('billing.account.receipt.paidWith')}: <bdi>{provider}</bdi>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
