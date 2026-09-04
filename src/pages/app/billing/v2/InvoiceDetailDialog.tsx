/**
 * Invoice detail — the document the customer can actually act on.
 *
 * Payment buttons appear ONLY when the server marked the invoice payable for
 * this caller (`actions.*`). The UI never re-derives eligibility from status +
 * balance: an in-flight gateway collection, a missing permission or a frozen
 * wallet all arrive as a server-decided `blockedReason`.
 *
 * Tax and discount rows are rendered only when they are non-zero, so an
 * invoice never shows a fake "Tax: 0" line it never had.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, Wallet, CreditCard, AlertCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import {
  billingV2InvoiceDetail,
  billingV2PayInvoiceFromWallet,
  billingV2InvoiceCheckout,
  type InvoiceDetail,
} from '@/lib/billingV2Api';
import { billingDate, money, Ltr, InvoiceStatusBadge, ErrorState, errorMessage } from './shared';

export default function InvoiceDetailDialog({
  workspaceId,
  invoiceId,
  onClose,
  onPaid,
}: {
  workspaceId: string;
  invoiceId: string | null;
  onClose: () => void;
  onPaid: () => void;
}) {
  const { t, locale } = useTranslation();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!invoiceId) return;
    setLoading(true);
    setError(null);
    billingV2InvoiceDetail(workspaceId, invoiceId)
      .then(setDetail)
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setDetail(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId, workspaceId]);

  async function payFromWallet() {
    if (!invoiceId) return;
    setBusy(true);
    try {
      await billingV2PayInvoiceFromWallet(workspaceId, invoiceId);
      toast.success(t('billingV2.invoices.detail.walletPaid'));
      onPaid();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function payOnline() {
    if (!invoiceId) return;
    setBusy(true);
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}`;
      const res = await billingV2InvoiceCheckout(workspaceId, invoiceId, callbackUrl);
      const url = res.paymentUrl || res.checkoutUrl || res.url;
      if (!url) throw new Error('NO_PROVIDER_CONFIGURED');
      window.location.href = url;
    } catch (e) {
      toast.error(errorMessage(e, t));
      setBusy(false);
    }
  }

  const blocked = detail?.actions.blockedReason;

  return (
    <Dialog open={Boolean(invoiceId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('billingV2.invoices.detail.title', { number: detail?.invoice.invoiceNumber || '' })}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!loading && error && (
          <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />
        )}

        {!loading && detail && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Row label={t('billingV2.invoices.number')} value={<Ltr>{detail.invoice.invoiceNumber}</Ltr>} />
              <Row
                label={t('billingV2.common.status')}
                value={
                  <InvoiceStatusBadge
                    status={detail.invoice.status}
                    label={t(`billingV2.invoices.statuses.${detail.invoice.status}` as any)}
                  />
                }
              />
              <Row label={t('billingV2.invoices.detail.workspace')} value={detail.invoice.workspaceName || '—'} />
              <Row
                label={t('billingV2.invoices.detail.issuedAt')}
                value={billingDate(detail.invoice.issuedAt, locale)}
              />
              <Row
                label={t('billingV2.invoices.detail.dueAt')}
                value={billingDate(detail.invoice.dueAt, locale)}
              />
              {detail.invoice.paidAt && (
                <Row
                  label={t('billingV2.invoices.detail.paidAt')}
                  value={billingDate(detail.invoice.paidAt, locale)}
                />
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">{t('billingV2.invoices.detail.lines')}</p>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-2 text-start">{t('billingV2.invoices.detail.description')}</th>
                      <th className="p-2 text-start">{t('billingV2.invoices.detail.qty')}</th>
                      <th className="p-2 text-end">{t('billingV2.invoices.detail.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id} className="border-t">
                        <td className="p-2">{line.description}</td>
                        <td className="p-2">{line.quantity}</td>
                        <td className="p-2 text-end">{money(line.amountIrr, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-1.5 text-sm">
              <Total label={t('billingV2.invoices.detail.subtotal')} value={money(detail.totals.subtotalIrr, locale)} />
              {detail.totals.discountIrr > 0 && (
                <Total
                  label={t('billingV2.invoices.detail.discount')}
                  value={`- ${money(detail.totals.discountIrr, locale)}`}
                />
              )}
              {detail.totals.taxIrr > 0 && (
                <Total label={t('billingV2.invoices.detail.tax')} value={money(detail.totals.taxIrr, locale)} />
              )}
              <Separator />
              <Total
                label={t('billingV2.invoices.detail.grandTotal')}
                value={money(detail.totals.totalIrr, locale)}
                strong
              />
              <Total label={t('billingV2.invoices.detail.paid')} value={money(detail.totals.paidIrr, locale)} />
              <Total
                label={t('billingV2.invoices.detail.remaining')}
                value={money(detail.totals.dueIrr, locale)}
                strong
              />
            </div>

            {blocked === 'collection_in_progress' && (
              <p className="flex items-center gap-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-700">
                <AlertCircle className="h-4 w-4" />
                {t('billingV2.invoices.detail.collectionInProgress')}
              </p>
            )}
            {blocked === 'no_permission' && (
              <p className="text-xs text-muted-foreground">{t('billingV2.invoices.detail.noPermission')}</p>
            )}
            {blocked === 'not_payable' && (
              <p className="text-xs text-muted-foreground">{t('billingV2.invoices.detail.notPayable')}</p>
            )}

            {(detail.actions.canPayWallet || detail.actions.canPayGateway) && (
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!detail.actions.canPayWallet || busy} onClick={payFromWallet}>
                  {busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Wallet className="me-2 h-4 w-4" />}
                  {t('billingV2.invoices.detail.payWallet')}
                </Button>
                <Button variant="outline" disabled={!detail.actions.canPayGateway || busy} onClick={payOnline}>
                  <CreditCard className="me-2 h-4 w-4" />
                  {t('billingV2.invoices.detail.payGateway')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('billingV2.invoices.detail.walletBalance', {
                    amount: money(detail.actions.walletBalanceIrr, locale),
                  })}
                </span>
                {detail.actions.walletShortfallIrr > 0 && (
                  <span className="text-xs text-amber-600">
                    {t('billingV2.invoices.detail.shortfall', {
                      amount: money(detail.actions.walletShortfallIrr, locale),
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? 'font-semibold' : 'text-muted-foreground'}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
