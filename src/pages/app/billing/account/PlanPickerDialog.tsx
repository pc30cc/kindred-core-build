/**
 * Choose a plan: monthly or yearly, the plans sold in the account's
 * currency, and for the one picked what it does and costs now — buy it
 * (the period starts now), upgrade (at once, the difference), or change at
 * the end of the period (downgrade, interval change; cancellable). The
 * server quotes every amount, including what a prepaid next period is
 * re-priced by; this only shows it, asks to confirm, and sends the amount
 * it showed back so a price that moved meanwhile is never charged unseen.
 *
 * With a saved card an upgrade is charged to it ("charge $X to Visa ••••
 * 4242"; paying from the balance stays the second choice when it covers
 * it). Paddle may take a moment: the page then asks for the payment every
 * few seconds, for up to a minute. A declined card offers a top-up or the
 * online checkout. While the card's renewal failed, or Paddle is charging
 * it, plan changes wait, and the dialog says why.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  accountBillingApi,
  quoteNet,
  type AccountView,
  type BillingInterval,
  type PlanOption,
  type PlanQuote,
} from '@/lib/accountBillingApi';
import { billingDate, money } from '../shared';
import { PADDLE_MIN_CHARGE_MINOR, chargeFor } from '../../../../../shared/simpleBilling';
import PlanFeatures from './PlanFeatures';
import type { PayOnlineRequest } from './PayOnlineDialog';
import { accountErrorText, billingMoment, cardFailureKind, cardLabel, isFuture, planLabel } from './accountUi';

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** How long a card charge Paddle has not confirmed yet is asked about (every 3 s). */
const CARD_POLL_TRIES = 20;
const CARD_POLL_MS = 3000;

/**
 * An upgrade charged to the card: being charged, waiting for Paddle,
 * declined (with Paddle's reason), refused for another reason, still not
 * confirmed after a minute, or paid while the plan changed meanwhile (the
 * money is in the balance).
 */
type CardCharge =
  | { phase: 'charging' }
  | { phase: 'processing' }
  | { phase: 'declined'; code: string | null }
  | { phase: 'failed' }
  | { phase: 'pending' }
  | { phase: 'kept' };

export interface PlanPreselect {
  planId: string;
  interval: BillingInterval;
}

export default function PlanPickerDialog({
  open,
  onOpenChange,
  workspaceId,
  view,
  preselect = null,
  onDone,
  onPayOnline,
  onTopup,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  view: AccountView;
  /** Opens on this plan and interval (cancel a change, renew a plan that ran out). */
  preselect?: PlanPreselect | null;
  onDone: () => void;
  onPayOnline: (request: PayOnlineRequest) => void;
  /** Top up what the balance is missing (a change at the period end cannot be paid online). */
  onTopup?: (amountMinor: number) => void;
}) {
  const { t, locale, dir } = useTranslation();
  const paid = view.paid_period;
  const [interval, setBillingInterval] = useState<BillingInterval>(preselect?.interval ?? paid?.billing_interval ?? 'monthly');
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [quote, setQuote] = useState<PlanQuote | null>(null);
  // Bumped to ask for a fresh quote of the same plan (after a failed action,
  // or a second click on the plan).
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const [cardCharge, setCardCharge] = useState<CardCharge | null>(null);
  // Bumped when the dialog opens or closes: a card charge still being asked
  // about stops asking.
  const session = useRef(0);
  // The effects below run on what they fetch for, not on the translator's
  // identity: a new `t` must never restart them.
  const tRef = useRef(t);
  tRef.current = t;
  const atOpen = useRef<{ interval: BillingInterval; planId: string | null }>({ interval: 'monthly', planId: null });
  atOpen.current = {
    interval: preselect?.interval ?? paid?.billing_interval ?? 'monthly',
    planId: preselect?.planId ?? null,
  };

  useEffect(() => {
    session.current += 1;
    if (!open) return;
    let alive = true;
    setSelected(atOpen.current.planId);
    setQuote(null);
    setLoadError(null);
    setActionError(null);
    // A card charge left while Paddle was confirming it no longer holds the dialog.
    setBusy(false);
    setCardCharge(null);
    setKey(newKey());
    setBillingInterval(atOpen.current.interval);
    accountBillingApi
      .plans(workspaceId)
      .then((r) => alive && setPlans(r.plans))
      .catch((e) => alive && setLoadError(accountErrorText(e, tRef.current)));
    return () => {
      alive = false;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open || !selected) return;
    let alive = true;
    setQuote(null);
    setLoadError(null);
    accountBillingApi
      .quote(workspaceId, selected, interval)
      .then((q) => alive && setQuote(q))
      .catch((e) => alive && setLoadError(accountErrorText(e, tRef.current)));
    return () => {
      alive = false;
    };
  }, [open, selected, interval, workspaceId, quoteNonce]);

  const yearlyOffered = useMemo(() => (plans ?? []).some((p) => !p.is_free && p.price_yearly_minor !== null), [plans]);
  // Opened on the current plan and interval: cancelling a change, which must
  // stay on that interval whatever is sold.
  const onCurrent = Boolean(preselect && paid && preselect.planId === paid.plan_id && preselect.interval === paid.billing_interval);
  // A yearly subscriber whose plans are no longer sold yearly still sees the monthly ones.
  useEffect(() => {
    if (plans && !yearlyOffered && interval === 'yearly' && !onCurrent) setBillingInterval('monthly');
  }, [plans, yearlyOffered, interval, onCurrent]);
  const showIntervals = yearlyOffered || paid?.billing_interval === 'yearly';

  const currentPlanId = paid?.plan_id ?? null;
  const trialing = view.plan.status === 'trialing';
  const priceOf = (p: PlanOption) => (interval === 'yearly' ? p.price_yearly_minor : p.price_monthly_minor);
  const chosen = (plans ?? []).find((p) => p.id === selected) ?? null;
  const chosenName = chosen ? (chosen.is_free ? t('billing.account.plan.free') : planLabel(chosen.name, chosen.localized, locale)) : '';

  // The saved card: an upgrade can be charged to it while it is active and
  // Paddle is not renewing it; a failed renewal or a renewal under way holds
  // every plan change (the server refuses them too).
  const card = view.card ?? null;
  const cardFrozen = Boolean(card && isFuture(card.frozen_until));
  const blocked: string | null = card?.status === 'past_due'
    ? t('billing.account.picker.cardPastDue')
    : cardFrozen && card?.frozen_until
      ? t('billing.account.picker.cardFrozen', { time: billingMoment(card.frozen_until, locale) })
      : null;
  const cardName = card ? cardLabel(card, t) : '';
  const cardTotal = quote ? chargeFor(quoteNet(quote), view.vat_percent).total : 0;
  const cardUpgrade = Boolean(
    card
      && card.status === 'active'
      && !blocked
      && quote?.kind === 'upgrade'
      && quoteNet(quote) > 0
      && cardTotal >= (PADDLE_MIN_CHARGE_MINOR[view.currency] ?? Number.POSITIVE_INFINITY),
  );

  const choose = (planId: string) => {
    if (cardCharge?.phase === 'charging' || cardCharge?.phase === 'processing') return;
    setActionError(null);
    setCardCharge(null);
    if (planId === selected) setQuoteNonce((n) => n + 1);
    else setSelected(planId);
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      onOpenChange(false);
      onDone();
    } catch (e) {
      setActionError(accountErrorText(e, t));
      const err = e as { code?: string; details?: { quote?: PlanQuote | null } | null };
      // The server's new quote when the amount moved; otherwise ask again.
      if (err?.code === 'QUOTE_CHANGED' && err.details?.quote) setQuote(err.details.quote);
      else setQuoteNonce((n) => n + 1);
      setKey(newKey());
    } finally {
      setBusy(false);
    }
  };

  // A plan bought online can save the card for its renewals: the card then pays the period's full price.
  const payOnline = (purpose: 'plan' | 'upgrade') => {
    if (!quote || !chosen) return;
    onOpenChange(false);
    onPayOnline({
      purpose,
      planId: chosen.id,
      interval,
      priceMinor: quoteNet(quote),
      balanceMinor: quote.balance_minor,
      expectedNetMinor: quoteNet(quote),
      fullPriceMinor: purpose === 'plan' ? quote.period_price_minor : null,
      title: t(purpose === 'plan' ? 'billing.account.picker.buyTitle' : 'billing.account.picker.upgradeTitle', { plan: chosenName }),
    });
  };

  // The charge settled: the plan is upgraded, or (it changed meanwhile) the money stayed in the balance.
  const cardSettled = (result: Record<string, unknown> | null | undefined) => {
    if (result && 'error' in result) {
      setCardCharge({ phase: 'kept' });
      onDone();
      return;
    }
    onOpenChange(false);
    onDone();
  };

  const chargeCard = async () => {
    if (!quote || !cardUpgrade) return;
    const mine = session.current;
    const live = () => session.current === mine;
    setBusy(true);
    setActionError(null);
    setCardCharge({ phase: 'charging' });
    try {
      const started = await accountBillingApi.chargeCardUpgrade(workspaceId, { planId: quote.plan_id, expectedNetMinor: quoteNet(quote) });
      if (!live()) return;
      if (started.status === 'succeeded') {
        cardSettled(started.purpose_result);
        return;
      }
      // Paddle did not answer in time: the payment settles by its webhook (or the job).
      setCardCharge({ phase: 'processing' });
      for (let i = 0; i < CARD_POLL_TRIES; i += 1) {
        await new Promise((r) => setTimeout(r, CARD_POLL_MS));
        if (!live()) return;
        const payment = await accountBillingApi.payment(workspaceId, started.paymentId).catch(() => null);
        if (!live()) return;
        if (!payment || payment.status === 'pending') continue;
        if (payment.status === 'succeeded') {
          cardSettled(payment.purpose_result);
          return;
        }
        setCardCharge(payment.failure_reason === 'card_declined' ? { phase: 'declined', code: null } : { phase: 'failed' });
        return;
      }
      setCardCharge({ phase: 'pending' });
      onDone();
    } catch (e) {
      if (!live()) return;
      const err = e as { code?: string; details?: { code?: unknown; quote?: PlanQuote | null } | null };
      if (err?.code === 'CARD_DECLINED') {
        setCardCharge({ phase: 'declined', code: typeof err.details?.code === 'string' ? err.details.code : null });
        return;
      }
      setCardCharge(null);
      setActionError(accountErrorText(e, t));
      if (err?.code === 'QUOTE_CHANGED' && err.details?.quote) setQuote(err.details.quote);
      else setQuoteNonce((n) => n + 1);
      // The card changed under the page (a failed renewal, a renewal under way, removed): show it.
      if (['CARD_PAST_DUE', 'CARD_RENEWAL_IN_PROGRESS', 'CARD_NOT_AVAILABLE', 'CARD_CHARGE_IN_PROGRESS'].includes(String(err?.code))) onDone();
    } finally {
      if (live()) setBusy(false);
    }
  };

  const topup = (amountMinor: number) => {
    if (!onTopup) return;
    onOpenChange(false);
    onTopup(amountMinor);
  };

  const amount = (minor: number) => money(minor, locale, view.currency);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A card charge Paddle is still confirming may be left: it settles
        // on its own, and the page shows it once it does.
        if (busy && cardCharge?.phase !== 'processing') return;
        onOpenChange(next);
        if (!next && cardCharge?.phase === 'processing') onDone();
      }}
    >
      <DialogContent dir={dir} className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('billing.account.picker.title')}</DialogTitle>
          <DialogDescription>{t('billing.account.picker.description')}</DialogDescription>
        </DialogHeader>

        {showIntervals && (
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
          loadError ? null : <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden /></div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((p) => {
              const price = priceOf(p);
              const current = p.id === currentPlanId || (!paid && !trialing && p.is_free);
              const scheduled = view.scheduled_plan?.id === p.id;
              const sold = p.is_free || price !== null;
              const name = p.is_free ? t('billing.account.plan.free') : planLabel(p.name, p.localized, locale);
              return (
                // The card is not a control itself (it holds the features'
                // own toggle): its "select" button is, and a click anywhere on
                // the card does the same for a pointer.
                <div
                  key={p.id}
                  data-testid={`plan-option-${p.slug}`}
                  onClick={() => sold && choose(p.id)}
                  className={`flex flex-col gap-2 rounded-lg border p-4 text-start transition-colors ${sold ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'} ${selected === p.id ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/50'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{name}</span>
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
                  <Button
                    type="button"
                    size="sm"
                    variant={selected === p.id ? 'default' : 'outline'}
                    className="mt-auto"
                    disabled={!sold}
                    aria-pressed={selected === p.id}
                    aria-label={t('billing.account.picker.select', { plan: name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      choose(p.id);
                    }}
                  >
                    {t(selected === p.id ? 'billing.account.picker.selected' : 'billing.account.picker.selectShort')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4" aria-live="polite" data-testid="plan-quote">
            {quote && blocked && view.can_manage && quote.kind !== 'current' && quote.kind !== 'unavailable' && (
              <p className="flex items-start gap-1.5 text-sm text-destructive" data-testid="plan-card-blocked">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {blocked}
              </p>
            )}
            {!quote ? (
              loadError ? null : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
            ) : cardCharge && cardCharge.phase !== 'declined' && cardCharge.phase !== 'failed' ? (
              <CardChargeState
                state={cardCharge}
                cardName={cardName}
                amount={amount(cardTotal)}
                onClose={() => onOpenChange(false)}
              />
            ) : (
              <QuoteSummary
                quote={quote}
                planName={chosenName}
                isFree={Boolean(chosen?.is_free)}
                amount={amount}
                date={(iso) => billingDate(iso, locale)}
                busy={busy}
                blocked={Boolean(blocked)}
                canManage={view.can_manage}
                card={cardUpgrade && !cardCharge ? { name: cardName, total: cardTotal, onCharge: () => void chargeCard() } : null}
                declined={cardCharge?.phase === 'declined'
                  ? {
                    text: t('billing.account.picker.cardDeclined', {
                      card: cardName,
                      reason: t(`billing.account.card.failure.${cardFailureKind(cardCharge.code)}` as TranslationKey),
                    }),
                  }
                  : cardCharge?.phase === 'failed'
                    ? { text: t('billing.account.picker.cardFailed') }
                    : null}
                onBuy={() => void run(() => accountBillingApi.buyPlan(workspaceId, {
                  planId: quote.plan_id, interval, key, expectedNetMinor: quoteNet(quote),
                }))}
                onUpgrade={() => void run(() => accountBillingApi.upgrade(workspaceId, quote.plan_id, quoteNet(quote)))}
                onSchedule={() => void run(() => accountBillingApi.change(workspaceId, quote.plan_id, interval, quoteNet(quote, 'next_period')))}
                onCancelChange={() => paid && void run(() => accountBillingApi.change(
                  workspaceId, paid.plan_id, paid.billing_interval, quoteNet(quote),
                ))}
                onPayOnline={payOnline}
                onTopup={onTopup ? topup : undefined}
              />
            )}
            {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
          </div>
        )}
        {loadError && <p className="text-sm text-destructive" role="alert">{loadError}</p>}
      </DialogContent>
    </Dialog>
  );
}

function QuoteSummary({
  quote,
  planName,
  isFree,
  amount,
  date,
  busy,
  blocked = false,
  canManage,
  card = null,
  declined = null,
  onBuy,
  onUpgrade,
  onSchedule,
  onCancelChange,
  onPayOnline,
  onTopup,
}: {
  quote: PlanQuote;
  planName: string;
  isFree: boolean;
  amount: (minor: number) => string;
  date: (iso: string) => string;
  busy: boolean;
  /** Plan changes wait (the card's renewal failed, or Paddle is charging it): every action is off. */
  blocked?: boolean;
  canManage: boolean;
  /** An upgrade can be charged to the saved card: its label, the total, and the charge. */
  card?: { name: string; total: number; onCharge: () => void } | null;
  /** The card was declined (or the charge failed): why, with a top-up or the online checkout instead. */
  declined?: { text: string } | null;
  onBuy: () => void;
  onUpgrade: () => void;
  onSchedule: () => void;
  onCancelChange: () => void;
  onPayOnline: (purpose: 'plan' | 'upgrade') => void;
  onTopup?: (amountMinor: number) => void;
}) {
  const { t } = useTranslation();
  const spinner = busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : null;
  const off = busy || blocked;
  const net = quoteNet(quote);
  const covered = quote.shortfall_minor === 0;
  const periodEnd = quote.period_end ? date(quote.period_end) : '';
  // A next period already paid follows the choice: what it now takes or returns.
  const prepaidLines = (taken: number, returned: number) => (
    <>
      {taken > 0 && <p className="text-sm text-muted-foreground">{t('billing.account.picker.prepaidMore', { amount: amount(taken) })}</p>}
      {returned > 0 && <p className="text-sm text-muted-foreground">{t('billing.account.picker.prepaidBack', { amount: amount(returned) })}</p>}
    </>
  );
  // Without auto-renew and without a paid next period, a change at the
  // period end happens only if that period is paid; otherwise Free.
  const renewalNote = !quote.auto_renew && quote.prepaid_minor === null && !isFree && (
    <p className="text-xs text-muted-foreground" data-testid="schedule-renewal-note">
      {t('billing.account.picker.scheduleNeedsRenewal', { date: periodEnd })}
    </p>
  );
  // A change at the period end cannot be paid online: the balance is topped up first.
  const shortForChange = (short: number) => short > 0 && (
    <div className="space-y-2">
      <p className="text-xs text-destructive">{t('billing.account.picker.short', { amount: amount(short) })}</p>
      {canManage && onTopup && (
        <Button size="sm" variant="outline" onClick={() => onTopup(short)} disabled={off}>
          {t('billing.account.picker.topupShort', { amount: amount(short) })}
        </Button>
      )}
    </div>
  );
  const actions = (main: () => void, mainLabel: string, purpose: 'plan' | 'upgrade') =>
    canManage && (
      <div className="flex flex-wrap gap-2">
        {covered ? (
          <Button onClick={main} disabled={off}>{spinner}{mainLabel}</Button>
        ) : (
          <>
            <Button onClick={() => onPayOnline(purpose)} disabled={off}>{t('billing.account.picker.payOnline')}</Button>
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
          {quote.returned_minor > 0 && (
            <p className="text-sm text-muted-foreground">{t('billing.account.picker.prepaidReleased', { amount: amount(quote.returned_minor) })}</p>
          )}
          {actions(onBuy, t('billing.account.picker.payFromBalance', { amount: amount(Math.max(net, 0)) }), 'plan')}
        </>
      );
    case 'upgrade': {
      const cost = quote.upgrade_cost_minor ?? quote.amount_minor;
      const laterNet = quoteNet(quote, 'next_period');
      const laterShort = Math.max(laterNet - quote.balance_minor, 0);
      return (
        <>
          <p className="text-sm">
            {quote.billing_interval === 'yearly' && quote.months_left !== null
              ? t('billing.account.picker.upgradeYearly', { plan: planName, amount: amount(cost), months: String(quote.months_left) })
              : quote.months_left !== null && quote.months_left > 1
                ? t('billing.account.picker.upgradeMonths', { plan: planName, amount: amount(cost), months: String(quote.months_left) })
                : t('billing.account.picker.upgradeNow', { plan: planName, amount: amount(cost) })}
          </p>
          {prepaidLines(quote.amount_minor - cost, quote.returned_minor)}
          {declined && (
            <Alert variant="destructive" data-testid="card-declined">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertDescription className="space-y-2">
                <p>{declined.text}</p>
                {/* Paying online is offered below; topping up the balance first works too. */}
                {canManage && !covered && onTopup && (
                  <Button size="sm" variant="outline" onClick={() => onTopup(quote.shortfall_minor)} disabled={off}>
                    {t('billing.account.picker.topupShort', { amount: amount(quote.shortfall_minor) })}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {card && canManage ? (
            // The card pays the upgrade; the balance stays the second choice when it covers it.
            <div className="flex flex-wrap gap-2" data-testid="card-upgrade">
              <Button onClick={card.onCharge} disabled={off}>
                {spinner}
                {t('billing.account.picker.chargeCard', { amount: amount(card.total), card: card.name })}
              </Button>
              {covered && (
                <Button variant="outline" onClick={onUpgrade} disabled={off}>
                  {t('billing.account.picker.upgradeFromBalance', { amount: amount(Math.max(net, 0)) })}
                </Button>
              )}
            </div>
          ) : (
            actions(onUpgrade, t('billing.account.picker.upgradeFromBalance', { amount: amount(Math.max(net, 0)) }), 'upgrade')
          )}
          {quote.next_period_option && canManage && quote.period_end && (
            <div className="space-y-2 border-t pt-3" data-testid="next-period-option">
              <p className="text-sm text-muted-foreground">
                {quote.next_period_amount_minor > 0
                  ? t('billing.account.picker.nextPeriodOptionMore', { date: periodEnd, amount: amount(quote.next_period_amount_minor) })
                  : quote.next_period_returned_minor > 0
                    ? t('billing.account.picker.nextPeriodOptionBack', { date: periodEnd, amount: amount(quote.next_period_returned_minor) })
                    : t('billing.account.picker.nextPeriodOption', { date: periodEnd })}
              </p>
              {renewalNote}
              <Button variant="outline" onClick={onSchedule} disabled={off || laterShort > 0}>{t('billing.account.picker.fromNextPeriod')}</Button>
              {shortForChange(laterShort)}
            </div>
          )}
        </>
      );
    }
    case 'schedule':
      return (
        <>
          <p className="text-sm">
            {isFree
              ? t('billing.account.picker.scheduleFree', { date: periodEnd })
              : t('billing.account.picker.scheduleAt', {
                plan: planName,
                date: periodEnd,
                amount: quote.period_price_minor === null ? '—' : amount(quote.period_price_minor),
              })}
          </p>
          {prepaidLines(quote.amount_minor, quote.returned_minor)}
          {renewalNote}
          {canManage && (
            <Button onClick={onSchedule} disabled={off || quote.shortfall_minor > 0}>{spinner}{t('billing.account.picker.confirmChange')}</Button>
          )}
          {shortForChange(quote.shortfall_minor)}
        </>
      );
    case 'cancel_change':
      return (
        <>
          <p className="text-sm">{t('billing.account.picker.cancelChangeHint')}</p>
          {prepaidLines(quote.amount_minor, quote.returned_minor)}
          {canManage && (
            <Button variant="outline" onClick={onCancelChange} disabled={off || quote.shortfall_minor > 0}>
              {spinner}{t('billing.account.plan.cancelChange')}
            </Button>
          )}
          {shortForChange(quote.shortfall_minor)}
        </>
      );
    case 'current':
      return <p className="text-sm text-muted-foreground">{t('billing.account.picker.isCurrent')}</p>;
    default:
      // During a trial, Free is what follows it, not the current plan.
      if (quote.reason === 'trial_running' && quote.effective_at) {
        return <p className="text-sm text-muted-foreground">{t('billing.account.picker.freeAfterTrial', { date: date(quote.effective_at) })}</p>;
      }
      return <p className="text-sm text-muted-foreground">{t('billing.account.picker.unavailable')}</p>;
  }
}

/** An upgrade being charged to the card, still unconfirmed after a minute, or paid while the plan changed meanwhile. */
function CardChargeState({
  state,
  cardName,
  amount,
  onClose,
}: {
  state: Exclude<CardCharge, { phase: 'declined' } | { phase: 'failed' }>;
  cardName: string;
  amount: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (state.phase === 'charging' || state.phase === 'processing') {
    return (
      <p className="flex items-center gap-2 text-sm" role="status" data-testid="card-charging">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
        {t(state.phase === 'charging' ? 'billing.account.picker.cardCharging' : 'billing.account.picker.cardProcessing', {
          card: cardName,
          amount,
        })}
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid={`card-charge-${state.phase}`}>
      <p className="text-sm" role="status">
        {t(state.phase === 'pending' ? 'billing.account.picker.cardPending' : 'billing.account.picker.cardKept')}
      </p>
      <Button size="sm" variant="outline" onClick={onClose}>{t('billing.account.result.dismiss')}</Button>
    </div>
  );
}
