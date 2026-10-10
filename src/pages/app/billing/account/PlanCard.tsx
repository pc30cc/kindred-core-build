/**
 * The workspace's plan: what it is, when its period ends, what the next one
 * costs, a change scheduled for the period end, auto-renew, and the actions
 * (renew from the balance or online, choose another plan, renew a plan that
 * ran out). In the last 7 days of an unpaid period it says so plainly: at
 * the due moment the workspace moves to the free plan. Cancelling a change
 * opens the plan picker on the current plan, so what it moves in the
 * balance is shown before it is confirmed.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation, type TranslationKey } from '@/i18n';
import { accountBillingApi, type AccountView } from '@/lib/accountBillingApi';
import { billingDate, money } from '../shared';
import type { PayOnlineRequest } from './PayOnlineDialog';
import type { PlanPreselect } from './PlanPickerDialog';
import { accountErrorText, planLabel } from './accountUi';

export default function PlanCard({
  workspaceId,
  view,
  onChanged,
  onChoosePlan,
  onPayOnline,
}: {
  workspaceId: string;
  view: AccountView;
  onChanged: () => void;
  /** Opens the plan picker, on a plan when given. */
  onChoosePlan: (preselect?: PlanPreselect) => void;
  onPayOnline: (request: PayOnlineRequest) => void;
}) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = view.plan;
  const paid = view.paid_period;
  const name = plan.is_free && !plan.name ? t('billing.account.plan.free') : planLabel(plan.name, plan.localized, locale);
  const prepaid = view.next_period_prepaid_minor !== null;
  const renewalPrice = view.renewal?.price_minor ?? null;
  const canRenewFromBalance = renewalPrice !== null && view.balance_minor >= renewalPrice;
  const willAutoRenew = view.auto_renew && canRenewFromBalance;
  const warn = Boolean(paid && !prepaid && view.days_left !== null && view.days_left <= 7 && view.renewal && !willAutoRenew);
  const scheduledName = view.scheduled_plan
    ? (view.scheduled_plan.is_free ? t('billing.account.plan.free') : planLabel(view.scheduled_plan.name, view.scheduled_plan.localized, locale))
    : null;
  // The plan the next period is for (a scheduled change's, else this one).
  const renewalName = view.renewal ? planLabel(view.renewal.name, view.renewal.localized, locale) : name;
  const lapsed = !paid && plan.status !== 'trialing' ? view.lapsed : null;
  const lapsedName = lapsed ? planLabel(lapsed.name, lapsed.localized, locale) : '';

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(accountErrorText(e, t));
      // The period changed under the page (another tab, the job): show what is true now.
      const code = (e as { code?: string } | null)?.code;
      if (code === 'PERIOD_CHANGED' || code === 'ALREADY_RENEWED' || code === 'NO_PAID_PLAN') onChanged();
    } finally {
      setBusy(null);
    }
  };
  const spin = (id: string) => (busy === id ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : null);
  const amount = (minor: number) => money(minor, locale, view.currency);

  return (
    <Card data-testid="plan-card">
      <CardHeader className="pb-2">
        <CardDescription>{t('billing.account.plan.title')}</CardDescription>
        <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
          {name}
          {plan.billing_interval && !plan.is_free && (
            <Badge variant="secondary">{t(`billing.account.plan.interval.${plan.billing_interval}` as TranslationKey)}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {plan.status === 'trialing' && plan.trial_end ? (
          <p className="text-muted-foreground">{t('billing.account.plan.trialEndsOn', { date: billingDate(plan.trial_end, locale) })}</p>
        ) : paid ? (
          <p className="text-muted-foreground">
            {t(prepaid || willAutoRenew ? 'billing.account.plan.renewsOn' : 'billing.account.plan.endsOn', {
              date: billingDate(paid.current_period_end, locale),
            })}
          </p>
        ) : lapsed ? (
          <p className="text-muted-foreground" data-testid="plan-lapsed">{t('billing.account.plan.lapsedNote', { plan: lapsedName })}</p>
        ) : (
          <p className="text-muted-foreground">{t('billing.account.plan.freeNote')}</p>
        )}

        {paid && view.renewal && (
          <p className="text-muted-foreground" data-testid="plan-renewal">
            {prepaid ? (
              <span className="inline-flex items-center gap-1 text-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
                {t('billing.account.plan.nextPaid')}
              </span>
            ) : renewalPrice === null ? (
              t('billing.account.plan.noRenewalPrice')
            ) : (
              t('billing.account.plan.nextPeriod', { amount: amount(renewalPrice) })
            )}
          </p>
        )}

        {paid && (scheduledName || view.scheduled_interval) && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2" data-testid="plan-scheduled">
            <span>
              {t('billing.account.plan.scheduled', {
                date: billingDate(paid.current_period_end, locale),
                plan: scheduledName ?? name,
                interval: t(`billing.account.plan.interval.${view.scheduled_interval ?? paid.billing_interval}` as TranslationKey),
              })}
            </span>
            {view.can_manage && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => onChoosePlan({ planId: paid.plan_id, interval: paid.billing_interval })}
              >
                {t('billing.account.plan.cancelChange')}
              </Button>
            )}
          </div>
        )}

        {warn && view.days_left !== null && (
          <Alert variant="destructive" data-testid="plan-warning">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertDescription>
              {view.days_left <= 1
                ? t('billing.account.plan.endsSoonOne')
                : t('billing.account.plan.endsSoon', { days: String(view.days_left) })}
            </AlertDescription>
          </Alert>
        )}

        {paid && view.can_manage && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-2">
            <div>
              <Label htmlFor="auto-renew" className="font-medium">{t('billing.account.plan.autoRenew')}</Label>
              <p className="text-xs text-muted-foreground">{t('billing.account.plan.autoRenewHint')}</p>
            </div>
            <Switch
              id="auto-renew"
              checked={view.auto_renew}
              disabled={busy !== null}
              onCheckedChange={(enabled) => void act('auto', () => accountBillingApi.setAutoRenew(workspaceId, enabled))}
            />
          </div>
        )}

        {view.can_manage && (
          <div className="flex flex-wrap gap-2">
            {paid && !prepaid && view.renewal && renewalPrice !== null && (
              canRenewFromBalance ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => void act('renew', () => accountBillingApi.renew(workspaceId, paid.current_period_end))}
                >
                  {spin('renew')}
                  {t('billing.account.plan.renewFromBalance', { amount: amount(renewalPrice) })}
                </Button>
              ) : (
                <Button
                  disabled={busy !== null}
                  onClick={() => onPayOnline({
                    purpose: 'renewal',
                    priceMinor: renewalPrice,
                    balanceMinor: view.balance_minor,
                    title: t('billing.account.plan.renewOnlineTitle', { plan: renewalName }),
                  })}
                >
                  {t('billing.account.plan.renewOnline')}
                </Button>
              )
            )}
            {lapsed && (
              <Button
                disabled={busy !== null}
                onClick={() => onChoosePlan({ planId: lapsed.plan_id, interval: lapsed.billing_interval })}
              >
                {t('billing.account.plan.renewLapsed', { plan: lapsedName })}
              </Button>
            )}
            <Button variant={paid || lapsed ? 'outline' : 'default'} disabled={busy !== null} onClick={() => onChoosePlan()}>
              {t(paid ? 'billing.account.plan.change' : 'billing.account.plan.choose')}
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
