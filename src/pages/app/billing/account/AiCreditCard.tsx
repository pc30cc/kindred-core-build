/**
 * The AI credit card of the billing page (simple billing phase 5,
 * docs/billing/SIMPLE_BILLING.md): what the AI wallet holds, in the account
 * currency (Toman in Iran), split into the plan's monthly credit (until its
 * end) and purchased credit (which never expires), and the credit packs
 * Super Admin sells.
 *
 * Packs are sold only while AI billing is ENFORCED: in METER_ONLY the card is
 * not shown at all. Without an exchange rate no amount is shown and nothing
 * is offered. A pack is bought from the balance with one confirmation; when
 * the balance is short the same dialog pays the difference online
 * (PayOnlineDialog, purpose 'ai_pack'). The server decides every amount: the
 * page sends the price it showed, and a pack changed meanwhile is refused
 * (QUOTE_CHANGED) with the card as it is now.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { accountBillingApi, type AccountView, type AiPack, type AiSection } from '@/lib/accountBillingApi';
import { toast } from '@/lib/toast';
import { billingDate, money } from '../shared';
import { bonusPercent, packLabel } from '../../../../../shared/aiPacks';
import type { PayOnlineRequest } from './PayOnlineDialog';
import { accountErrorText, aiSectionOf, newPurchaseKey } from './accountUi';

/** Refusals after which the card shows what is on offer now. */
const REDRAW = new Set(['QUOTE_CHANGED', 'AI_PACK_NOT_AVAILABLE', 'AI_PACKS_UNAVAILABLE', 'AI_CREDIT_UNAVAILABLE']);

type Chosen = { pack: AiPack; key: string; online: boolean };

export default function AiCreditCard({
  workspaceId,
  view,
  version = 0,
  onChanged,
  onPayOnline,
}: {
  workspaceId: string;
  /** The account: its balance (what a pack is paid from) and whether this member can buy. */
  view: Pick<AccountView, 'balance_minor' | 'can_manage' | 'currency'>;
  /** Changes when the page reloaded after a payment or a plan change: the card reads its section again. */
  version?: number;
  /** A pack was bought: the page reloads the balance and the history. */
  onChanged: () => void;
  onPayOnline: (request: PayOnlineRequest) => void;
}) {
  const { t, locale } = useTranslation();
  const [section, setSection] = useState<AiSection | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest read is shown (a slow answer never overwrites a newer one).
  const reads = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++reads.current;
    try {
      const next = await accountBillingApi.ai(workspaceId);
      if (id === reads.current) setSection(next);
    } catch {
      // The AI card is an extra: the rest of the page works without it.
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
    return () => {
      // Unmounted (or another workspace): answers still on their way are dropped.
      reads.current += 1;
    };
  }, [refresh, version]);

  if (!section || section.mode !== 'ENFORCED') return null;

  const currency = section.currency;
  const amount = (minor: number) => money(minor, locale, currency);
  const display = section.display;
  const packs = view.can_manage && section.sellable && display ? section.packs : [];
  const nameOf = (pack: AiPack) => packLabel(pack, locale, t('billing.account.ai.packCredit', { credit: amount(pack.credit_minor) }));

  const open = (pack: AiPack) => {
    setError(null);
    // One key per purchase: a retry after a lost answer buys once.
    setChosen({ pack, key: newPurchaseKey(), online: view.balance_minor < pack.price_minor });
  };

  const close = () => {
    if (busy) return;
    setChosen(null);
    setError(null);
  };

  const payOnline = (pack: AiPack) => {
    setChosen(null);
    setError(null);
    onPayOnline({
      purpose: 'ai_pack',
      packId: pack.id,
      priceMinor: pack.price_minor,
      balanceMinor: view.balance_minor,
      expectedPriceMinor: pack.price_minor,
      title: t('billing.account.ai.payOnlineTitle', { pack: nameOf(pack) }),
    });
  };

  const buy = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const result = await accountBillingApi.buyAiPack(workspaceId, {
        packId: chosen.pack.id,
        expectedPriceMinor: chosen.pack.price_minor,
        key: chosen.key,
      });
      setChosen(null);
      toast.success(t('billing.account.ai.bought', { credit: money(result.credit_minor, locale, result.currency || currency) }));
      onChanged();
      void refresh();
    } catch (e) {
      const code = String((e as { code?: unknown } | null)?.code ?? '');
      const text = accountErrorText(e, t);
      if (REDRAW.has(code)) {
        // The pack, its price, the rate or the mode changed: show what is on offer now.
        setChosen(null);
        toast.error(text);
        const fresh = aiSectionOf<AiSection>(e);
        if (fresh) setSection(fresh);
        else void refresh();
      } else if (code === 'INSUFFICIENT_BALANCE') {
        // The balance went down meanwhile (another tab, a renewal): pay the difference online.
        setChosen((c) => (c ? { ...c, online: true } : c));
        setError(text);
        onChanged();
      } else {
        setError(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const pack = chosen?.pack ?? null;
  const shortfall = pack ? Math.max(pack.price_minor - view.balance_minor, 0) : 0;
  const online = Boolean(chosen && (chosen.online || shortfall > 0));

  return (
    <Card data-testid="ai-credit-card">
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" aria-hidden />
          {t('billing.account.ai.title')}
        </CardDescription>
        {display && (
          <>
            <CardTitle className="text-3xl tabular-nums" data-testid="ai-available">
              {amount(display.available_minor)}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t('billing.account.ai.available')}</p>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!display ? (
          <p className="text-sm text-muted-foreground" data-testid="ai-unavailable">{t('billing.account.ai.unavailable')}</p>
        ) : (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {display.plan_remaining_minor > 0 && (
              <li data-testid="ai-plan-part">
                {section.plan_expires_at
                  ? t('billing.account.ai.planPart', {
                    amount: amount(display.plan_remaining_minor),
                    date: billingDate(section.plan_expires_at, locale),
                  })
                  : t('billing.account.ai.planPartNoDate', { amount: amount(display.plan_remaining_minor) })}
              </li>
            )}
            <li data-testid="ai-purchased-part">
              {t('billing.account.ai.purchasedPart', { amount: amount(display.purchased_remaining_minor) })}
            </li>
          </ul>
        )}

        {packs.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">{t('billing.account.ai.packsTitle')}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {packs.map((p) => {
                const bonus = bonusPercent(p);
                const labelled = Boolean(packLabel(p, locale, ''));
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`ai-pack-${p.id}`}
                    onClick={() => open(p)}
                    className="flex flex-col items-start gap-1 rounded-lg border bg-card p-3 text-start transition-colors hover:border-primary hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{nameOf(p)}</span>
                      {bonus > 0 && (
                        <Badge variant="secondary" data-testid={`ai-pack-bonus-${p.id}`}>
                          {t('billing.account.ai.bonus', { percent: bonus })}
                        </Badge>
                      )}
                    </span>
                    {labelled && (
                      <span className="text-xs text-muted-foreground">
                        {t('billing.account.ai.packCredit', { credit: amount(p.credit_minor) })}
                      </span>
                    )}
                    <span className="text-sm font-semibold tabular-nums text-foreground">{amount(p.price_minor)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={Boolean(chosen)} onOpenChange={(next) => !next && close()}>
        <DialogContent className="sm:max-w-md" data-testid="ai-pack-confirm">
          <DialogHeader>
            <DialogTitle>{t('billing.account.ai.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {pack ? t('billing.account.ai.confirmBody', { price: amount(pack.price_minor), credit: amount(pack.credit_minor) }) : ''}
            </DialogDescription>
          </DialogHeader>
          {pack && !online && (
            <p className="rounded-md bg-muted/50 p-3 text-sm tabular-nums" data-testid="ai-pack-balance-after">
              {t('billing.account.ai.balanceAfter', { amount: amount(view.balance_minor - pack.price_minor) })}
            </p>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              {t('billing.common.cancel')}
            </Button>
            {pack && online ? (
              <Button onClick={() => payOnline(pack)} disabled={busy} data-testid="ai-pack-pay-online">
                {t('billing.account.ai.payOnline', { amount: amount(Math.max(shortfall, 0)) })}
              </Button>
            ) : (
              <Button onClick={() => void buy()} disabled={busy || !pack} data-testid="ai-pack-buy">
                {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
                {t('billing.account.ai.buy')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
