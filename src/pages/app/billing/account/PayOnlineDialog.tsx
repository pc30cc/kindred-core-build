/**
 * Pay online for a plan, a renewal or an upgrade. The gateway charges what
 * the balance is missing (at least the top-up minimum), plus VAT when the
 * edition has it; the payment is credited to the balance and spent on the
 * purchase in the same step. The server recomputes every amount.
 *
 * Where a card can be saved (Multi Region, a Paddle gateway with automatic
 * renewal on), a plan or a renewal offers "renew automatically with this
 * card", ticked by default: the card then pays the full price now, leaving
 * the balance as it is, and Paddle charges it every period until it is
 * turned off. Only the gateways that can save a card are listed then.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { accountBillingApi, type AccountGateway, type BillingInterval } from '@/lib/accountBillingApi';
import { money } from '../shared';
import { PADDLE_MIN_CHARGE_MINOR, TOPUP_LIMITS, chargeFor } from '../../../../../shared/simpleBilling';
import GatewayPicker from './GatewayPicker';
import { toast } from '@/lib/toast';
import { accountErrorText, billingReturnOrigin, followCheckout } from './accountUi';

export interface PayOnlineRequest {
  purpose: 'plan' | 'renewal' | 'upgrade';
  planId?: string;
  interval?: BillingInterval;
  /** What the purchase costs in total, and what the balance already covers. */
  priceMinor: number;
  balanceMinor: number;
  /** The amount the quote showed (plan, upgrade): a different one now is refused, never charged. */
  expectedNetMinor?: number;
  title: string;
  /**
   * The period's full price (a plan: the quote's period price; a renewal:
   * the renewal price): what a card saved for automatic renewal pays now and
   * then every period. Without it no card is offered.
   */
  fullPriceMinor?: number | null;
  /** The interval the saved card then renews on (a renewal sends none of its own). */
  cardInterval?: BillingInterval;
  /** Whether "renew automatically with this card" starts ticked (default: yes). */
  autoRenew?: boolean;
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
  cardAvailable = false,
  cardProviders = [],
}: {
  request: PayOnlineRequest | null;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  currency: string;
  vatPercent: number | null;
  gateways: AccountGateway[];
  onCurrencyChanged?: () => void;
  /** A card can be saved for automatic renewal here (the account view's card_available). */
  cardAvailable?: boolean;
  /** The gateways that can save one (card_providers). */
  cardProviders?: string[];
}) {
  const { t, locale, dir } = useTranslation();
  const [provider, setProvider] = useState<string>(gateways[0]?.provider_name ?? '');
  const [saveCard, setSaveCard] = useState(request?.autoRenew ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A card is offered for a plan or a renewal whose full price Paddle can charge.
  const cardGateways = gateways.filter((g) => cardProviders.includes(g.provider_name));
  const fullPrice = request?.fullPriceMinor ?? null;
  const recurring = fullPrice !== null && fullPrice > 0 ? chargeFor(fullPrice, vatPercent) : null;
  const canSaveCard = Boolean(
    cardAvailable
      && request
      && (request.purpose === 'plan' || request.purpose === 'renewal')
      && recurring
      && recurring.total >= (PADDLE_MIN_CHARGE_MINOR[currency] ?? Number.POSITIVE_INFINITY)
      && cardGateways.length > 0,
  );
  const withCard = canSaveCard && saveCard;
  const listed = withCard ? cardGateways : gateways;
  const chosen = listed.find((g) => g.provider_name === provider) ?? listed[0];
  const cardInterval = request?.cardInterval ?? request?.interval ?? 'monthly';

  const shortfall = request ? Math.max(request.priceMinor - request.balanceMinor, 0) : 0;
  const minimum = TOPUP_LIMITS[currency]?.min ?? 0;
  // With the card the full price is paid (the balance stays as it is).
  const net = withCard && fullPrice !== null ? fullPrice : Math.max(shortfall, minimum);
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
        // The return says a card was being saved: the page waits for it to show.
        callbackUrl: `${billingReturnOrigin()}/${slug}/billing${withCard ? '?card=setup' : ''}`,
        expectedNetMinor: withCard && fullPrice !== null ? fullPrice : request.expectedNetMinor,
        ...(withCard ? { autoRenew: true } : {}),
      });
      await followCheckout(started, {
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
      if ((e as { code?: string })?.code === 'CURRENCY_CHANGED') onCurrencyChanged?.();
    }
  };

  return (
    <Dialog open={Boolean(request)} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent dir={dir} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title ?? ''}</DialogTitle>
          <DialogDescription>
            {t(withCard ? 'billing.account.payOnline.descriptionCard' : 'billing.account.payOnline.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {canSaveCard && recurring && (
            <div className="space-y-1.5 rounded-md border p-3" data-testid="pay-online-card">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="pay-online-auto-renew"
                  checked={saveCard}
                  disabled={busy}
                  onCheckedChange={(checked) => setSaveCard(checked === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="pay-online-auto-renew" className="font-medium leading-snug">
                  {t('billing.account.payOnline.autoRenew')}
                </Label>
              </div>
              <p className="ps-6 text-xs text-muted-foreground" data-testid="pay-online-card-note">
                {withCard
                  ? t(cardInterval === 'yearly' ? 'billing.account.payOnline.autoRenewYearly' : 'billing.account.payOnline.autoRenewMonthly', {
                    amount: money(recurring.total, locale, currency),
                  })
                  : t('billing.account.payOnline.autoRenewOff')}
              </p>
            </div>
          )}
          <dl className="space-y-1.5 rounded-md bg-muted/50 p-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('billing.account.payOnline.price')}</dt>
              <dd className="tabular-nums">{money(withCard && fullPrice !== null ? fullPrice : request?.priceMinor ?? 0, locale, currency)}</dd>
            </div>
            {!withCard && (request?.balanceMinor ?? 0) > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billing.account.payOnline.fromBalance')}</dt>
                <dd className="tabular-nums">{money(Math.min(request?.balanceMinor ?? 0, request?.priceMinor ?? 0), locale, currency)}</dd>
              </div>
            )}
            {!withCard && net > shortfall && (
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
          <GatewayPicker gateways={listed} value={chosen?.provider_name} onChange={setProvider} disabled={busy} />
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
