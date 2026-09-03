/**
 * AI credit — plan allowance for the running cycle, plus separately purchased
 * credit that survives it.
 *
 * The two pools are never merged into one "total credit" number: the plan
 * allowance expires at the end of the cycle, purchased credit does not, and
 * blending them would misrepresent what the customer actually keeps.
 *
 * Buying credit issues a real invoice; payment happens on the invoice detail
 * screen like every other charge.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonStats } from '@/components/common/Skeletons';
import { Loader2, Sparkles, Plus } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingV2AiSummary, billingV2BuyAiCredit, type AiSummary } from '@/lib/billingV2Api';
import { billingDate, money, ErrorState, errorMessage } from './shared';

const RIAL_PER_TOMAN = 10;
const PRESET_TOMAN = [100_000, 250_000, 500_000, 1_000_000];

export default function AiCreditTab({
  workspaceId,
  canManage,
  reloadKey,
  onOpenInvoice,
  onChanged,
}: {
  workspaceId: string;
  canManage: boolean;
  reloadKey: number;
  onOpenInvoice: (invoiceId: string) => void;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<AiSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [amountToman, setAmountToman] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    billingV2AiSummary(workspaceId)
      .then(setData)
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, reloadKey]);

  async function buy() {
    const toman = Number(amountToman);
    if (!Number.isFinite(toman) || toman <= 0) {
      toast.error(t('billingV2.wallet.invalidAmount'));
      return;
    }
    setBusy(true);
    try {
      const res = await billingV2BuyAiCredit(workspaceId, toman * RIAL_PER_TOMAN);
      setOpen(false);
      onChanged();
      toast.success(t('billingV2.ai.invoiceCreated', { number: res.invoiceNumber || '' }));
      if (res.invoiceId) onOpenInvoice(res.invoiceId);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonStats count={2} />;
  if (error) return <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />;
  if (!data) return null;

  const cycle = data.aiCycle;
  const usedPct =
    cycle && cycle.allowanceIrr > 0 ? Math.min(100, Math.round((cycle.usedIrr / cycle.allowanceIrr) * 100)) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              {t('billingV2.ai.cycleAllowance')}
              {data.servicePeriod?.interval === 'yearly' && (
                <Badge variant="outline">{t('billingV2.ai.monthlyOnAnnual')}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cycle ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('billingV2.overview.cycleRange', {
                    start: billingDate(cycle.start, locale),
                    end: billingDate(cycle.end, locale),
                  })}
                </p>
                <Progress value={usedPct} />
                <div className="grid grid-cols-3 gap-2">
                  <Stat label={t('billingV2.overview.allowance')} value={money(cycle.allowanceIrr, locale)} />
                  <Stat label={t('billingV2.overview.used')} value={money(cycle.usedIrr, locale)} />
                  <Stat label={t('billingV2.overview.remaining')} value={money(cycle.remainingIrr, locale)} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('billingV2.ai.expiresOn', { date: billingDate(cycle.end, locale) })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('billingV2.ai.noCycle')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('billingV2.ai.purchased')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-3xl font-bold">{money(data.purchasedRemainingIrr, locale)}</p>
            <p className="text-xs text-muted-foreground">{t('billingV2.ai.purchasedNote')}</p>
            {canManage && (
              <Button
                size="lg"
                className="w-full"
                onClick={() => {
                  setAmountToman('');
                  setOpen(true);
                }}
              >
                <Plus className="me-2 h-4 w-4" />
                {t('billingV2.ai.buy')}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('billingV2.ai.buyTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {PRESET_TOMAN.map((p) => (
                <Button key={p} size="sm" variant="outline" onClick={() => setAmountToman(String(p))}>
                  {money(p * RIAL_PER_TOMAN, locale)}
                </Button>
              ))}
            </div>
            <Input
              inputMode="numeric"
              dir="ltr"
              value={amountToman}
              onChange={(e) => setAmountToman(e.target.value.replace(/[^\d]/g, ''))}
              placeholder={t('billingV2.wallet.amountPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">{t('billingV2.ai.buyNote')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t('billingV2.common.cancel')}
            </Button>
            <Button onClick={buy} disabled={busy}>
              {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('billingV2.ai.createInvoice')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}
