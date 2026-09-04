/**
 * Plans — choose a plan, then let the SERVER say what it costs.
 *
 * The flow is deliberately three steps and never collapses into one:
 *   1. pick the plan and, for an upgrade, when it should apply;
 *   2. read the server preview (remaining days, amount payable, extra AI
 *      credit for the running cycle);
 *   3. confirm — which creates a real invoice (immediate) or schedules the
 *      change (next cycle).
 *
 * The confirm call carries the exact amount that was previewed, so if pricing
 * or the period moved underneath a stale tab the server rejects it instead of
 * charging a number the customer never saw.
 *
 * Annual pricing is shown as "X / year" alongside "AI credit: Y per month" —
 * never as a fabricated yearly AI figure, because the allowance is released
 * monthly.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SkeletonStats } from '@/components/common/Skeletons';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import {
  billingV2Plans,
  billingV2PreviewPlanChange,
  billingV2ApplyPlanChange,
  type PlansView,
  type PlanCard,
  type PlanChangeMode,
  type PlanChangePreview,
} from '@/lib/billingV2Api';
import { money, ErrorState, errorMessage } from './shared';

export default function PlansTab({
  workspaceId,
  canManage,
  reloadKey,
  onChanged,
}: {
  workspaceId: string;
  canManage: boolean;
  reloadKey: number;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<PlansView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval_] = useState<'monthly' | 'yearly'>('monthly');

  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();

  const load = () => {
    setLoading(true);
    setError(null);
    billingV2Plans(workspaceId)
      .then((res) => {
        setData(res);
        if (res.currentInterval) setInterval_(res.currentInterval);
      })
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, reloadKey]);

  /**
   * One click = one invoice. Exactly like a wallet top-up: the server prices
   * the change and issues the document, then the customer lands on the payment
   * page. The preview call is still made — it is what produces the amount the
   * apply call must match — but the customer never has to confirm it twice.
   */
  async function choosePlan(plan: PlanCard) {
    setBusy(plan.id);
    try {
      let mode: PlanChangeMode = 'immediate';
      let preview: PlanChangePreview;
      try {
        preview = await billingV2PreviewPlanChange(workspaceId, { planId: plan.id, interval, mode });
      } catch {
        // Server refuses an immediate change (typically a downgrade): schedule it.
        mode = 'next_cycle';
        preview = await billingV2PreviewPlanChange(workspaceId, { planId: plan.id, interval, mode });
      }

      const res = await billingV2ApplyPlanChange(workspaceId, {
        planId: plan.id,
        interval,
        mode,
        expectedAmountIrr: preview.amountIrr,
      });
      onChanged();
      if (res.invoiceId) {
        toast.success(t('billingV2.plans.invoiceCreated', { number: res.invoiceNumber || '' }));
        navigate(`/${slug}/billing/pay/invoice/${res.invoiceId}`);
      } else {
        toast.success(t('billingV2.plans.scheduled'));
      }
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }


  if (loading) return <SkeletonStats count={3} />;
  if (error) return <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Segmented switch: one control, one visibly selected state. */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-full border bg-muted/60 p-1 shadow-sm">
          {(['monthly', 'yearly'] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setInterval_(i)}
              className={`rounded-full px-5 py-2 text-sm font-semibold transition-all ${
                interval === i
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`billingV2.plans.${i}` as any)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid items-stretch gap-5 md:grid-cols-2 xl:grid-cols-3">
        {data.plans.map((plan, planIdx) => {
          const isCurrent = plan.id === data.currentPlanId && interval === data.currentInterval;
          const isPending = !isCurrent && plan.id === data.pendingPlanId;
          const price = interval === 'yearly' ? plan.yearlyPriceIrr : plan.monthlyPriceIrr;
          const accent = `var(--plan-${(planIdx % 5) + 1})`;
          return (
            <Card
              key={plan.id}
              style={{ ['--plan-accent' as any]: accent }}
              className={`relative flex h-full flex-col overflow-hidden transition-all hover:-translate-y-1 hover:shadow-xl ${
                isCurrent ? 'border-2 shadow-lg' : 'border-2 border-border/60'
              }`}
            >
              {/* Colour signature: a top ribbon plus a soft wash, unique per plan. */}
              <div
                className="absolute inset-x-0 top-0 h-1.5"
                style={{ background: `linear-gradient(90deg, hsl(var(--plan-accent)), hsl(var(--plan-accent) / 0.45))` }}
                aria-hidden
              />
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-32"
                style={{ background: `linear-gradient(to bottom, hsl(var(--plan-accent) / 0.14), transparent)` }}
                aria-hidden
              />
              {isCurrent && (
                <div
                  className="pointer-events-none absolute inset-0 rounded-lg"
                  style={{ boxShadow: `inset 0 0 0 2px hsl(var(--plan-accent) / 0.75)` }}
                  aria-hidden
                />
              )}
              <CardHeader className="relative pb-2 pt-6">
                <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span className="text-lg font-bold" style={{ color: `hsl(var(--plan-accent))` }}>
                    {plan.name}
                  </span>
                  {isCurrent && (
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white"
                      style={{ background: `hsl(var(--plan-accent))` }}
                    >
                      {t('billingV2.plans.currentPlan')}
                    </span>
                  )}
                  {isPending && <Badge variant="outline">{t('billingV2.overview.pendingChange')}</Badge>}
                </CardTitle>
                {plan.description && (
                  <p className="pt-1 text-sm leading-relaxed text-muted-foreground">{plan.description}</p>
                )}
              </CardHeader>
              <CardContent className="relative flex flex-1 flex-col gap-4">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className="text-3xl font-extrabold tracking-tight tabular-nums"
                    style={{ color: `hsl(var(--plan-accent))` }}
                  >
                    {plan.isFree ? t('billingV2.plans.free') : money(price, locale)}
                  </span>
                  {!plan.isFree && (
                    <span className="text-xs text-muted-foreground">
                      {interval === 'yearly' ? t('billingV2.plans.perYear') : t('billingV2.plans.perMonth')}
                    </span>
                  )}
                </div>

                {plan.aiMonthlyAllowanceIrr > 0 && (
                  <div
                    className="rounded-xl p-3"
                    style={{
                      border: `1px solid hsl(var(--plan-accent) / 0.28)`,
                      background: `hsl(var(--plan-accent) / 0.07)`,
                    }}
                  >
                    <p className="flex items-center gap-1.5 text-xs font-semibold">
                      <Sparkles className="h-3.5 w-3.5" style={{ color: `hsl(var(--plan-accent))` }} />
                      {t('billingV2.plans.aiMonthly', { amount: money(plan.aiMonthlyAllowanceIrr, locale) })}
                    </p>
                    {interval === 'yearly' && (
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('billingV2.plans.aiAnnualNote')}</p>
                    )}
                  </div>
                )}

                {Array.isArray(plan.features) && plan.features.length > 0 && (
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {(plan.features as string[]).slice(0, 6).map((f, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: `hsl(var(--plan-accent))` }} />
                        <span>{String(f)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <Button
                  size="lg"
                  className="!mt-auto w-full border-0 text-base text-white hover:opacity-90"
                  style={
                    isCurrent
                      ? { background: 'transparent', color: `hsl(var(--plan-accent))`, border: `1px solid hsl(var(--plan-accent) / 0.5)` }
                      : { background: `linear-gradient(90deg, hsl(var(--plan-accent)), hsl(var(--plan-accent) / 0.8))` }
                  }
                  disabled={isCurrent || !canManage || busy !== null}
                  onClick={() => choosePlan(plan)}
                >
                  {busy === plan.id && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  {isCurrent ? t('billingV2.plans.currentPlan') : t('billingV2.plans.choose')}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

    </div>
  );
}

