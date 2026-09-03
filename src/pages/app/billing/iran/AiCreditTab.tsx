/**
 * AI Credit tab (Phase 5/6) — customer-facing wallet + top-up.
 *
 * Deliberately shows ONLY the numbers a customer needs: remaining/used/
 * monthly-remaining/purchased. METER_ONLY, ENFORCED, reserved amount,
 * provider cost, FX and multiplier NEVER reach this component.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
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

  const donut = [
    { key: 'used', label: t('billingIran.aiCredit.usedLabel'), value: Math.max(0, summary.usedThisCycle), color: 'hsl(var(--primary))' },
    { key: 'plan', label: t('billingIran.aiCredit.monthlyRemainingLabel'), value: Math.max(0, summary.planRemaining), color: 'hsl(var(--primary) / 0.45)' },
    { key: 'purchased', label: t('billingIran.aiCredit.purchasedRemainingLabel'), value: Math.max(0, summary.purchasedRemaining), color: 'hsl(var(--muted-foreground) / 0.35)' },
  ];
  const donutTotal = donut.reduce((s, d) => s + d.value, 0);
  const chartData = donutTotal > 0 ? donut.filter((d) => d.value > 0) : [{ key: 'empty', label: '', value: 1, color: 'hsl(var(--muted))' }];

  return (
    <div className="space-y-4" dir="rtl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" /> {t('billingIran.aiCredit.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-6 md:grid-cols-[220px_1fr] md:items-center">
            {/* Donut usage chart */}
            <div className="relative mx-auto h-[200px] w-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={62}
                    outerRadius={92}
                    paddingAngle={donutTotal > 0 ? 2 : 0}
                    stroke="none"
                    startAngle={90}
                    endAngle={-270}
                  >
                    {chartData.map((d) => <Cell key={d.key} fill={d.color} />)}
                  </Pie>
                  {donutTotal > 0 && (
                    <Tooltip
                      formatter={(v: any, n: any) => [formatToman(Number(v), 'fa'), n]}
                      contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12, direction: 'rtl' }}
                    />
                  )}
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] text-muted-foreground">{t('billingIran.aiCredit.remainingLabel')}</span>
                <span className="text-lg font-bold text-foreground">{formatToman(summary.available, 'fa')}</span>
                <span className="mt-0.5 text-[11px] text-muted-foreground">{t('billingIran.aiCredit.usedPct', { percent: pct.toLocaleString('fa-IR') })}</span>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('billingIran.aiCredit.ofPeriodAllowance', { total: formatToman(totalAllowance, 'fa') })}
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {donut.map((d) => (
                  <div key={d.key} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card p-3">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
                    <div className="min-w-0">
                      <div className="truncate text-xs text-muted-foreground">{d.label}</div>
                      <div className="mt-0.5 text-sm font-semibold text-foreground">{formatToman(d.value, 'fa')}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground">{t('billingIran.aiCredit.sourceHint')}</p>
            </div>
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
