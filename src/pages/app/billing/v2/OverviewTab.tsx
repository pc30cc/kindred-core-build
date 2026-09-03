/**
 * Overview — the "where do I stand" screen.
 *
 * Deliberately calm: the current plan, the service period, the AI cycle, the
 * wallet, and the single next thing to pay. Every number is copied from the
 * server read-model; a paid-but-not-yet-started period says "activates on X",
 * never "active", because pretending otherwise is a financial lie.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CalendarClock, Wallet, Sparkles, Receipt, Info, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { BillingOverview } from '@/lib/billingV2Api';
import { billingDate, money, InvoiceStatusBadge } from './shared';

export default function OverviewTab({
  overview,
  onPayInvoice,
  onCancelPendingChange,
  canceling,
}: {
  overview: BillingOverview;
  onPayInvoice: (invoiceId: string) => void;
  onCancelPendingChange: () => void;
  canceling: boolean;
}) {
  const { t, locale } = useTranslation();
  const { subscription, servicePeriod, aiCycle, wallet, upcomingInvoice, pendingPlanChange } = overview;

  const cycleUsedPct =
    aiCycle && aiCycle.allowanceIrr > 0
      ? Math.min(100, Math.round((aiCycle.usedIrr / aiCycle.allowanceIrr) * 100))
      : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* ── Current plan ─────────────────────────────────────────────── */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('billingV2.overview.currentPlan')}
            <span className="font-semibold">
              {subscription.planName || t('billingV2.overview.free')}
            </span>
            <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'}>
              {subscription.status === 'active'
                ? t('billingV2.overview.active')
                : t('billingV2.overview.inactive')}
            </Badge>
            {subscription.isTrial && <Badge variant="outline">{t('billingV2.overview.trial')}</Badge>}
            {subscription.interval && (
              <Badge variant="outline">
                {subscription.interval === 'yearly'
                  ? t('billingV2.overview.yearly')
                  : t('billingV2.overview.monthly')}
              </Badge>
            )}
            {subscription.cancelAtPeriodEnd && (
              <Badge variant="outline">{t('billingV2.overview.canceling')}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            label={t('billingV2.overview.periodStart')}
            value={billingDate(servicePeriod?.start, locale)}
          />
          <Field label={t('billingV2.overview.periodEnd')} value={billingDate(servicePeriod?.end, locale)} />
          <Field
            label={t('billingV2.overview.nextInvoice')}
            value={
              overview.nextInvoiceAt
                ? billingDate(overview.nextInvoiceAt, locale)
                : t('billingV2.overview.noNextInvoice')
            }
          />
          {overview.aiMonthlyOnAnnual && (
            <p className="sm:col-span-3 flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {t('billingV2.overview.annualNote')}
            </p>
          )}
          {pendingPlanChange && (
            <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-sm">
                <p className="font-medium">{t('billingV2.overview.pendingChange')}</p>
                <p className="text-muted-foreground">
                  {t('billingV2.overview.pendingChangeTo', { plan: pendingPlanChange.planName || '' })}
                  {pendingPlanChange.effectiveAt
                    ? ` · ${t('billingV2.overview.effectiveAt', {
                        date: billingDate(pendingPlanChange.effectiveAt, locale),
                      })}`
                    : ''}
                </p>
              </div>
              {/* Only offered when the SERVER says the change is still cancelable. */}
              {pendingPlanChange.cancelable && overview.permissions.manage && (
                <Button variant="outline" size="sm" disabled={canceling} onClick={onCancelPendingChange}>
                  <X className="me-2 h-4 w-4" />
                  {t('billingV2.overview.cancelChange')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── AI cycle ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('billingV2.overview.aiCycle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {aiCycle ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('billingV2.overview.cycleRange', {
                  start: billingDate(aiCycle.start, locale),
                  end: billingDate(aiCycle.end, locale),
                })}
              </p>
              <Progress value={cycleUsedPct} />
              <div className="grid grid-cols-3 gap-2 text-sm">
                <Field label={t('billingV2.overview.allowance')} value={money(aiCycle.allowanceIrr, locale)} />
                <Field label={t('billingV2.overview.used')} value={money(aiCycle.usedIrr, locale)} />
                <Field
                  label={t('billingV2.overview.remaining')}
                  value={money(aiCycle.remainingIrr, locale)}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('billingV2.ai.noCycle')}</p>
          )}
          <div className="rounded-lg bg-muted/60 p-3">
            <p className="text-xs text-muted-foreground">{t('billingV2.overview.purchasedCredit')}</p>
            <p className="text-sm font-semibold">{money(overview.aiPurchasedRemainingIrr, locale)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('billingV2.overview.purchasedNote')}</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Wallet ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 text-primary" />
            {t('billingV2.overview.wallet')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground">{t('billingV2.overview.walletBalance')}</p>
            <p className="text-2xl font-bold">{money(wallet.balanceIrr, locale)}</p>
          </div>
          <Badge variant={wallet.autoPayEnabled ? 'default' : 'secondary'}>
            {wallet.autoPayEnabled
              ? t('billingV2.overview.autoPayOn')
              : t('billingV2.overview.autoPayOff')}
          </Badge>
          {wallet.frozen && <p className="text-xs text-destructive">{t('billingV2.wallet.frozen')}</p>}
        </CardContent>
      </Card>

      {/* ── Next invoice ─────────────────────────────────────────────── */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 text-primary" />
            {t('billingV2.overview.upcomingInvoice')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingInvoice ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{upcomingInvoice.planName || '—'}</span>
                  <InvoiceStatusBadge
                    status={upcomingInvoice.status}
                    label={t(`billingV2.invoices.statuses.${upcomingInvoice.status}` as any)}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  <CalendarClock className="me-1 inline h-3.5 w-3.5" />
                  {upcomingInvoice.activatesAt
                    ? t('billingV2.overview.activatesOn', {
                        date: billingDate(upcomingInvoice.activatesAt, locale),
                      })
                    : t('billingV2.overview.dueOn', { date: billingDate(upcomingInvoice.dueAt, locale) })}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-lg font-bold">{money(upcomingInvoice.amountDueIrr, locale)}</span>
                {upcomingInvoice.amountDueIrr > 0 && overview.permissions.manage && (
                  <Button size="sm" onClick={() => onPayInvoice(upcomingInvoice.id)}>
                    {t('billingV2.overview.payNow')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('billingV2.overview.noNextInvoice')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
