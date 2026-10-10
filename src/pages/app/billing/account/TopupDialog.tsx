/**
 * Top up the account balance: the amount (in the units people read), the
 * payment method, and — when the edition has VAT for this currency — the
 * VAT line and the total. The server recomputes all of it; this only shows
 * what will be charged.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { parsePlanPriceInput, planPriceDecimals } from '@/lib/planPrice';
import { toast } from '@/lib/toast';
import { accountBillingApi, type AccountGateway } from '@/lib/accountBillingApi';
import { money } from '../shared';
import { TOPUP_LIMITS, chargeFor, topupAmountProblem } from '../../../../../shared/simpleBilling';
import GatewayPicker from './GatewayPicker';
import {
  QUICK_TOPUPS,
  accountErrorText,
  billingReturnOrigin,
  followCheckout,
  toDisplayAmount,
  toMinorAmount,
} from './accountUi';

export interface TopupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  currency: string;
  vatPercent: number | null;
  gateways: AccountGateway[];
  onCurrencyChanged?: () => void;
  /** Opens with this amount filled in (what a change is missing), never below the minimum. */
  initialAmountMinor?: number | null;
}

export default function TopupDialog({
  open,
  onOpenChange,
  workspaceId,
  slug,
  currency,
  vatPercent,
  gateways,
  onCurrencyChanged,
  initialAmountMinor = null,
}: TopupDialogProps) {
  const { t, locale, dir } = useTranslation();
  const [raw, setRaw] = useState('');

  useEffect(() => {
    if (!open || !initialAmountMinor || initialAmountMinor <= 0) return;
    const wanted = Math.max(initialAmountMinor, TOPUP_LIMITS[currency]?.min ?? 0);
    // Rounded up to what can be typed, so it never falls short.
    const factor = 10 ** planPriceDecimals(currency);
    setRaw(String(Math.ceil(toDisplayAmount(wanted, currency) * factor - 1e-6) / factor));
  }, [open, initialAmountMinor, currency]);
  const [provider, setProvider] = useState<string>(gateways[0]?.provider_name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const limits = TOPUP_LIMITS[currency];
  const display = parsePlanPriceInput(raw);
  const minor = display === null ? null : toMinorAmount(display, currency);
  const problem = minor === null ? (raw.trim() ? 'TOPUP_AMOUNT_INVALID' : null) : topupAmountProblem(minor, currency);
  const charge = useMemo(() => (minor && !problem ? chargeFor(minor, vatPercent) : null), [minor, problem, vatPercent]);
  const chosen = gateways.find((g) => g.provider_name === provider) ?? gateways[0];

  const pay = async () => {
    if (!minor || problem || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const callbackUrl = `${billingReturnOrigin()}/${slug}/billing`;
      const res = await accountBillingApi.topup(workspaceId, {
        amountMinor: minor,
        currency,
        providerName: chosen.provider_name,
        callbackUrl,
      });
      await followCheckout(res, {
        locale,
        closeDialog: () => {
          setBusy(false);
          onOpenChange(false);
        },
        onError: (e) => toast.error(accountErrorText(e, t)),
      });
    } catch (e) {
      setError(accountErrorText(e, t));
      setBusy(false);
      // The account's currency is not the one shown: the page reloads it.
      if ((e as { code?: string })?.code === 'CURRENCY_CHANGED') onCurrencyChanged?.();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent dir={dir} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('billing.account.topup.title')}</DialogTitle>
          {limits && (
            <DialogDescription>
              {t('billing.account.topup.amountHint', {
                min: money(limits.min, locale, currency),
                max: money(limits.max, locale, currency),
              })}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="topup-amount">{t('billing.account.topup.amount')}</Label>
            <Input
              id="topup-amount"
              inputMode="decimal"
              dir="ltr"
              autoFocus
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-invalid={Boolean(problem)}
              disabled={busy}
            />
            <div className="flex flex-wrap gap-2" aria-label={t('billing.account.topup.quick')}>
              {(QUICK_TOPUPS[currency] ?? []).map((amount) => (
                <Button
                  key={amount}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRaw(String(amount))}
                >
                  {money(toMinorAmount(amount, currency) ?? 0, locale, currency)}
                </Button>
              ))}
            </div>
            {problem && raw.trim() && (
              <p className="text-sm text-destructive">{t(`billing.account.errors.${problem}` as never)}</p>
            )}
          </div>

          <GatewayPicker gateways={gateways} value={chosen?.provider_name} onChange={setProvider} disabled={busy} />

          {charge && (
            <dl className="space-y-1.5 rounded-md bg-muted/50 p-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billing.account.topup.credit')}</dt>
                <dd className="tabular-nums">{money(charge.net, locale, currency)}</dd>
              </div>
              {vatPercent !== null && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billing.account.topup.vat', { percent: String(vatPercent) })}</dt>
                  <dd className="tabular-nums">{money(charge.tax, locale, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t pt-1.5 font-semibold">
                <dt>{t('billing.account.topup.total')}</dt>
                <dd className="tabular-nums">{money(charge.total, locale, currency)}</dd>
              </div>
            </dl>
          )}

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>

        <DialogFooter>
          <Button onClick={pay} disabled={busy || !charge || !chosen} className="w-full sm:w-auto">
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
            {busy ? t('billing.account.topup.paying') : t('billing.account.topup.pay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
