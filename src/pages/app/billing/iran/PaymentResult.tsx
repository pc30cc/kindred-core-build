/**
 * Dedicated payment-result screen (Phase 10) — never a toast. The status
 * shown here always comes from a server-side verify-callback response, never
 * from redirect query params alone.
 */
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslation } from '@/i18n';
import { formatToman } from '@/lib/money';
import { jalaliDate } from './format';

export type PaymentResultStatus = 'success' | 'failure' | 'pending';

interface Props {
  status: PaymentResultStatus;
  amountIrr?: number;
  purpose?: string;
  dateIso?: string;
  trackingNumber?: string;
  orderNumber?: string;
  /** New subscription end date, for plan purchases. */
  periodEndIso?: string;
  onBack: () => void;
  onRetry?: () => void;
}

export default function PaymentResult({ status, amountIrr, purpose, dateIso, trackingNumber, orderNumber, periodEndIso, onBack, onRetry }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-center py-16" dir="rtl">
      <Card className="w-full max-w-md">
        <CardContent className="pt-8 pb-6 text-center space-y-4">
          {status === 'success' && <CheckCircle2 className="w-14 h-14 mx-auto text-emerald-500" />}
          {status === 'failure' && <XCircle className="w-14 h-14 mx-auto text-rose-500" />}
          {status === 'pending' && <Loader2 className="w-14 h-14 mx-auto text-amber-500 animate-spin" />}

          <h1 className="text-xl font-bold text-foreground">
            {status === 'success' && t('billingIran.result.successTitle')}
            {status === 'failure' && t('billingIran.result.failureTitle')}
            {status === 'pending' && t('billingIran.result.pendingTitle')}
          </h1>

          {status === 'failure' && (
            <p className="text-sm text-muted-foreground">{t('billingIran.result.failureHint')}</p>
          )}

          {/* The customer HAS paid; the server is still finalizing. Never
              present this as a failure and never ask them to pay again. */}
          {status === 'pending' && (
            <p className="text-sm text-muted-foreground">{t('billingIran.result.pendingHint')}</p>
          )}

          {status === 'success' && (
            <dl className="text-sm text-start space-y-2 rounded-xl border border-border/60 bg-muted/30 p-4 mt-2">
              {purpose && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.purposeLabel')}</dt>
                  <dd className="font-medium text-foreground">{purpose}</dd>
                </div>
              )}
              {typeof amountIrr === 'number' && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.amountLabel')}</dt>
                  <dd className="font-medium text-foreground">{formatToman(amountIrr, 'fa')}</dd>
                </div>
              )}
              {dateIso && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.dateLabel')}</dt>
                  <dd className="font-medium text-foreground">{jalaliDate(dateIso)}</dd>
                </div>
              )}
              {trackingNumber && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.trackingNumberLabel')}</dt>
                  <dd className="font-medium text-foreground font-mono">{trackingNumber}</dd>
                </div>
              )}
              {periodEndIso && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.periodEndLabel')}</dt>
                  <dd className="font-medium text-foreground">{jalaliDate(periodEndIso)}</dd>
                </div>
              )}
              {orderNumber && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.result.orderNumberLabel')}</dt>
                  <dd className="font-medium text-foreground font-mono">{orderNumber}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="flex flex-col gap-2 pt-2">
            {status === 'failure' && onRetry && (
              <Button onClick={onRetry}>{t('billingIran.result.retryCta')}</Button>
            )}
            <Button variant={status === 'failure' ? 'outline' : 'default'} onClick={onBack}>
              {t('billingIran.result.backCta')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
