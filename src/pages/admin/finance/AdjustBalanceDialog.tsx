/**
 * Super Admin → account detail: a manual credit or debit (phase 6, D2, D5, D6).
 *
 * Safeguards, in order: a direction, an amount in the unit people read
 * (Toman, dollars, lira), a category and a reason (3-500 characters); a
 * preview of the balance after; a second, confirming step that repeats the
 * workspace, the signed amount, the currency and the new balance. The server
 * decides the currency (409 CURRENCY_CHANGED when it is not the one shown) and
 * refuses when the balance moved since it was shown (409 BALANCE_CHANGED).
 * The command key is made when the dialog opens and kept for retries of the
 * same submission, so a double click or a lost answer replays instead of
 * booking twice.
 */
import { useEffect, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Info } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';
import {
  ADJUST_CATEGORIES,
  ADJUST_REASON_MAX,
  ADJUST_REASON_MIN,
  AdminBillingApiError,
  useAdminAdjust,
  type AdjustCategory,
  type AdminAccountDetail,
} from '@/lib/adminSimpleBillingApi';
import { planPriceUnitLabel } from '@/lib/planPrice';
import { money } from '@/pages/app/billing/shared';
import { newPurchaseKey } from '@/pages/app/billing/account/accountUi';
import { TOPUP_LIMITS } from '../../../../shared/simpleBilling';
import { adjustProblem, amountToMinor, sbLabel, type AdjustDirection } from './financeUi';


export interface AdjustBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AdminAccountDetail;
  /** The direction the dialog opens with (the Credit / Debit button pressed). */
  direction?: AdjustDirection;
}

export default function AdjustBalanceDialog({ open, onOpenChange, account, direction: initialDirection = 'credit' }: AdjustBalanceDialogProps) {
  const { t, locale, dir } = useTranslation();
  const adjust = useAdminAdjust(account.workspace.id);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [direction, setDirection] = useState<AdjustDirection>(initialDirection);
  const [amountText, setAmountText] = useState('');
  const [category, setCategory] = useState<AdjustCategory | ''>('');
  const [reason, setReason] = useState('');
  const [commandKey, setCommandKey] = useState('');
  /** The balance and currency the confirming step showed: what the server must still find. */
  const [seen, setSeen] = useState<{ balance: number; currency: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A fresh form and a fresh command key every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep('form');
    setDirection(initialDirection);
    setAmountText('');
    setCategory('');
    setReason('');
    setCommandKey(newPurchaseKey());
    setSeen(null);
    setNotice(null);
    setError(null);
    adjust.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currency = account.currency;
  const balance = account.balance_minor;
  const minor = amountToMinor(amountText, currency);
  const problem = adjustProblem(direction, minor, balance, currency);
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= ADJUST_REASON_MIN && trimmed.length <= ADJUST_REASON_MAX;
  const canReview = problem === null && reasonOk && category !== '';
  const fmt = (v: number, cur = currency) => money(v, locale, cur);
  const signed = minor === null ? 0 : direction === 'debit' ? -minor : minor;
  const showCardHint = direction === 'credit' && (account.card !== null || account.auto_renew || (account.next_period_prepaid_minor ?? 0) > 0);
  const maxText = TOPUP_LIMITS[currency] ? fmt(TOPUP_LIMITS[currency].max) : '';

  const review = () => {
    if (!canReview) return;
    setSeen({ balance, currency });
    setError(null);
    setStep('confirm');
  };

  const backToForm = (message: string | null) => {
    setNotice(message);
    setStep('form');
    setSeen(null);
  };

  const submit = () => {
    if (!seen || minor === null || category === '') return;
    setError(null);
    adjust.mutate(
      {
        direction,
        amountMinor: minor,
        currency: seen.currency,
        reason: trimmed,
        category,
        expectedBalanceMinor: seen.balance,
        commandKey,
      },
      {
        onSuccess: (result) => {
          const text = t(
            result.replayed ? 'admin.simpleBilling.adjust.replayed' : 'admin.simpleBilling.adjust.done',
            { balance: fmt(result.balance_minor, result.account?.currency ?? seen.currency) },
          );
          toast.success(text);
          onOpenChange(false);
        },
        onError: (e) => {
          const err = e instanceof AdminBillingApiError ? e : null;
          const code = err?.code ?? '';
          const fresh = (err?.body?.account ?? null) as AdminAccountDetail | null;
          if (code === 'BALANCE_CHANGED') {
            setCommandKey(newPurchaseKey());
            backToForm(t('admin.simpleBilling.adjust.errors.BALANCE_CHANGED', {
              balance: fmt(fresh?.balance_minor ?? balance, fresh?.currency ?? currency),
            }));
          } else if (code === 'CURRENCY_CHANGED') {
            setCommandKey(newPurchaseKey());
            setAmountText('');
            backToForm(t('admin.simpleBilling.adjust.errors.CURRENCY_CHANGED', { currency: fresh?.currency ?? currency }));
          } else if (code === 'KEY_REUSED') {
            setCommandKey(newPurchaseKey());
            backToForm(sbLabel(t, 'adjust.errors.KEY_REUSED'));
          } else if (code === 'TOO_MANY_ADJUSTMENTS') {
            toast.error(sbLabel(t, 'adjust.errors.TOO_MANY_ADJUSTMENTS'));
          } else if (code === 'INSUFFICIENT_BALANCE' || code === 'ADJUST_TOO_LARGE' || code === 'INVALID_REQUEST') {
            setError(sbLabel(t, `adjust.errors.${code}`));
          } else {
            // A lost answer or a server error: the same key retries (and replays if it was booked).
            setError(sbLabel(t, 'adjust.errors.generic'));
          }
        },
      },
    );
  };

  const confirmAfter = seen ? seen.balance + signed : balance + signed;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!adjust.isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg" dir={dir}>
        <DialogHeader>
          <DialogTitle>{step === 'form' ? sbLabel(t, 'adjust.title') : sbLabel(t, 'adjust.confirmTitle')}</DialogTitle>
          <DialogDescription>
            {account.workspace.name} · {currency}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="space-y-4">
            {notice && (
              <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                {notice}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={sbLabel(t, 'adjust.title')}>
              {(['credit', 'debit'] as const).map((d) => {
                const Icon = d === 'credit' ? ArrowUpCircle : ArrowDownCircle;
                const active = direction === d;
                return (
                  <Button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    variant={active ? 'default' : 'outline'}
                    className={active && d === 'debit' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
                    onClick={() => setDirection(d)}
                  >
                    <Icon className="me-2 h-4 w-4" aria-hidden />
                    {sbLabel(t, `adjust.${d}`)}
                  </Button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adjust-amount">
                {sbLabel(t, 'adjust.amount')} ({planPriceUnitLabel(currency, locale)})
              </Label>
              <Input
                id="adjust-amount"
                inputMode="decimal"
                dir="ltr"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-invalid={amountText !== '' && problem !== null}
                autoFocus
              />
              {amountText !== '' && problem === 'invalid' && (
                <p className="text-xs text-destructive">{sbLabel(t, 'adjust.invalidAmount')}</p>
              )}
              {problem === 'tooLarge' && (
                <p className="text-xs text-destructive">{t('admin.simpleBilling.adjust.tooLarge', { max: maxText })}</p>
              )}
              {problem === 'overBalance' && (
                <p className="text-xs text-destructive">{sbLabel(t, 'adjust.overBalance')}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/40 p-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">{sbLabel(t, 'adjust.now')}</div>
                <div className="font-medium tabular-nums">{fmt(balance)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{sbLabel(t, 'adjust.after')}</div>
                <div className={`font-medium tabular-nums ${problem === 'overBalance' ? 'text-destructive' : ''}`} data-testid="adjust-after">
                  {minor === null ? '—' : fmt(balance + signed)}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adjust-category">{sbLabel(t, 'adjust.category')}</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as AdjustCategory)}>
                <SelectTrigger id="adjust-category"><SelectValue placeholder={sbLabel(t, 'adjust.category')} /></SelectTrigger>
                <SelectContent>
                  {ADJUST_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{sbLabel(t, `adjust.categories.${c}`, c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adjust-reason">{sbLabel(t, 'adjust.reason')}</Label>
              <Textarea
                id="adjust-reason"
                value={reason}
                maxLength={ADJUST_REASON_MAX}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>{t('admin.simpleBilling.adjust.reasonHint', { min: ADJUST_REASON_MIN, max: ADJUST_REASON_MAX })}</span>
                <span className="tabular-nums" dir="ltr">
                  {t('admin.simpleBilling.adjust.counter', { count: trimmed.length, max: ADJUST_REASON_MAX })}
                </span>
              </div>
            </div>

            {showCardHint && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {sbLabel(t, 'adjust.cardHint')}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => onOpenChange(false)}>{sbLabel(t, 'adjust.cancel')}</Button>
              <Button onClick={review} disabled={!canReview}>{sbLabel(t, 'adjust.review')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 rounded-md border p-4 text-sm">
              <dt className="text-muted-foreground">{sbLabel(t, 'adjust.amount')}</dt>
              <dd className={`text-end font-semibold tabular-nums ${direction === 'debit' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`} dir="ltr">
                {direction === 'debit' ? '−' : '+'}{fmt(minor ?? 0, seen?.currency)}
              </dd>
              <dt className="text-muted-foreground">{sbLabel(t, 'adjust.now')}</dt>
              <dd className="text-end tabular-nums">{fmt(seen?.balance ?? balance, seen?.currency)}</dd>
              <dt className="text-muted-foreground">{sbLabel(t, 'adjust.after')}</dt>
              <dd className="text-end font-semibold tabular-nums" data-testid="adjust-confirm-after">{fmt(confirmAfter, seen?.currency)}</dd>
              <dt className="text-muted-foreground">{sbLabel(t, 'adjust.category')}</dt>
              <dd className="text-end">{category ? sbLabel(t, `adjust.categories.${category}`, category) : ''}</dd>
            </dl>
            <p className="text-sm">
              {t('admin.simpleBilling.adjust.confirmText', {
                workspace: account.workspace.name,
                amount: `${direction === 'debit' ? '−' : '+'}${fmt(minor ?? 0, seen?.currency)}`,
                currency: seen?.currency ?? currency,
                after: fmt(confirmAfter, seen?.currency),
              })}
            </p>
            <blockquote className="border-s-2 ps-3 text-sm text-muted-foreground whitespace-pre-wrap break-words">{trimmed}</blockquote>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" disabled={adjust.isPending} onClick={() => backToForm(null)}>{sbLabel(t, 'adjust.back')}</Button>
              <Button
                variant={direction === 'debit' ? 'destructive' : 'default'}
                disabled={adjust.isPending}
                onClick={submit}
              >
                {sbLabel(t, direction === 'debit' ? 'adjust.confirmDebit' : 'adjust.confirmCredit')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
