/**
 * Pay online for a plan, a renewal or an upgrade. The gateway charges what
 * the balance is missing (at least the top-up minimum), plus VAT when the
 * edition has it; the payment is credited to the balance and spent on the
 * purchase in the same step. The server recomputes every amount.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { accountBillingApi, type AccountGateway, type BillingInterval } from '@/lib/accountBillingApi';
import { money } from '../shared';
import { TOPUP_LIMITS, chargeFor } from '../../../../../shared/simpleBilling';
import GatewayPicker from './GatewayPicker';
import { accountErrorText, billingReturnOrigin, followCheckout } from './accountUi';

export interface PayOnlineRequest {
  purpose: 'plan' | 'renewal' | 'upgrade';
  planId?: string;
  interval?: BillingInterval;
  /** What the purchase costs in total, and what the balance already covers. */
  priceMinor: number;
  balanceMinor: number;
  title: string;
}

export default function PayOnlineDialog({
  request,
  onOpenChange,
  workspaceId,
  slug,
  currency,
  vatPercent,
  gateways,
  onCurrencyChanged,
}: {
  request: PayOnlineRequest | null;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  currency: string;
  vatPercent: number | null;
  gateways: AccountGateway[];
  onCurrencyChanged?: () => void;
}) {
  const { t, locale, dir } = useTranslation();
  const [provider, setProvider] = useState<string>(gateways[0]?.provider_name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = gateways.find((g) => g.provider_name === provider) ?? gateways[0];

  const shortfall = request ? Math.max(request.priceMinor - request.balanceMinor, 0) : 0;
  const minimum = TOPUP_LIMITS[currency]?.min ?? 0;
  const net = Math.max(shortfall, minimum);
  const charge = chargeFor(net, vatPercent);

  const pay = async () => {
    if (!request || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const started = await accountBillingApi.checkout(workspaceId, {
        purpose: request.purpose,
        planId: request.planId,
        interval: request.interval,
        currency,
        providerName: chosen.provider_name,
        callbackUrl: `${billingReturnOrigin()}/${slug}/billing`,
      });
      await followCheckout(started, {
        locale,
        closeDialog: () => {
          setBusy(false);
          onOpenChange(false);
        },
      });
    } catch (e) {
      setError(accountErrorText(e, t));
      setBusy(false);
      if ((e as { code?: string })?.code === 'CURRENCY_CHANGED') onCurrencyChanged?.();
    }
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent dir={dir} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title ?? ''}</DialogTitle>
          <DialogDescription>{t('billing.account.payOnline.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <dl className="space-y-1.5 rounded-md bg-muted/50 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('billing.account.payOnline.price')}</dt>
              <dd className="tabular-nums">{money(request?.priceMinor ?? 0, locale, currency)}</dd>
            </div>
            {(request?.balanceMinor ?? 0) > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billing.account.payOnline.fromBalance')}</dt>
                <dd className="tabular-nums">{money(Math.min(request?.balanceMinor ?? 0, request?.priceMinor ?? 0), locale, currency)}</dd>
              </div>
            )}
            {net > shortfall && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billing.account.payOnline.minimum')}</dt>
                <dd className="tabular-nums">{money(net - shortfall, locale, currency)}</dd>
              </div>
            )}
            {vatPercent !== null && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billing.account.topup.vat', { percent: String(vatPercent) })}</dt>
                <dd className="tabular-nums">{money(charge.tax, locale, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t pt-1.5 font-semibold">
              <dt>{t('billing.account.topup.total')}</dt>
              <dd className="tabular-nums" data-testid="pay-online-total">{money(charge.total, locale, currency)}</dd>
            </div>
          </dl>
          <GatewayPicker gateways={gateways} value={chosen?.provider_name} onChange={setProvider} disabled={busy} />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={pay} disabled={busy || !chosen || !request} className="w-full sm:w-auto">
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
            {busy ? t('billing.account.topup.paying') : t('billing.account.topup.pay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
