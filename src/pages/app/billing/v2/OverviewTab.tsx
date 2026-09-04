/**
 * Overview — the "where do I stand" screen.
 *
 * Three headline boxes answer the only three questions a non-technical owner
 * has: which plan am I on (and until when), how much money is in my wallet,
 * and how much AI credit is left. Each box carries exactly one primary action.
 * Everything else (pending change, next invoice) sits below as calm detail.
 *
 * Every number is copied from the server read-model; a paid-but-not-yet-started
 * period says "activates on X", never "active", because pretending otherwise is
 * a financial lie.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CalendarClock, Wallet, Sparkles, Receipt, Info, X, ArrowUpCircle, Plus } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { BillingOverview } from '@/lib/billingV2Api';
import { billingDate, money, InvoiceStatusBadge } from './shared';

/** Escalation ramp for the next service invoice — index is the server stage. */
const STAGE_CARD: Record<number, string> = {
  0: '',
  1: 'border-2 border-amber-400/60 bg-amber-50/60 dark:bg-amber-500/5',
  2: 'border-2 border-orange-500/70 bg-orange-50/70 dark:bg-orange-500/10',
  3: 'border-2 border-destructive/70 bg-destructive/5',
};
const STAGE_ICON: Record<number, string> = {
  0: 'text-primary',
  1: 'text-amber-600',
  2: 'text-orange-600',
  3: 'text-destructive',
};


export default function OverviewTab({
  overview,
  onPayInvoice,
  onCancelPendingChange,
  canceling,
  onGoTo,
}: {
  overview: BillingOverview;
  onPayInvoice: (invoiceId: string) => void;
  onCancelPendingChange: () => void;
  canceling: boolean;
  onGoTo: (tab: 'plans' | 'wallet' | 'ai') => void;
}) {
  const { t, locale } = useTranslation();
  const { subscription, servicePeriod, aiCycle, wallet, upcomingInvoice, pendingPlanChange } = overview;
  const canManage = overview.permissions.manage;
  const alert = overview.upcomingInvoiceAlert;
  const alertStage = alert?.stage ?? 0;

  const cycleUsedPct =
    aiCycle && aiCycle.allowanceIrr > 0
      ? Math.min(100, Math.round((aiCycle.usedIrr / aiCycle.allowanceIrr) * 100))
      : 0;

  const aiTotalRemaining = (aiCycle?.remainingIrr ?? 0) + (overview.aiPurchasedRemainingIrr ?? 0);


  return (
    <div className="space-y-4">
      {/* ── Three headline boxes ─────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Plan */}
        <Card className="relative overflow-hidden border-2 border-primary/25 lg:col-span-1">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/15 to-transparent"
            aria-hidden
          />
          <CardHeader className="relative pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ArrowUpCircle className="h-4 w-4 text-primary" />
              {t('billingV2.overview.currentPlan')}
            </CardTitle>
          </CardHeader>
          <CardContent className="relative space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-3xl font-extrabold tracking-tight">
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
            </div>

            <div className="space-y-1.5 rounded-xl bg-muted/50 p-3 text-sm">
              <Row
                label={t('billingV2.overview.startedOn')}
                value={billingDate(servicePeriod?.start, locale)}
              />
              <Row
                label={t('billingV2.overview.renewsOn')}
                value={
                  servicePeriod?.end
                    ? billingDate(servicePeriod.end, locale)
                    : t('billingV2.overview.noNextInvoice')
                }
              />
            </div>

            {canManage && (
              <Button size="lg" className="w-full text-base" onClick={() => onGoTo('plans')}>
                <ArrowUpCircle className="me-2 h-5 w-5" />
                {t('billingV2.plans.upgrade')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('billingV2.overview.planBoxHint')}</p>
          </CardContent>
        </Card>

        {/* Wallet */}
        <Card className="relative overflow-hidden border-2 border-emerald-500/25">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-emerald-500/15 to-transparent"
            aria-hidden
          />
          <CardHeader className="relative pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Wallet className="h-4 w-4 text-emerald-600" />
              {t('billingV2.overview.wallet')}
            </CardTitle>
          </CardHeader>
          <CardContent className="relative space-y-4">
            <div>
              <p className="text-3xl font-extrabold tracking-tight tabular-nums">
                {money(wallet.balanceIrr, locale)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('billingV2.overview.walletBalance')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={wallet.autoPayEnabled ? 'default' : 'secondary'}>
                {wallet.autoPayEnabled
                  ? t('billingV2.overview.autoPayOn')
                  : t('billingV2.overview.autoPayOff')}
              </Badge>
              {wallet.frozen && (
                <Badge variant="destructive">{t('billingV2.wallet.frozen')}</Badge>
              )}
            </div>

            {canManage && (
              <Button
                size="lg"
                variant="outline"
                className="w-full border-2 text-base"
                onClick={() => onGoTo('wallet')}
              >
                <Plus className="me-2 h-5 w-5" />
                {t('billingV2.wallet.deposit')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('billingV2.overview.walletBoxHint')}</p>
          </CardContent>
        </Card>

        {/* AI credit */}
        <Card className="relative overflow-hidden border-2 border-violet-500/25">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-violet-500/15 to-transparent"
            aria-hidden
          />
          <CardHeader className="relative pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Sparkles className="h-4 w-4 text-violet-600" />
              {t('billingV2.ai.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="relative space-y-4">
            <div>
              <p className="text-3xl font-extrabold tracking-tight tabular-nums">
                {money(aiTotalRemaining, locale)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('billingV2.overview.remaining')}</p>
            </div>

            {aiCycle ? (
              <div className="space-y-1.5">
                <Progress value={cycleUsedPct} />
                <p className="text-xs text-muted-foreground">
                  {t('billingV2.overview.usedOfAllowance', {
                    used: money(aiCycle.usedIrr, locale),
                    total: money(aiCycle.allowanceIrr, locale),
                  })}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('billingV2.ai.noCycle')}</p>
            )}

            {canManage && (
              <Button
                size="lg"
                variant="outline"
                className="w-full border-2 text-base"
                onClick={() => onGoTo('ai')}
              >
                <Plus className="me-2 h-5 w-5" />
                {t('billingV2.ai.buy')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('billingV2.overview.aiBoxHint')}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Pending plan change ──────────────────────────────────────── */}
      {pendingPlanChange && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-sm">
            <p className="font-semibold">{t('billingV2.overview.pendingChange')}</p>
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
          {pendingPlanChange.cancelable && canManage && (
            <Button variant="outline" size="sm" disabled={canceling} onClick={onCancelPendingChange}>
              <X className="me-2 h-4 w-4" />
              {t('billingV2.overview.cancelChange')}
            </Button>
          )}
        </div>
      )}

      {overview.aiMonthlyOnAnnual && (
        <p className="flex items-start gap-2 rounded-2xl bg-muted/60 p-4 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {t('billingV2.overview.annualNote')}
        </p>
      )}

      {/* ── Next service invoice ─────────────────────────────────────── */}
      {/* The colour ramp is the SERVER's escalation stage, never a local date
          comparison: calm → first reminders → last reminder → past due. */}
      <Card className={STAGE_CARD[alertStage]}>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Receipt className={`h-4 w-4 ${STAGE_ICON[alertStage]}`} />
            {t('billingV2.overview.upcomingInvoice')}
            {alert && alert.remindersSent > 0 && !alert.pastDue && (
              <Badge variant="outline">
                {t('billingV2.overview.reminderCount', {
                  sent: alert.remindersSent,
                  total: alert.remindersTotal,
                })}
              </Badge>
            )}
            {alert?.pastDue && (
              <Badge variant="destructive">{t('billingV2.invoices.statuses.past_due')}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcomingInvoice ? (
            <div className="space-y-3">
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
                  {upcomingInvoice.amountDueIrr > 0 && canManage && (
                    <Button size="sm" onClick={() => onPayInvoice(upcomingInvoice.id)}>
                      {t('billingV2.overview.payNow')}
                    </Button>
                  )}
                </div>
              </div>
              {alert && alert.suspendAt && alert.stage >= 1 && (
                <p className="flex items-start gap-2 rounded-xl bg-background/70 p-3 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  {t('billingV2.overview.suspendWarning', {
                    date: billingDate(alert.suspendAt, locale),
                    days: alert.daysToSuspend ?? 0,
                  })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('billingV2.overview.noNextInvoice')}</p>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}
