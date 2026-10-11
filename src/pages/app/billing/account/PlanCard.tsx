/**
 * The workspace's plan: what it is, when its period ends, what the next one
 * costs, a change scheduled for the period end, auto-renew, and the actions
 * (renew from the balance or online, choose another plan, renew a plan that
 * ran out). In the last 7 days of an unpaid period it says so plainly: at
 * the due moment the workspace moves to the free plan. Cancelling a change
 * opens the plan picker on the current plan, so what it moves in the
 * balance is shown before it is confirmed.
 *
 * With a saved card (Multi Region, docs/billing/SIMPLE_BILLING.md) the card
 * pays each renewal in full, a day before the period ends: the card block
 * says when and how much, and offers changing or removing the card. A
 * renewal the card could not pay shows as a red alert with "update card
 * and pay" and "renew from balance". Without a card, where one can be
 * saved, "turn on automatic card payments" pays the next period now with a
 * card that then renews the plan.
 */
import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation, type TranslationKey } from '@/i18n';
import { accountBillingApi, type AccountView, type CardView } from '@/lib/accountBillingApi';
import { billingDate, money } from '../shared';
import { PADDLE_MIN_CHARGE_MINOR, chargeFor } from '../../../../../shared/simpleBilling';
import type { PayOnlineRequest } from './PayOnlineDialog';
import type { PlanPreselect } from './PlanPickerDialog';
import {
  accountErrorText,
  billingMoment,
  billingReturnOrigin,
  cardExpiry,
  cardFailureKind,
  cardLabel,
  followCheckout,
  isFuture,
  planLabel,
  stashCardReturn,
} from './accountUi';

export default function PlanCard({
  workspaceId,
  slug,
  view,
  onChanged,
  onChoosePlan,
  onPayOnline,
}: {
  workspaceId: string;
  /** The workspace's address, for the return from Paddle after a card change. */
  slug: string;
  view: AccountView;
  onChanged: () => void;
  /** Opens the plan picker, on a plan when given. */
  onChoosePlan: (preselect?: PlanPreselect) => void;
  onPayOnline: (request: PayOnlineRequest) => void;
}) {
  const { t, locale } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const plan = view.plan;
  const paid = view.paid_period;
  const name = plan.is_free && !plan.name ? t('billing.account.plan.free') : planLabel(plan.name, plan.localized, locale);
  const prepaid = view.next_period_prepaid_minor !== null || view.next_period_paid === true;
  const renewalPrice = view.renewal?.price_minor ?? null;
  const canRenewFromBalance = renewalPrice !== null && view.balance_minor >= renewalPrice;
  // A live card renews only by its own charge, never from the balance (the
  // due step leaves a card account alone); without one, the 3a rule.
  const card: CardView | null = view.card ?? null;
  const cardPastDue = card?.status === 'past_due';
  const cardRenews = Boolean(
    card && card.status === 'active' && card.auto_renew && !card.scheduled_cancel_at && card.next_charge_minor !== null,
  );
  const frozen = Boolean(card && isFuture(card.frozen_until));
  const willAutoRenew = card ? cardRenews : view.auto_renew && canRenewFromBalance;
  const warn = Boolean(
    paid && !prepaid && !cardPastDue && view.days_left !== null && view.days_left <= 7 && view.renewal && !willAutoRenew,
  );
  const scheduledName = view.scheduled_plan
    ? (view.scheduled_plan.is_free ? t('billing.account.plan.free') : planLabel(view.scheduled_plan.name, view.scheduled_plan.localized, locale))
    : null;
  // The plan the next period is for (a scheduled change's, else this one).
  const renewalName = view.renewal ? planLabel(view.renewal.name, view.renewal.localized, locale) : name;
  // Only once the workspace is on Free (a canceled or past-due plan that still applies is not over).
  const lapsed = !paid && plan.is_free ? view.lapsed ?? null : null;
  const lapsedName = lapsed ? planLabel(lapsed.name, lapsed.localized, locale) : '';
  // Saving a card pays the next period now (an early renewal), at a price Paddle can charge.
  const cardSetupOffered = Boolean(
    !card
      && view.card_available
      && view.can_manage
      && paid
      && !prepaid
      && view.renewal
      && renewalPrice !== null
      && chargeFor(renewalPrice, view.vat_percent).total >= (PADDLE_MIN_CHARGE_MINOR[view.currency] ?? Number.POSITIVE_INFINITY),
  );

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setError(accountErrorText(e, t));
      // The period changed under the page (another tab, the job, Paddle): show what is true now.
      const code = (e as { code?: string } | null)?.code;
      if (
        [
          'PERIOD_CHANGED', 'ALREADY_RENEWED', 'NO_PAID_PLAN', 'QUOTE_CHANGED',
          'CARD_NOT_FOUND', 'CARD_PAST_DUE', 'CARD_PAYS_RENEWAL', 'CARD_RENEWAL_IN_PROGRESS', 'CARD_NOT_AVAILABLE',
        ].includes(String(code))
      ) onChanged();
    } finally {
      setBusy(null);
    }
  };
  const spin = (id: string) => (busy === id ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : null);
  const amount = (minor: number) => money(minor, locale, view.currency);

  // Change the card in Paddle's overlay; for a failed renewal Paddle's
  // transaction is that renewal, so paying it there also renews the plan.
  // Completing it returns to this page (?card=…); closing it only refreshes.
  const updateCard = (id: 'card-update' | 'card-pay') => act(id, async () => {
    if (!card) return;
    const started = await accountBillingApi.updateCard(
      workspaceId,
      `${billingReturnOrigin()}/${slug}/billing?card=${id === 'card-pay' ? 'paid' : 'updated'}`,
    );
    stashCardReturn(workspaceId, card);
    await followCheckout(started, {
      locale,
      closeDialog: () => undefined,
      onError: (e) => setError(accountErrorText(e, t)),
      onClosed: onChanged,
    });
  });

  const renewFromBalance = paid && renewalPrice !== null && (
    <Button
      variant={cardPastDue ? 'outline' : 'default'}
      disabled={busy !== null || (frozen && !cardPastDue)}
      onClick={() => void act('renew', () => accountBillingApi.renew(workspaceId, paid.current_period_end, renewalPrice))}
    >
      {spin('renew')}
      {t('billing.account.plan.renewFromBalance', { amount: amount(renewalPrice) })}
    </Button>
  );

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

        {card && (
          <CardBlock
            card={card}
            paidEnd={paid?.current_period_end ?? null}
            prepaid={prepaid}
            frozen={frozen}
            canManage={view.can_manage}
            busy={busy}
            amount={amount}
            onUpdate={() => void updateCard(cardPastDue ? 'card-pay' : 'card-update')}
            onRemove={() => setConfirmRemove(true)}
            renewFromBalance={paid && !prepaid && view.renewal && canRenewFromBalance ? renewFromBalance : null}
          />
        )}

        {paid && view.can_manage && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-2">
            <div>
              <Label htmlFor="auto-renew" className="font-medium">{t('billing.account.plan.autoRenew')}</Label>
              <p className="text-xs text-muted-foreground">
                {card
                  ? t('billing.account.card.autoRenewHint', { card: cardLabel(card, t) })
                  : t('billing.account.plan.autoRenewHint')}
              </p>
            </div>
            <Switch
              id="auto-renew"
              checked={card ? card.auto_renew : view.auto_renew}
              disabled={busy !== null}
              onCheckedChange={(enabled) => void act('auto', () => accountBillingApi.setAutoRenew(workspaceId, enabled))}
            />
          </div>
        )}

        {view.can_manage && (
          <div className="flex flex-wrap gap-2">
            {/* With a card the card pays the renewal (paying online for it is refused); the past-due alert offers the balance. */}
            {paid && !prepaid && view.renewal && renewalPrice !== null && !cardPastDue && (
              canRenewFromBalance ? (
                renewFromBalance
              ) : !card ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => onPayOnline({
                    purpose: 'renewal',
                    priceMinor: renewalPrice,
                    balanceMinor: view.balance_minor,
                    expectedNetMinor: renewalPrice,
                    fullPriceMinor: renewalPrice,
                    cardInterval: view.renewal?.billing_interval,
                    title: t('billing.account.plan.renewOnlineTitle', { plan: renewalName }),
                  })}
                >
                  {t('billing.account.plan.renewOnline')}
                </Button>
              ) : null
            )}
            {cardSetupOffered && renewalPrice !== null && (
              <Button
                variant="outline"
                disabled={busy !== null}
                data-testid="card-setup"
                onClick={() => onPayOnline({
                  purpose: 'renewal',
                  priceMinor: renewalPrice,
                  balanceMinor: view.balance_minor,
                  expectedNetMinor: renewalPrice,
                  fullPriceMinor: renewalPrice,
                  cardInterval: view.renewal?.billing_interval,
                  autoRenew: true,
                  title: t('billing.account.card.setupTitle', { plan: renewalName }),
                })}
              >
                <CreditCard className="me-2 h-4 w-4" aria-hidden />
                {t('billing.account.card.setup')}
              </Button>
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

      {card && (
        <AlertDialog open={confirmRemove} onOpenChange={(open) => busy !== 'card-remove' && setConfirmRemove(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('billing.account.card.removeTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('billing.account.card.removeConfirm', { card: cardLabel(card, t) })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy === 'card-remove'}>{t('billing.common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={busy === 'card-remove'}
                onClick={(e) => {
                  // Stays open until Paddle confirmed: a refusal is shown on the card.
                  e.preventDefault();
                  void act('card-remove', () => accountBillingApi.removeCard(workspaceId)).finally(() => setConfirmRemove(false));
                }}
              >
                {spin('card-remove')}
                {t('billing.account.card.remove')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Card>
  );
}

/**
 * The saved card: which one, when Paddle charges it next and how much, a
 * scheduled removal, a card that expires before then, the freeze while a
 * renewal is being charged, and — when the renewal failed — the red alert.
 */
function CardBlock({
  card,
  paidEnd,
  prepaid,
  frozen,
  canManage,
  busy,
  amount,
  onUpdate,
  onRemove,
  renewFromBalance,
}: {
  card: CardView;
  paidEnd: string | null;
  prepaid: boolean;
  frozen: boolean;
  canManage: boolean;
  busy: string | null;
  amount: (minor: number) => string;
  onUpdate: () => void;
  onRemove: () => void;
  /** Offered in the past-due alert when the balance covers the renewal. */
  renewFromBalance: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const label = cardLabel(card, t);
  const expiry = cardExpiry(card);
  const pastDue = card.status === 'past_due';
  const date = (iso: string) => billingDate(iso, locale);
  const spinner = (id: string) => (busy === id ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden /> : null);

  let next: string;
  if (card.scheduled_cancel_at) {
    next = t('billing.account.card.removedOn', { card: label, date: date(card.scheduled_cancel_at) });
  } else if (!card.auto_renew) {
    next = t('billing.account.card.autoRenewOff', { card: label });
  } else if (!paidEnd) {
    next = t('billing.account.card.saving', { card: label });
  } else if (card.next_charge_minor === null) {
    next = t('billing.account.card.noCharge', { card: label });
  } else if (!card.next_charge_at) {
    next = t('billing.account.card.chargeBeforeRenewal', { card: label, amount: amount(card.next_charge_minor) });
  } else {
    next = t(prepaid ? 'billing.account.card.chargeLater' : 'billing.account.card.charge', {
      card: label,
      amount: amount(card.next_charge_minor),
      date: date(card.next_charge_at),
      renewsOn: date(paidEnd),
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="plan-card-block">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="font-medium" data-testid="card-label">{label}</span>
        {expiry && <span className="text-xs text-muted-foreground">{t('billing.account.card.expires', { date: expiry })}</span>}
      </div>

      {pastDue ? (
        <Alert variant="destructive" data-testid="card-past-due">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertDescription className="space-y-2">
            <p className="font-medium">{t('billing.account.card.pastDueTitle')}</p>
            <p>
              {t('billing.account.card.pastDue', {
                card: label,
                reason: t(`billing.account.card.failure.${cardFailureKind(card.last_failure?.code)}` as TranslationKey),
              })}
            </p>
            {paidEnd && <p>{t('billing.account.card.pastDueDeadline', { date: date(paidEnd) })}</p>}
            {canManage && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" disabled={busy !== null} onClick={onUpdate}>
                  {spinner('card-pay')}
                  {t('billing.account.card.updateAndPay')}
                </Button>
                {renewFromBalance}
              </div>
            )}
            {canManage && renewFromBalance && (
              <p className="text-xs">{t('billing.account.card.renewFromBalanceRemoves')}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground" data-testid="card-next">{next}</p>
      )}

      {!pastDue && card.expires_before_next_charge && (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="card-expiring">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('billing.account.card.expiresSoon', { card: label })}
        </p>
      )}

      {!pastDue && frozen && card.frozen_until && (
        <p className="text-xs text-muted-foreground" data-testid="card-frozen">
          {t('billing.account.card.frozen', { time: billingMoment(card.frozen_until, locale) })}
        </p>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {!pastDue && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={onUpdate}>
              {spinner('card-update')}
              {t('billing.account.card.change')}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onRemove}>
            {t('billing.account.card.remove')}
          </Button>
        </div>
      )}
    </div>
  );
}
