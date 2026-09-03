/**
 * Transactions tab (Phase 11) — Persian status mapping, no raw backend
 * enums, no provider name in the main table (only in the detail view).
 */
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Receipt } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatToman } from '@/lib/money';
import { jalaliDate, mapPaymentStatus, describeTransaction, type TxStatus } from './format';

const STATUS_STYLE: Record<TxStatus, string> = {
  succeeded: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  failed: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  refunded: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  canceled: 'bg-muted text-muted-foreground border-border',
};

interface Row {
  id: string;
  created_at: string;
  amount: number;
  status: string | null;
  provider_name?: string | null;
  metadata?: any;
  event_type?: string;
  currentPlanName?: string;
}

export default function TransactionsTab({ payments, currentPlanName }: { payments: Row[]; currentPlanName?: string }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Row | null>(null);

  const describe = (p: Row) => {
    const kind = describeTransaction(p);
    if (kind === 'topup') return t('billingIran.transactions.descTopup');
    if (kind === 'upgrade') return t('billingIran.transactions.descUpgrade');
    return t('billingIran.transactions.descRenewal', { plan: currentPlanName || '' });
  };

  return (
    <div dir="rtl">
      {payments.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">
          <Receipt className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>{t('billingIran.transactions.empty')}</p>
        </CardContent></Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('billingIran.transactions.date')}</TableHead>
                <TableHead>{t('billingIran.transactions.description')}</TableHead>
                <TableHead>{t('billingIran.transactions.amount')}</TableHead>
                <TableHead>{t('billingIran.transactions.status')}</TableHead>
                <TableHead>{t('billingIran.transactions.details')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => {
                const status = mapPaymentStatus(p.status);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap">{jalaliDate(p.created_at)}</TableCell>
                    <TableCell>{describe(p)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatToman(p.amount, 'fa')}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_STYLE[status]}>
                        {t(`billingIran.transactions.status${status.charAt(0).toUpperCase() + status.slice(1)}` as any)}
                      </Badge>
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
      )}

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{t('billingIran.transactions.detailTitle')}</DialogTitle></DialogHeader>
          {detail && (
            <dl className="text-sm space-y-2.5">
              <Row2 label={t('billingIran.transactions.date')} value={jalaliDate(detail.created_at)} />
              <Row2 label={t('billingIran.transactions.description')} value={describe(detail)} />
              <Row2 label={t('billingIran.transactions.amount')} value={formatToman(detail.amount, 'fa')} />
              <Row2 label={t('billingIran.transactions.status')} value={t(`billingIran.transactions.status${mapPaymentStatus(detail.status).charAt(0).toUpperCase()}${mapPaymentStatus(detail.status).slice(1)}` as any)} />
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
      <dd className={`font-medium text-foreground ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
