/**
 * AI Credit tab (Phase 5/6) — customer-facing wallet + top-up.
 *
 * Deliberately shows ONLY the numbers a customer needs: remaining/used/
 * monthly-remaining/purchased. METER_ONLY, ENFORCED, reserved amount,
 * provider cost, FX and multiplier NEVER reach this component.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { formatToman, tomanLabel } from '@/lib/money';
import { toast } from '@/lib/toast';
import { billingError } from '@/lib/billing-i18n';
import {
  aiBillingSummary, aiCreditTopupConfig, aiCreditTopupCheckout,
  type AiBillingSummary,
} from '@/lib/api';

export default function AiCreditTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AiBillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    aiBillingSummary(workspaceId)
      .then(setSummary)
      .catch(() => { /* transient */ })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!summary) return null;

  const totalAllowance = summary.available + summary.usedThisCycle;
  const pct = totalAllowance > 0 ? Math.min(100, Math.round((summary.usedThisCycle / totalAllowance) * 100)) : 0;

  return (
    <div className="space-y-4" dir="rtl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" /> {t('billingIran.aiCredit.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-3xl font-bold text-foreground">{formatToman(summary.available, 'fa')}</div>
            <p className="text-xs text-muted-foreground mt-1">{t('billingIran.aiCredit.remainingLabel')}</p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1.5">
              {t('billingIran.aiCredit.ofPeriodAllowance', { total: formatToman(totalAllowance, 'fa') })}
            </p>
            <Progress value={pct} className="h-2" />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryRow label={t('billingIran.aiCredit.usedLabel')} value={formatToman(summary.usedThisCycle, 'fa')} />
            <SummaryRow label={t('billingIran.aiCredit.monthlyRemainingLabel')} value={formatToman(summary.planRemaining, 'fa')} />
            <SummaryRow label={t('billingIran.aiCredit.purchasedRemainingLabel')} value={formatToman(summary.purchasedRemaining, 'fa')} />
          </div>

          <Button className="w-full sm:w-auto" onClick={() => setDialogOpen(true)}>
            {t('billingIran.aiCredit.increaseCta')}
          </Button>
        </CardContent>
      </Card>

      <TopupDialog workspaceId={workspaceId} open={dialogOpen} onOpenChange={setDialogOpen} onSuccess={load} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function TopupDialog({
  workspaceId, open, onOpenChange, onSuccess,
}: { workspaceId: string; open: boolean; onOpenChange: (v: boolean) => void; onSuccess: () => void }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<{ presetsToman: number[]; minToman: number; maxToman: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    aiCreditTopupConfig(workspaceId).then((c) => {
      setConfig(c);
      setSelected(c.presetsToman[0] ?? null);
    }).catch(() => setConfig(null));
  }, [open, workspaceId]);

  const amount = custom ? Number(custom.replace(/[^\d]/g, '')) : selected;

  async function handlePay() {
    if (!config || !amount || amount < config.minToman || amount > config.maxToman) {
      toast.error(t('billingIran.aiCredit.topup.invalidAmount'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await aiCreditTopupCheckout(workspaceId, {
        amountToman: amount,
        callbackUrl: `${window.location.origin}/app/billing`,
      });
      if (result.paymentUrl) window.location.href = result.paymentUrl;
    } catch (e: any) {
      toast.error(billingError('fa', e?.message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>{t('billingIran.aiCredit.topup.title')}</DialogTitle>
        </DialogHeader>

        {config && (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">{t('billingIran.aiCredit.topup.presetLabel')}</p>
              <div className="grid grid-cols-2 gap-2">
                {config.presetsToman.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => { setSelected(preset); setCustom(''); }}
                    className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                      selected === preset && !custom
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/60 text-foreground hover:border-primary/40'
                    }`}
                  >
                    {`${preset.toLocaleString('fa-IR')} ${tomanLabel('fa')}`}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm text-muted-foreground mb-2 block">{t('billingIran.aiCredit.topup.customAmountLabel')}</label>
              <Input
                inputMode="numeric"
                placeholder={t('billingIran.aiCredit.topup.customAmountPlaceholder')}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                dir="ltr"
                className="text-end"
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {t('billingIran.aiCredit.topup.minMaxHint', { min: config.minToman.toLocaleString('fa-IR'), max: config.maxToman.toLocaleString('fa-IR') })}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('billingIran.aiCredit.topup.cancel')}</Button>
          <Button onClick={handlePay} disabled={submitting || !config}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
            {t('billingIran.aiCredit.topup.payCta')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
