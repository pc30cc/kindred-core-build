/**
 * Choose a plan: monthly or yearly, the plans sold in the account's
 * currency, and for the one picked what it does and costs now — buy it
 * (the period starts now), upgrade (at once, the difference), or change at
 * the end of the period (downgrade, interval change; cancellable). The
 * server quotes every amount; this only shows it and asks to confirm.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  accountBillingApi,
  type AccountView,
  type BillingInterval,
  type PlanOption,
  type PlanQuote,
} from '@/lib/accountBillingApi';
import { billingDate, money } from '../shared';
import PlanFeatures from './PlanFeatures';
import type { PayOnlineRequest } from './PayOnlineDialog';
import { accountErrorText, planLabel } from './accountUi';

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export default function PlanPickerDialog({
  open,
  onOpenChange,
  workspaceId,
  view,
  onDone,
  onPayOnline,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  view: AccountView;
  onDone: () => void;
  onPayOnline: (request: PayOnlineRequest) => void;
}) {
  const { t, locale, dir } = useTranslation();
  const paid = view.paid_period;
  const [interval, setBillingInterval] = useState<BillingInterval>(paid?.billing_interval ?? 'monthly');
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [quote, setQuote] = useState<PlanQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  // The effects below run on what they fetch for, not on the translator's
  // identity: a new `t` must never restart them.
  const tRef = useRef(t);
  tRef.current = t;
  const intervalAtOpen = useRef<BillingInterval>(paid?.billing_interval ?? 'monthly');
  intervalAtOpen.current = paid?.billing_interval ?? 'monthly';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSelected(null);
    setQuote(null);
    setError(null);
    setKey(newKey());
    setBillingInterval(intervalAtOpen.current);
    accountBillingApi
      .plans(workspaceId)
      .then((r) => alive && setPlans(r.plans))
      .catch((e) => alive && setError(accountErrorText(e, tRef.current)));
    return () => {
      alive = false;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setQuote(null);
    setError(null);
    accountBillingApi
      .quote(workspaceId, selected, interval)
      .then((q) => alive && setQuote(q))
      .catch((e) => alive && setError(accountErrorText(e, tRef.current)));
    return () => {
      alive = false;
    };
  }, [selected, interval, workspaceId]);

  const currentPlanId = paid?.plan_id ?? null;
  const yearlyOffered = useMemo(() => (plans ?? []).some((p) => !p.is_free && p.price_yearly_minor !== null), [plans]);
  const priceOf = (p: PlanOption) => (interval === 'yearly' ? p.price_yearly_minor : p.price_monthly_minor);
  const chosen = (plans ?? []).find((p) => p.id === selected) ?? null;
  const chosenName = chosen ? (chosen.is_free ? t('billing.account.plan.free') : planLabel(chosen.name, chosen.localized, locale)) : '';

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(accountErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const payOnline = (purpose: 'plan' | 'upgrade') => {
    if (!quote || !chosen) return;
    onOpenChange(false);
    onPayOnline({
      purpose,
      planId: chosen.id,
      interval,
      priceMinor: quote.amount_minor,
      balanceMinor: view.balance_minor,
      title: t(purpose === 'plan' ? 'billing.account.picker.buyTitle' : 'billing.account.picker.upgradeTitle', { plan: chosenName }),
    });
  };

  const amount = (minor: number) => money(minor, locale, view.currency);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent dir={dir} className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('billing.account.picker.title')}</DialogTitle>
          <DialogDescription>{t('billing.account.picker.description')}</DialogDescription>
        </DialogHeader>

        {yearlyOffered && (
          <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label={t('billing.account.picker.interval')}>
            {(['monthly', 'yearly'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={interval === value}
                onClick={() => setBillingInterval(value)}
                className={`rounded px-3 py-1.5 text-sm ${interval === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t(`billing.account.plan.interval.${value}` as TranslationKey)}
              </button>
            ))}
          </div>
        )}

        {!plans ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden /></div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={t('billing.account.picker.title')}>
            {plans.map((p) => {
              const price = priceOf(p);
              const current = p.id === currentPlanId || (!paid && p.is_free);
              const scheduled = view.scheduled_plan?.id === p.id;
              const sold = p.is_free || price !== null;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected === p.id}
                  disabled={!sold}
                  onClick={() => setSelected(p.id)}
                  data-testid={`plan-option-${p.slug}`}
                  className={`flex flex-col gap-2 rounded-lg border p-4 text-start transition-colors disabled:opacity-50 ${selected === p.id ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/50'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{p.is_free ? t('billing.account.plan.free') : planLabel(p.name, p.localized, locale)}</span>
                    {current && <Badge variant="secondary">{t('billing.account.picker.current')}</Badge>}
                    {scheduled && <Badge variant="outline">{t('billing.account.picker.scheduled')}</Badge>}
                  </div>
                  <div className="text-lg font-bold tabular-nums">
                    {p.is_free ? t('billing.account.plan.free') : price === null ? '—' : amount(price)}
                    {!p.is_free && price !== null && (
                      <span className="ms-1 text-xs font-normal text-muted-foreground">
                        {t(interval === 'yearly' ? 'billing.account.picker.perYear' : 'billing.account.picker.perMonth')}
                      </span>
                    )}
                  </div>
                  <PlanFeatures limits={p.limits} entitlements={p.entitlements} />
                </button>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4" aria-live="polite" data-testid="plan-quote">
            {!quote ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <QuoteSummary
                quote={quote}
                planName={chosenName}
                amount={amount}
                date={(iso) => billingDate(iso, locale)}
                busy={busy}
                canManage={view.can_manage}
                onBuy={() => void run(() => accountBillingApi.buyPlan(workspaceId, { planId: quote.plan_id, interval, key }))}
                onUpgrade={() => void run(() => accountBillingApi.upgrade(workspaceId, quote.plan_id))}
                onSchedule={() => void run(() => accountBillingApi.change(workspaceId, quote.plan_id, interval))}
                onCancelChange={() => paid && void run(() => accountBillingApi.change(workspaceId, paid.plan_id, paid.billing_interval))}
                onPayOnline={payOnline}
              />
            )}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
        )}
        {!selected && error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function QuoteSummary({
  quote,
  planName,
  amount,
  date,
  busy,
  canManage,
  onBuy,
  onUpgrade,
  onSchedule,
  onCancelChange,
  onPayOnline,
}: {
  quote: PlanQuote;
  planName: string;
  amount: (minor: number) => string;
  date: (iso: string) => string;
  busy: boolean;
  canManage: boolean;
  onBuy: () => void;
  onUpgrade: () => void;
  onSchedule: () => void;
  onCancelChange: () => void;
  onPayOnline: (purpose: 'plan' | 'upgrade') => void;
}) {
  const { t } = useTranslation();
  const spinner = busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : null;
  const covered = quote.shortfall_minor === 0;
  const actions = (main: () => void, mainLabel: string, purpose: 'plan' | 'upgrade') =>
    canManage && (
      <div className="flex flex-wrap gap-2">
        {covered ? (
          <Button onClick={main} disabled={busy}>{spinner}{mainLabel}</Button>
        ) : (
          <>
            <Button onClick={() => onPayOnline(purpose)} disabled={busy}>{t('billing.account.picker.payOnline')}</Button>
            <p className="w-full text-xs text-muted-foreground">
              {t('billing.account.picker.short', { amount: amount(quote.shortfall_minor) })}
            </p>
          </>
        )}
      </div>
    );

  switch (quote.kind) {
    case 'purchase':
      return (
        <>
          <p className="text-sm">{t('billing.account.picker.buyNow', { plan: planName, amount: amount(quote.amount_minor) })}</p>
          {actions(onBuy, t('billing.account.picker.payFromBalance', { amount: amount(quote.amount_minor) }), 'plan')}
        </>
      );
    case 'upgrade':
      return (
        <>
          <p className="text-sm">
            {quote.months_left !== null
              ? t('billing.account.picker.upgradeYearly', { plan: planName, amount: amount(quote.amount_minor), months: String(quote.months_left) })
              : t('billing.account.picker.upgradeNow', { plan: planName, amount: amount(quote.amount_minor) })}
          </p>
          {actions(onUpgrade, t('billing.account.picker.upgradeFromBalance', { amount: amount(quote.amount_minor) }), 'upgrade')}
          {quote.next_period_option && canManage && quote.effective_at && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm text-muted-foreground">{t('billing.account.picker.nextPeriodOption', { date: date(quote.effective_at) })}</p>
              <Button variant="outline" onClick={onSchedule} disabled={busy}>{t('billing.account.picker.fromNextPeriod')}</Button>
            </div>
          )}
        </>
      );
    case 'schedule':
      return (
        <>
          <p className="text-sm">
            {t('billing.account.picker.scheduleAt', {
              plan: planName,
              date: quote.effective_at ? date(quote.effective_at) : '',
              amount: quote.period_price_minor === null ? '—' : amount(quote.period_price_minor),
            })}
          </p>
          {quote.amount_minor > 0 && (
            <p className="text-sm text-muted-foreground">{t('billing.account.picker.prepaidMore', { amount: amount(quote.amount_minor) })}</p>
          )}
          {quote.returned_minor > 0 && (
            <p className="text-sm text-muted-foreground">{t('billing.account.picker.prepaidBack', { amount: amount(quote.returned_minor) })}</p>
          )}
          {canManage && (
            <Button onClick={onSchedule} disabled={busy || quote.shortfall_minor > 0}>{spinner}{t('billing.account.picker.confirmChange')}</Button>
          )}
          {quote.shortfall_minor > 0 && (
            <p className="text-xs text-destructive">{t('billing.account.picker.short', { amount: amount(quote.shortfall_minor) })}</p>
          )}
        </>
      );
    case 'cancel_change':
      return (
        <>
          <p className="text-sm">{t('billing.account.picker.cancelChangeHint')}</p>
          {canManage && <Button variant="outline" onClick={onCancelChange} disabled={busy}>{spinner}{t('billing.account.plan.cancelChange')}</Button>}
        </>
      );
    case 'current':
      return <p className="text-sm text-muted-foreground">{t('billing.account.picker.isCurrent')}</p>;
    default:
      return <p className="text-sm text-muted-foreground">{t('billing.account.picker.unavailable')}</p>;
  }
}
