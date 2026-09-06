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
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Loader2, Sparkles, FileText } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingCreateAiCreditInvoice, type BillingOverview } from '@/lib/billingApi';
import { billingDate, money, errorMessage } from './shared';

const RIAL_PER_TOMAN = 10;
const PRESET_TOMAN = [100_000, 250_000, 500_000, 1_000_000];

export default function AiCreditTab({
  workspaceId,
  canManage,
  overview,
  onChanged,
}: {
  workspaceId: string;
  canManage: boolean;
  /** Cycle + purchased credit already come from the overview read-model. */
  overview: BillingOverview;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [amountToman, setAmountToman] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();

  async function buy() {
    const toman = Number(amountToman);
    if (!Number.isFinite(toman) || toman <= 0) {
      toast.error(t('billing.wallet.invalidAmount'));
      return;
    }
    setBusy(true);
    try {
      const res = await billingCreateAiCreditInvoice(workspaceId, toman * RIAL_PER_TOMAN);
      onChanged();
      toast.success(t('billing.ai.invoiceCreated', { number: res.invoiceNumber || '' }));
      if (res.invoiceId) navigate(`/${slug}/billing/pay/invoice/${res.invoiceId}`);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const cycle = overview.aiCycle;
  const usedPct =
    cycle && cycle.allowanceIrr > 0 ? Math.min(100, Math.round((cycle.usedIrr / cycle.allowanceIrr) * 100)) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />
              {t('billing.ai.cycleAllowance')}
              {overview.aiMonthlyOnAnnual && (
                <Badge variant="outline">{t('billing.ai.annualBadge')}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cycle ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('billing.ai.cycleRange', {
                    start: billingDate(cycle.start, locale),
                    end: billingDate(cycle.end, locale),
                  })}
                </p>
                <Progress value={usedPct} />
                <div className="grid grid-cols-3 gap-2">
                  <Stat label={t('billing.ai.cycleAllowance')} value={money(cycle.allowanceIrr, locale)} />
                  <Stat label={t('billing.ai.used')} value={money(cycle.usedIrr, locale)} />
                  <Stat label={t('billing.ai.remaining')} value={money(cycle.remainingIrr, locale)} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('billing.ai.expiresOn', { date: billingDate(cycle.end, locale) })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('billing.ai.noCycle')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('billing.ai.purchased')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-3xl font-bold">{money(overview.aiPurchasedRemainingIrr, locale)}</p>
            <p className="text-xs text-muted-foreground">{t('billing.ai.consumptionNote')}</p>
            {canManage && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {PRESET_TOMAN.map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setAmountToman(String(p))}
                    >
                      {money(p * RIAL_PER_TOMAN, locale)}
                    </Button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="ai-amount">
                    {t('billing.wallet.customLabel')}
                  </label>
                  <Input
                    id="ai-amount"
                    inputMode="numeric"
                    dir="ltr"
                    value={amountToman}
                    onChange={(e) => setAmountToman(e.target.value.replace(/[^\d]/g, ''))}
                    placeholder={t('billing.wallet.custom')}
                  />
                  <p className="text-xs text-muted-foreground">{t('billing.ai.buyNote')}</p>
                </div>
                <Button size="lg" className="w-full gap-2" disabled={busy} onClick={buy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                  {t('billing.ai.issueCreditInvoice')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
