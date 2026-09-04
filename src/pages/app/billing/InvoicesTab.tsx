/**
 * Invoices — the obligation list (what the workspace owes or has settled).
 * Payment attempts live in the Transactions tab; these two are never mixed.
 *
 * Desktop renders a table, mobile renders cards; both read the same
 * server-paginated response and the same translated status labels.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SkeletonTable } from '@/components/common/Skeletons';
import { useTranslation } from '@/i18n';
import { billingV2Invoices, type InvoiceSummary } from '@/lib/billingV2Api';
import { billingDate, money, Ltr, InvoiceStatusBadge, ErrorState, EmptyState, Pager, errorMessage } from './shared';

const FILTERS = ['all', 'open', 'paid', 'past_due', 'void', 'expired'] as const;

export default function InvoicesTab({
  workspaceId,
  reloadKey,
  onOpenInvoice,
}: {
  workspaceId: string;
  reloadKey: number;
  onOpenInvoice: (invoiceId: string) => void;
}) {
  const { t, locale } = useTranslation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ invoices: InvoiceSummary[]; total: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    billingV2Invoices(workspaceId, { filter, page, pageSize: 10 })
      .then((res) => setData({ invoices: res.invoices, total: res.total, pageSize: res.pageSize }))
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, filter, page, reloadKey]);

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-4 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'outline'}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
            >
              {t(`billingV2.invoices.filters.${f}` as any)}
            </Button>
          ))}
        </div>

        {loading && <SkeletonTable rows={5} />}
        {!loading && error && <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />}
        {!loading && !error && data && data.invoices.length === 0 && (
          <EmptyState message={t('billingV2.invoices.empty')} />
        )}

        {!loading && !error && data && data.invoices.length > 0 && (
          <>
            {/* Desktop */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="p-2 text-start">{t('billingV2.invoices.number')}</th>
                    <th className="p-2 text-start">{t('billingV2.invoices.plan')}</th>
                    <th className="p-2 text-start">{t('billingV2.invoices.issued')}</th>
                    <th className="p-2 text-start">{t('billingV2.invoices.dueDate')}</th>
                    <th className="p-2 text-start">{t('billingV2.common.status')}</th>
                    <th className="p-2 text-end">{t('billingV2.invoices.total')}</th>
                    <th className="p-2 text-end">{t('billingV2.invoices.due')}</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((inv) => (
                    <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="p-2"><Ltr>{inv.invoiceNumber}</Ltr></td>
                      <td className="p-2">{inv.planName || '—'}</td>
                      <td className="p-2">{billingDate(inv.issuedAt, locale)}</td>
                      <td className="p-2">{billingDate(inv.dueAt, locale)}</td>
                      <td className="p-2">
                        <InvoiceStatusBadge
                          status={inv.status}
                          label={t(`billingV2.invoices.statuses.${inv.status}` as any)}
                        />
                      </td>
                      <td className="p-2 text-end">{money(inv.totalIrr, locale)}</td>
                      <td className="p-2 text-end font-medium">{money(inv.amountDueIrr, locale)}</td>
                      <td className="p-2 text-end">
                        <Button variant="ghost" size="sm" onClick={() => onOpenInvoice(inv.id)}>
                          {t('billingV2.common.view')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile */}
            <div className="space-y-3 md:hidden">
              {data.invoices.map((inv) => (
                <button
                  key={inv.id}
                  onClick={() => onOpenInvoice(inv.id)}
                  className="w-full rounded-lg border p-3 text-start transition-colors hover:bg-muted/40"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Ltr>{inv.invoiceNumber}</Ltr>
                    <InvoiceStatusBadge
                      status={inv.status}
                      label={t(`billingV2.invoices.statuses.${inv.status}` as any)}
                    />
                  </div>
                  <p className="text-sm font-medium">{inv.planName || '—'}</p>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{billingDate(inv.dueAt, locale)}</span>
                    <span className="font-semibold text-foreground">{money(inv.amountDueIrr, locale)}</span>
                  </div>
                </button>
              ))}
            </div>

            <Pager
              page={page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
              labels={{
                page: t('billingV2.common.page', {
                  page,
                  pages: Math.max(1, Math.ceil(data.total / data.pageSize)),
                }),
                prev: t('billingV2.common.prev'),
                next: t('billingV2.common.next'),
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
