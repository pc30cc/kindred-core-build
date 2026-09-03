/**
 * Transactions — the payment *attempt* history, not the invoice list.
 *
 * A single invoice can produce many attempts (abandoned gateway trip, retry,
 * final success). Statuses come already collapsed from the server, where the
 * settlement record always wins over the intent's own state; a payment that
 * settled but has not reconciled shows as "needs review" rather than a
 * confident success.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SkeletonTable } from '@/components/common/Skeletons';
import { useTranslation } from '@/i18n';
import { billingV2Transactions, type TransactionRow } from '@/lib/billingV2Api';
import { billingDate, money, Ltr, ErrorState, EmptyState, Pager, errorMessage } from './shared';

function statusVariant(status: string, needsReview?: boolean) {
  if (needsReview) return 'outline' as const;
  if (status === 'succeeded') return 'default' as const;
  if (status === 'failed' || status === 'expired') return 'destructive' as const;
  return 'secondary' as const;
}

export default function TransactionsTab({ workspaceId, reloadKey }: { workspaceId: string; reloadKey: number }) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    billingV2Transactions(workspaceId, { page, pageSize: 10 })
      .then((res) => {
        setRows(res.transactions);
        setTotal(res.total);
        setPageSize(res.pageSize);
      })
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, page, reloadKey]);

  return (
    <Card>
      <CardContent className="pt-6">
        {loading && <SkeletonTable rows={5} />}
        {!loading && error && <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />}
        {!loading && !error && rows.length === 0 && <EmptyState message={t('billingV2.transactions.empty')} />}

        {!loading && !error && rows.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="p-2 text-start">{t('billingV2.transactions.date')}</th>
                    <th className="p-2 text-start">{t('billingV2.transactions.type')}</th>
                    <th className="p-2 text-start">{t('billingV2.transactions.reference')}</th>
                    <th className="p-2 text-start">{t('billingV2.common.status')}</th>
                    <th className="p-2 text-end">{t('billingV2.transactions.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="p-2">{billingDate(row.createdAt, locale)}</td>
                      <td className="p-2">{t(`billingV2.transactions.types.${row.purchaseType}` as any)}</td>
                      <td className="p-2">{row.reference ? <Ltr>{row.reference}</Ltr> : '—'}</td>
                      <td className="p-2">
                        <Badge variant={statusVariant(row.status, row.needsReview)}>
                          {row.needsReview
                            ? t('billingV2.transactions.statuses.needs_review')
                            : t(`billingV2.transactions.statuses.${row.status}` as any)}
                        </Badge>
                      </td>
                      <td className="p-2 text-end font-medium">{money(row.amountIrr, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {rows.map((row) => (
                <div key={row.id} className="rounded-lg border p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {t(`billingV2.transactions.types.${row.purchaseType}` as any)}
                    </span>
                    <Badge variant={statusVariant(row.status, row.needsReview)}>
                      {row.needsReview
                        ? t('billingV2.transactions.statuses.needs_review')
                        : t(`billingV2.transactions.statuses.${row.status}` as any)}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{billingDate(row.createdAt, locale)}</span>
                    <span className="font-semibold text-foreground">{money(row.amountIrr, locale)}</span>
                  </div>
                  {row.reference && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Ltr>{row.reference}</Ltr>
                    </p>
                  )}
                </div>
              ))}
            </div>

            <Pager
              page={page}
              pageSize={pageSize}
              total={total}
              onPage={setPage}
              labels={{
                page: t('billingV2.common.page', { page, pages: Math.max(1, Math.ceil(total / pageSize)) }),
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
