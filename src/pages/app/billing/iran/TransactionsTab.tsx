/**
 * Transactions tab — Persian status mapping, no raw backend enums, no provider
 * name in the main table (only in the detail view).
 *
 * The history shows BOTH settled payments and unpaid attempts (abandoned at
 * the gateway, canceled by the customer, failed, expired). A customer who
 * started a checkout and walked away must be able to see that attempt with an
 * accurate explanation instead of an empty list.
 */
import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Receipt } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatToman } from '@/lib/money';
import { jalaliDate, mapPaymentStatus, type TxStatus } from './format';

const STATUS_STYLE: Record<TxStatus, string> = {
  succeeded: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  failed: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  refunded: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  canceled: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
};

interface Row {
  id: string;
  created_at: string;
  amount: number;
  status: string | null;
  provider_name?: string | null;
  metadata?: any;
  invoice_number?: string | null;
  action_type?: string | null;
  purchase_type?: string | null;
  plan_name_snapshot?: string | null;
  billing_interval?: string | null;
  paid?: boolean;
}

interface AttemptRow {
  id: string;
  created_at: string;
  amount_irr: number;
  status: string;
  provider_name?: string | null;
  invoice_number?: string | null;
  action_type?: string | null;
  purchase_type?: string | null;
  billing_interval?: string | null;
  metadata?: any;
  billing_plans?: { name?: string } | null;
}

export default function TransactionsTab({
  payments, attempts = [], currentPlanName,
}: { payments: Row[]; attempts?: AttemptRow[]; currentPlanName?: string }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Row | null>(null);

  const rows = useMemo<Row[]>(() => {
    const settled: Row[] = (payments || []).map((p) => ({ ...p, paid: true }));
    const unpaid: Row[] = (attempts || []).map((a) => ({
      id: a.id,
      created_at: a.created_at,
      amount: a.amount_irr,
      status: a.status,
      provider_name: a.provider_name,
      invoice_number: a.invoice_number,
      action_type: a.action_type,
      purchase_type: a.purchase_type,
      plan_name_snapshot: a.billing_plans?.name || null,
      billing_interval: a.billing_interval,
      metadata: a.metadata,
      paid: false,
    }));
    return [...settled, ...unpaid].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [payments, attempts]);

  const describe = (p: Row) => {
    const plan = p.plan_name_snapshot || currentPlanName || '';
    if (p.purchase_type === 'ai_credit_topup' || p.action_type === 'ai_credit_topup' || p.metadata?.purchase_type === 'ai_credit_topup') {
      return t('billingIran.transactions.descTopup');
    }
    switch (p.action_type) {
      case 'plan_upgrade': return t('billingIran.transactions.descUpgrade');
      case 'plan_downgrade': return t('billingIran.transactions.descDowngrade');
      case 'plan_new': return t('billingIran.transactions.descNew', { plan });
      case 'plan_renewal': return t('billingIran.transactions.descRenewal', { plan });
      default:
        return p.metadata?.isUpgrade
          ? t('billingIran.transactions.descUpgrade')
          : t('billingIran.transactions.descRenewal', { plan });
    }
  };

  /** Why an unpaid attempt is in the list — plain Persian, never a raw enum. */
  const explain = (p: Row): string | null => {
    if (p.paid) return null;
    switch (p.status) {
      case 'pending': return t('billingIran.transactions.notePending');
      case 'processing': return t('billingIran.transactions.noteProcessing');
      case 'canceled': return t('billingIran.transactions.noteCanceled');
      case 'expired': return t('billingIran.transactions.noteExpired');
      default: return t('billingIran.transactions.noteFailed');
    }
  };

  const statusLabel = (p: Row) => {
    const s = mapPaymentStatus(p.status);
    return t(`billingIran.transactions.status${s.charAt(0).toUpperCase()}${s.slice(1)}` as any);
  };

  return (
    <div dir="rtl">
      {rows.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          <Receipt className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>{t('billingIran.transactions.empty')}</p>
          <p className="text-xs mt-1.5 opacity-80">{t('billingIran.transactions.emptyHint')}</p>
        </CardContent></Card>
      ) : (
        <>
        {/* Mobile: one readable card per transaction. */}
        <div className="grid gap-3 md:hidden">
          {rows.map((p) => {
            const status = mapPaymentStatus(p.status);
            return (
              <Card key={p.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-foreground truncate">{describe(p)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{jalaliDate(p.created_at)}</p>
                      {p.invoice_number && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 font-mono" dir="ltr">{p.invoice_number}</p>
                      )}
                    </div>
                    <Badge variant="outline" className={`${STATUS_STYLE[status]} shrink-0`}>{statusLabel(p)}</Badge>
                  </div>
                  {explain(p) && <p className="text-[11px] text-muted-foreground">{explain(p)}</p>}
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="font-semibold text-sm">{formatToman(p.amount, 'fa')}</span>
                    <Button variant="ghost" size="sm" onClick={() => setDetail(p)}>{t('billingIran.transactions.details')}</Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card className="hidden md:block overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('billingIran.transactions.date')}</TableHead>
                <TableHead>{t('billingIran.transactions.invoiceNumber')}</TableHead>
                <TableHead>{t('billingIran.transactions.description')}</TableHead>
                <TableHead>{t('billingIran.transactions.amount')}</TableHead>
                <TableHead>{t('billingIran.transactions.status')}</TableHead>
                <TableHead>{t('billingIran.transactions.details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const status = mapPaymentStatus(p.status);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{jalaliDate(p.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs" dir="ltr">{p.invoice_number || '—'}</TableCell>
                    <TableCell>
                      <span>{describe(p)}</span>
                      {explain(p) && <span className="block text-[11px] text-muted-foreground mt-0.5">{explain(p)}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatToman(p.amount, 'fa')}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_STYLE[status]}>{statusLabel(p)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => setDetail(p)}>{t('billingIran.transactions.details')}</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
        </>
      )}

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{t('billingIran.transactions.detailTitle')}</DialogTitle></DialogHeader>
          {detail && (
            <dl className="text-sm space-y-2.5">
              {detail.invoice_number && <Row2 label={t('billingIran.transactions.invoiceNumber')} value={detail.invoice_number} mono />}
              <Row2 label={t('billingIran.transactions.date')} value={jalaliDate(detail.created_at)} />
              <Row2 label={t('billingIran.transactions.description')} value={describe(detail)} />
              <Row2 label={t('billingIran.transactions.amount')} value={formatToman(detail.amount, 'fa')} />
              <Row2 label={t('billingIran.transactions.status')} value={statusLabel(detail)} />
              {explain(detail) && <Row2 label={t('billingIran.transactions.note')} value={explain(detail) as string} />}
              {detail.provider_name && <Row2 label={t('billingIran.transactions.gateway')} value={detail.provider_name} />}
              {detail.metadata?.trackingNumber && <Row2 label={t('billingIran.transactions.trackingNumber')} value={detail.metadata.trackingNumber} mono />}
              {detail.metadata?.orderNumber && <Row2 label={t('billingIran.transactions.orderNumber')} value={detail.metadata.orderNumber} mono />}
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row2({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium text-foreground ${mono ? 'font-mono' : ''}`} dir={mono ? 'ltr' : undefined}>{value}</dd>
    </div>
  );
}
