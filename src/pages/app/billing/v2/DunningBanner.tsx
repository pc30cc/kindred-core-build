/**
 * Past-due / fallback banner.
 *
 * The countdown is anchored to the server timestamp that arrived with the
 * read-model, not to `Date.now()`, so a device with a wrong clock can never
 * show a customer a grace deadline the server does not agree with.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import type { BillingOverview } from '@/lib/billingV2Api';
import { billingDate } from './shared';

export default function DunningBanner({
  overview,
  onPayInvoice,
}: {
  overview: BillingOverview;
  onPayInvoice: (invoiceId: string) => void;
}) {
  const { t, locale } = useTranslation();
  const { dunning, upcomingInvoice, subscription } = overview;

  // Offset between this browser and the server, measured once per read-model.
  const skewMs = useMemo(
    () => new Date(dunning.serverTime).getTime() - Date.now(),
    [dunning.serverTime],
  );
  const [, force] = useState(0);
  useEffect(() => {
    if (!dunning.gracePeriodEndsAt) return;
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [dunning.gracePeriodEndsAt]);

  if (dunning.freeFallbackAt && !dunning.pastDue) {
    return (
      <Alert variant="destructive" className="mb-4">
        <ArrowDownCircle className="h-4 w-4" />
        <AlertTitle>{t('billingV2.dunning.fallbackTitle')}</AlertTitle>
        <AlertDescription>
          {t('billingV2.dunning.fallbackBody', {
            date: billingDate(dunning.freeFallbackAt, locale),
          })}
        </AlertDescription>
      </Alert>
    );
  }

  if (!dunning.pastDue) return null;

  const deadline = dunning.gracePeriodEndsAt ? new Date(dunning.gracePeriodEndsAt).getTime() : null;
  const msLeft = deadline === null ? null : deadline - (Date.now() + skewMs);
  const daysLeft = msLeft === null ? null : Math.max(0, Math.ceil(msLeft / 86_400_000));

  // Payment stays possible for a past-due invoice; only expired loses its CTA.
  const payable =
    upcomingInvoice &&
    ['open', 'partially_paid', 'past_due'].includes(upcomingInvoice.status) &&
    overview.permissions.manage;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t('billingV2.dunning.pastDueTitle')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {daysLeft === null
            ? t('billingV2.dunning.pastDueBody')
            : t('billingV2.dunning.graceBody', {
                days: String(daysLeft),
                date: billingDate(dunning.gracePeriodEndsAt!, locale),
              })}
          {subscription.planName ? ` — ${subscription.planName}` : ''}
        </span>
        {payable && (
          <Button size="sm" variant="secondary" onClick={() => onPayInvoice(upcomingInvoice!.id)}>
            {t('billingV2.dunning.payNow')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
