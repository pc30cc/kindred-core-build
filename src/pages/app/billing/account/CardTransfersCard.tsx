/**
 * The workspace's card-to-card top-ups (Iranian edition): each submitted
 * receipt with its amount, tracking number and review state — awaiting
 * review, credited, rejected (with the reason) or withdrawn. A request still
 * awaiting review can be withdrawn; the uploaded receipt can be opened.
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, ExternalLink, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { accountBillingApi, type CardTransferRequest, type CardTransferStatus } from '@/lib/accountBillingApi';
import { Ltr, billingDate, money } from '../shared';
import { accountErrorText } from './accountUi';

const STATUS_STYLE: Record<CardTransferStatus, string> = {
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  approved: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
  canceled: 'border-border bg-muted text-muted-foreground',
};

export default function CardTransfersCard({
  workspaceId,
  version,
  onChanged,
}: {
  workspaceId: string;
  /** Bumped by the page after a new receipt was submitted. */
  version: number;
  onChanged?: () => void;
}) {
  const { t, locale } = useTranslation();
  const [items, setItems] = useState<CardTransferRequest[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await accountBillingApi.cardTransfers(workspaceId)).items);
    } catch {
      setItems([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!items || items.length === 0) return null;

  const openReceipt = async (id: string) => {
    setWorking(id);
    try {
      const blob = await accountBillingApi.cardTransferReceipt(workspaceId, id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(accountErrorText(e, t));
    } finally {
      setWorking(null);
    }
  };

  const withdraw = async (id: string) => {
    setWorking(id);
    try {
      await accountBillingApi.cancelCardTransfer(workspaceId, id);
      toast.success(t('billing.account.cardTransfer.canceled'));
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(accountErrorText(e, t));
    } finally {
      setWorking(null);
    }
  };

  return (
    <Card data-testid="card-transfers">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-primary" aria-hidden />
          {t('billing.account.cardTransfer.listTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid={`card-transfer-${item.status}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold tabular-nums">{money(item.amount_minor, locale, item.currency)}</span>
                  <Badge variant="outline" className={cn('font-medium', STATUS_STYLE[item.status])}>
                    {t(`billing.account.cardTransfer.st_${item.status}` as never)}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{billingDate(item.paid_at ?? item.created_at, locale)}</span>
                  {item.reference && (
                    <span>
                      {t('billing.account.cardTransfer.reference')}: <Ltr>{item.reference}</Ltr>
                    </span>
                  )}
                  {item.net_minor !== item.amount_minor && (
                    <span>
                      {t('billing.account.cardTransfer.creditLabel')}: {money(item.net_minor, locale, item.currency)}
                    </span>
                  )}
                </div>
                {item.status === 'rejected' && item.review_note && (
                  <p className="text-xs text-destructive">
                    {t('billing.account.cardTransfer.reviewNote')}: {item.review_note}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="ghost" disabled={working === item.id} onClick={() => void openReceipt(item.id)}>
                  {working === item.id ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <ExternalLink className="me-1.5 h-3.5 w-3.5" aria-hidden />}
                  {t('billing.account.cardTransfer.viewReceipt')}
                </Button>
                {item.status === 'pending' && (
                  <Button size="sm" variant="outline" disabled={working === item.id} onClick={() => void withdraw(item.id)}>
                    {t('billing.account.cardTransfer.cancel')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
