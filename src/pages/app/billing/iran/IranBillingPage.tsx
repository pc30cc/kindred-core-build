/**
 * Iran-native Billing/Financial page (Phases 3-11 of the Iran billing
 * redesign). Persian-only, RTL, Toman-only, Jalali dates, manual-renewal
 * model. This tree is completely isolated from the generic subscription UI
 * in BillingPage.tsx so Turkey/Global/multi stay untouched.
 */
import { useEffect, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

import { LayoutGrid, Sparkles, Receipt, Gauge, Calendar, Loader2, ArrowRight, CreditCard, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingError } from '@/lib/billing-i18n';
import { formatToman } from '@/lib/money';
import { billingCheckout, billingVerifyCallback, billingGetPortal, billingGetPaymentIntent, billingInvoicePreview, billingCancelInvoice, aiBillingSummary, type BillingReceipt, type AiBillingSummary, type BillingInvoice } from '@/lib/api';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { SkeletonStats, SkeletonCard } from '@/components/common/Skeletons';
import { useIranBilling } from './useIranBilling';
import { jalaliDate, planHighlights } from './format';
import PaymentResult, { type PaymentResultStatus } from './PaymentResult';
import AiCreditTab from './AiCreditTab';
import TransactionsTab from './TransactionsTab';

type Interval = 'monthly' | 'yearly';

export default function IranBillingPage() {
  const { t } = useTranslation();
  const state = useIranBilling();
  const { workspaceId, loading, plans, subscription, payments, attempts, effective, providerCapabilities, reload } = state;
  const { data: members } = useWorkspaceMembers(workspaceId || undefined);

  const [result, setResult] = useState<{ status: PaymentResultStatus; receipt?: BillingReceipt | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [interval, setInterval_] = useState<Interval>('monthly');
  const [renewalPlan, setRenewalPlan] = useState<any | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // ── Return & Verify — status ALWAYS comes from the server. ──
  //
  // A verify can answer `pending`: the customer paid and the server is still
  // applying the result (or recovering from a crash mid-finalization). In that
  // case we must NEVER show a failure — we poll the intent until it settles.
  useEffect(() => {
    if (!workspaceId) return;
    const qs = new URLSearchParams(window.location.search);
    const intentId = qs.get('intent');
    const provider = qs.get('provider');
    if (!intentId || !provider) return;

    const params: Record<string, string> = {};
    qs.forEach((v, k) => { if (k !== 'intent' && k !== 'provider') params[k] = v; });

    let cancelled = false;
    setVerifying(true);

    async function pollIntent(attempt = 0): Promise<void> {
      if (cancelled) return;
      if (attempt >= 10) {
        setResult({ status: 'pending' });
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled) return;
      try {
        const s = await billingGetPaymentIntent(intentId as string);
        if (cancelled) return;
        if (s.status === 'succeeded') {
          setResult({ status: 'success', receipt: s.receipt });
          reload();
          return;
        }
        if (!s.pending) {
          setResult({ status: 'failure' });
          return;
        }
      } catch { /* transient — keep polling */ }
      return pollIntent(attempt + 1);
    }

    billingVerifyCallback({ workspaceId, provider, params, intentId })
      .then(async (res) => {
        if (cancelled) return;
        if (res.verified && !res.pending) {
          setResult({ status: 'success', receipt: res.receipt });
          reload();
          return;
        }
        if (res.pending) {
          setVerifying(false);
          setResult({ status: 'pending' });
          await pollIntent();
          return;
        }
        setResult({ status: 'failure' });
      })
      .catch(() => { if (!cancelled) setResult({ status: 'failure' }); })
      .finally(() => {
        if (cancelled) return;
        setVerifying(false);
        window.history.replaceState({}, '', window.location.pathname);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const currentPlan = subscription?.billing_plans || plans.find((p) => p.is_free);
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';
  const isTrial = subscription?.status === 'trialing';
  const currentPlanName = ((currentPlan?.localized || {}).fa?.name || '').trim() || currentPlan?.name || t('billingIran.plans.free');

  async function startCheckout(plan: any, targetInterval: Interval, intentId?: string) {
    if (!workspaceId) return;
    setCheckingOut(true);
    try {
      const res = await billingCheckout({
        workspaceId,
        planId: plan.id,
        interval: targetInterval,
        currency: 'IRR',
        callbackUrl: `${window.location.origin}${window.location.pathname}`,
        intentId,
      });
      if (res.paymentUrl) window.location.href = res.paymentUrl;
    } catch (e: any) {
      toast.error(billingError('fa', e?.message));
    } finally {
      setCheckingOut(false);
      setRenewalPlan(null);
    }
  }

  if (verifying) {
    return (
      <div className="flex items-center justify-center py-24" dir="rtl">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (result) {
    const r = result.receipt;
    return (
      <PaymentResult
        status={result.status}
        amountIrr={r?.amountIrr}
        purpose={
          r?.purchaseType === 'ai_credit_topup'
            ? t('billingIran.result.purposeAiCredit')
            : r?.planName
              ? t('billingIran.result.purposePlan', { plan: r.planName })
              : undefined
        }
        dateIso={r?.paidAt || undefined}
        trackingNumber={r?.providerRef || undefined}
        orderNumber={r?.orderId}
        periodEndIso={r?.periodEnd || undefined}
        onBack={() => setResult(null)}
        onRetry={result.status === 'failure' ? () => setResult(null) : undefined}
      />
    );
  }


  if (loading || !workspaceId) {
    return (
      <div className="space-y-5" dir="rtl">
        <SkeletonStats count={3} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in text-start" dir="rtl">
      {/* Hero header — same language as the rest of the app pages */}
      <div className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3.5">
          <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <CreditCard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t('billingIran.pageTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-xl">{t('billingIran.pageSubtitle')}</p>
          </div>
        </div>
      </div>


      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
        <TabsList className="w-full md:w-auto flex md:inline-flex h-auto gap-1 p-1.5 rounded-2xl bg-muted/60 border border-border/60 overflow-x-auto no-scrollbar">
          <TabsTrigger value="overview" className="flex-1 md:flex-none justify-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Gauge className="w-4 h-4" /> {t('billingIran.tabs.overview')}
          </TabsTrigger>
          <TabsTrigger value="plans" className="flex-1 md:flex-none justify-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <LayoutGrid className="w-4 h-4" /> {t('billingIran.tabs.plans')}
          </TabsTrigger>
          <TabsTrigger value="aiCredit" className="flex-1 md:flex-none justify-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Sparkles className="w-4 h-4" /> {t('billingIran.tabs.aiCredit')}
          </TabsTrigger>
          <TabsTrigger value="transactions" className="flex-1 md:flex-none justify-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium whitespace-nowrap data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Receipt className="w-4 h-4" /> {t('billingIran.tabs.transactions')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-5 space-y-4">
          <OverviewCard
            currentPlan={currentPlan}
            currentPlanName={currentPlanName}
            subscription={subscription}
            isActive={isActive}
            isTrial={isTrial}
            providerCapabilities={providerCapabilities}
            onRenew={() => setRenewalPlan(currentPlan)}
            onChangePlan={() => setActiveTab('plans')}
          />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <UsageSummary effective={effective} operatorsUsed={members?.length ?? 0} />
            </div>
            <AiCreditSummaryCard workspaceId={workspaceId} onOpen={() => setActiveTab('aiCredit')} />
          </div>
        </TabsContent>

        <TabsContent value="plans" className="mt-5">
          <PlansGrid
            plans={plans}
            currentPlan={currentPlan}
            interval={interval}
            onIntervalChange={setInterval_}
            onSelect={(plan) => setRenewalPlan(plan)}
          />
        </TabsContent>

        <TabsContent value="aiCredit" className="mt-5">
          <AiCreditTab workspaceId={workspaceId} />
        </TabsContent>

        <TabsContent value="transactions" className="mt-5">
          <TransactionsTab payments={payments} attempts={attempts} currentPlanName={currentPlanName} />
        </TabsContent>
      </Tabs>

      <RenewalDialog
        workspaceId={workspaceId}
        plan={renewalPlan}
        interval={interval}
        currentPlan={currentPlan}
        periodEnd={subscription?.current_period_end || null}
        submitting={checkingOut}
        onCancel={() => { setRenewalPlan(null); reload(); }}
        onConfirm={(targetInterval, intentId) => startCheckout(renewalPlan, targetInterval, intentId)}
      />
    </div>
  );
}

function OverviewCard({
  currentPlan, currentPlanName, subscription, isActive, isTrial, providerCapabilities, onRenew, onChangePlan,
}: {
  currentPlan: any; currentPlanName: string; subscription: any; isActive: boolean; isTrial: boolean;
  providerCapabilities: Record<string, boolean> | null;
  onRenew: () => void; onChangePlan: () => void;
}) {
  const { t } = useTranslation();
  // Provider-capability-driven (Phase 1): a manage-subscription link is only
  // ever shown when the resolved provider actually reports customerPortal —
  // never hardcoded by provider name. None of the current Iranian gateways do,
  // so this stays hidden for them, but a future recurring-capable provider
  // would surface it automatically.
  const hasCustomerPortal = !!providerCapabilities?.customerPortal;
  const price = Number(currentPlan?.prices?.IRR?.monthly ?? 0) || 0;
  // Trial and free plans are not purchasable periods: no price line and no
  // "renew" action — the only sensible next step is upgrading to a paid plan.
  const isFree = !!currentPlan?.is_free || price <= 0;
  const nonPurchasable = isFree || isTrial;
  const periodEnd = subscription?.current_period_end as string | undefined;
  const daysLeft = periodEnd ? Math.max(0, Math.ceil((new Date(periodEnd).getTime() - Date.now()) / 86400000)) : null;

  return (
    <Card className="relative overflow-hidden">
      <div className="absolute -top-20 -right-16 w-64 h-64 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
      <CardContent className="relative pt-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('billingIran.overview.currentPlan')}</p>
            <h2 className="text-2xl font-bold text-foreground">{currentPlanName}</h2>
            {!nonPurchasable && (
              <p className="text-sm text-muted-foreground">
                {formatToman(price, 'fa')}
                <span className="text-xs">{t('billingIran.overview.perMonth')}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={isActive ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' : 'bg-muted text-muted-foreground'}>
                {isActive ? t('billingIran.overview.statusActive') : t('billingIran.overview.statusInactive')}
              </Badge>
              {isTrial && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
                  {t('billingIran.overview.trialBadge')}
                </Badge>
              )}
              {periodEnd && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5" />
                  {t('billingIran.overview.activeUntil', { date: jalaliDate(periodEnd) })}
                </span>
              )}
            </div>
            {daysLeft !== null && (isTrial || daysLeft <= 60) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t(isTrial ? 'billingIran.overview.trialDaysLeft' : 'billingIran.overview.daysLeft', { days: daysLeft.toLocaleString('fa-IR') })}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {nonPurchasable ? (
              // Trial → "انتخاب پلن"; Free → "ارتقای پلن". Neither may offer a
              // renewal or show a 0 Toman price.
              <Button size="lg" className="h-12 px-7 text-base font-semibold rounded-xl shadow-sm" onClick={onChangePlan}>
                <ArrowRight className="w-4 h-4 me-2 rotate-180" />
                {t(isTrial ? 'billingIran.overview.trialCta' : 'billingIran.overview.upgradeCta')}
              </Button>
            ) : (
              <>
                <Button size="lg" className="h-12 px-7 text-base font-semibold rounded-xl shadow-sm" onClick={onRenew}>
                  <RefreshCw className="w-4 h-4 me-2" />
                  {t('billingIran.overview.renewCta')}
                </Button>
                <Button size="lg" variant="outline" className="h-12 px-7 text-base font-semibold rounded-xl" onClick={onChangePlan}>
                  <LayoutGrid className="w-4 h-4 me-2" />
                  {t('billingIran.overview.changeCta')}
                </Button>
              </>
            )}

            {hasCustomerPortal && subscription?.provider_customer_id && (
              <Button
                variant="ghost"
                onClick={() => {
                  billingGetPortal(subscription.workspace_id, window.location.href).then((r) => {
                    if (r.url) window.open(r.url, '_blank');
                  });
                }}
              >
                {t('billingIran.overview.managePortal')}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageSummary({ effective, operatorsUsed }: { effective: any; operatorsUsed: number }) {
  const { t } = useTranslation();
  if (!effective) return null;
  const limits = effective.limits || {};
  const usage = effective.usage || {};

  const items = [
    { key: 'conversations', label: t('billingIran.overview.conversations'), used: usage.conversations_count, limit: limits.max_conversations?.value },
    { key: 'operators', label: t('billingIran.overview.operators'), used: operatorsUsed, limit: limits.max_agents?.value },
    { key: 'visitors', label: t('billingIran.overview.visitors'), used: usage.visitors_count, limit: limits.max_visitors?.value },
    { key: 'aiCredits', label: t('billingIran.overview.aiCredits'), used: usage.ai_credits_used, limit: limits.ai_credits_per_month?.value },
    { key: 'storage', label: t('billingIran.overview.storage'), used: typeof usage.storage_bytes === 'number' ? Number((usage.storage_bytes / 1024 ** 3).toFixed(1)) : undefined, limit: limits.storage_gb?.value, unit: t('billingIran.overview.gb') },
    { key: 'callMinutes', label: t('billingIran.overview.callMinutes'), used: usage.call_minutes_used, limit: limits.max_call_minutes_per_month?.value },
    { key: 'kbArticles', label: t('billingIran.overview.kbArticles'), used: usage.kb_articles_count, limit: limits.max_kb_articles?.value },
    { key: 'departments', label: t('billingIran.overview.departments'), used: usage.departments_count, limit: limits.max_departments?.value },
  ]
    .filter((i) => typeof i.used === 'number' && i.limit != null)
    // Overview stays readable: only the four metrics customers actually watch.
    // Everything else lives in the plan comparison.
    .filter((i) => ['conversations', 'operators', 'aiCredits', 'storage'].includes(i.key))
    .slice(0, 4);


  if (items.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-5">
        <h3 className="text-sm font-semibold text-foreground mb-4">{t('billingIran.overview.usageTitle')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {items.map((i) => {
            const unlimited = i.limit === -1;
            const pct = !unlimited && i.limit > 0 ? Math.min(100, Math.round((i.used / i.limit) * 100)) : null;
            const usedLabel = `${i.used.toLocaleString('fa-IR')}${i.unit ? ` ${i.unit}` : ''}`;
            const limitLabel = unlimited
              ? t('billingIran.overview.unlimited')
              : `${Number(i.limit).toLocaleString('fa-IR')}${i.unit ? ` ${i.unit}` : ''}`;
            return (
              <div key={i.key} className="rounded-xl border border-border/60 bg-card p-3 flex flex-col items-center text-center gap-1.5">
                <UsageDonut
                  percent={pct}
                  used={Number(i.used)}
                  limit={Number(i.limit)}
                  unlimited={unlimited}
                  unit={i.unit}
                  usedName={t('billingIran.aiCredit.usedLabel')}
                  remainingName={t('billingIran.overview.remaining')}
                />
                <div className="text-[11px] text-muted-foreground">{i.label}</div>
                <div className="text-xs font-semibold text-foreground">
                  {usedLabel} / {limitLabel}
                </div>
              </div>
            );
          })}
        </div>

      </CardContent>
    </Card>
  );
}

/** Donut gauge matching the AI-credit chart style. */
function UsageDonut({
  percent, used, limit, unlimited, unit, usedName, remainingName,
}: {
  percent: number | null; used: number; limit: number; unlimited: boolean;
  unit?: string; usedName: string; remainingName: string;
}) {
  const remaining = unlimited ? 0 : Math.max(0, limit - used);
  const tone = percent !== null && percent >= 90
    ? 'hsl(var(--destructive))'
    : percent !== null && percent >= 70
      ? 'hsl(38 92% 50%)'
      : 'hsl(var(--primary))';
  const data = unlimited || limit <= 0
    ? [{ key: 'empty', label: '', value: 1, color: 'hsl(var(--muted))' }]
    : [
        { key: 'used', label: usedName, value: Math.max(0, used), color: tone },
        { key: 'remaining', label: remainingName, value: remaining, color: 'hsl(var(--muted))' },
      ].filter((d) => d.value > 0);

  return (
    <div className="relative mx-auto h-[84px] w-[84px]">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={27}
            outerRadius={40}
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            startAngle={90}
            endAngle={-270}
          >
            {data.map((d) => <Cell key={d.key} fill={d.color} />)}
          </Pie>
          {!unlimited && limit > 0 && (
            <Tooltip
              formatter={(v: any, n: any) => [`${Number(v).toLocaleString('fa-IR')}${unit ? ` ${unit}` : ''}`, n]}
              contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12, direction: 'rtl' }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-bold text-foreground">
        {unlimited ? '∞' : percent !== null ? `${percent.toLocaleString('fa-IR')}٪` : '—'}
      </div>
    </div>
  );
}



function PlansGrid({
  plans, currentPlan, interval, onIntervalChange, onSelect,
}: {
  plans: any[]; currentPlan: any; interval: Interval; onIntervalChange: (i: Interval) => void; onSelect: (plan: any) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div className="flex justify-center">
        <div className="inline-flex items-center rounded-full bg-muted p-1">
          <button
            onClick={() => onIntervalChange('monthly')}
            className={`px-4 py-1.5 text-sm rounded-full transition ${interval === 'monthly' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            {t('billingIran.plans.monthly')}
          </button>
          <button
            onClick={() => onIntervalChange('yearly')}
            className={`px-4 py-1.5 text-sm rounded-full transition inline-flex items-center gap-2 ${interval === 'yearly' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
          >
            {t('billingIran.plans.yearly')}
            <span className="text-[10px] text-muted-foreground">{t('billingIran.plans.yearlyHint')}</span>
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const monthly = plan.prices?.IRR?.monthly ?? 0;
          const yearly = plan.prices?.IRR?.yearly ?? 0;
          const price = interval === 'monthly' ? monthly : yearly;
          const isCurrent = currentPlan?.id === plan.id;
          const isFree = !!plan.is_free || !(Number(monthly) > 0 || Number(yearly) > 0);
          // Real discount only — never a hardcoded badge.
          const discountPct = interval === 'yearly' && monthly > 0 && yearly > 0
            ? Math.round((1 - yearly / (monthly * 12)) * 100)
            : 0;
          const planName = ((plan.localized || {}).fa?.name || '').trim() || plan.name;
          const isHigher = !isCurrent && currentPlan && (plan.sort_order ?? 0) > (currentPlan.sort_order ?? 0);
          const aiAllowance = Number((plan.limits || {}).included_ai_allowance_irr ?? 0) || 0;


          return (
            <Card key={plan.id} className={isCurrent ? 'ring-2 ring-primary border-primary/40' : ''}>
              <CardContent className="pt-6 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-foreground">{planName}</h3>
                  <div className="mt-2">
                    {isFree || !(Number(price) > 0) ? (
                      <span className="text-2xl font-bold text-foreground">{t('billingIran.plans.free')}</span>
                    ) : (
                      <>
                        <span className="text-2xl font-bold text-foreground">{formatToman(price, 'fa')}</span>
                        <span className="text-sm text-muted-foreground">{interval === 'monthly' ? t('billingIran.overview.perMonth') : t('billingIran.overview.perYear')}</span>
                      </>
                    )}
                    {discountPct > 0 && (
                      <Badge className="ms-2 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                        {t('billingIran.plans.discountBadge', { percent: discountPct.toLocaleString('fa-IR') })}
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Monthly AI credit included in this plan (billing_plans.limits.included_ai_allowance_irr) */}
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles className="w-3.5 h-3.5 text-primary" /> {t('billingIran.plans.aiCreditIncluded')}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {aiAllowance > 0 ? formatToman(aiAllowance, 'fa') : t('billingIran.plans.aiCreditNone')}
                  </div>
                </div>


                <ul className="space-y-2 text-sm">
                  {planHighlights(plan).map((h) => (
                    <li key={h.key} className="flex items-start gap-2 text-muted-foreground">
                      <Check className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                      <span className="text-foreground/90">
                        {t(`billingIran.planFeatures.${h.key}` as any, {
                          value: h.value === -1
                            ? t('billingIran.overview.unlimited')
                            : Number(h.value).toLocaleString('fa-IR'),
                        })}
                      </span>
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <Button className="w-full" variant="outline" disabled>{t('billingIran.plans.currentCta')}</Button>
                ) : isFree ? null : (
                  <Button className="w-full" onClick={() => onSelect(plan)}>
                    <ArrowRight className="w-4 h-4 me-2 rotate-180" />
                    {isHigher ? t('billingIran.plans.upgradeCta') : t('billingIran.plans.selectCta')}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Pre-payment invoice. The invoice is issued by the server (unique invoice
 * number + server-derived amount) BEFORE the customer is sent to the bank, so
 * what they read here is exactly what they will be charged. Closing the dialog
 * cancels that invoice, which keeps the transaction history truthful.
 */
function RenewalDialog({
  workspaceId, plan, interval, currentPlan, periodEnd, submitting, onCancel, onConfirm,
}: {
  workspaceId: string | null; plan: any | null; interval: Interval; currentPlan: any; periodEnd: string | null; submitting: boolean;
  onCancel: () => void; onConfirm: (interval: Interval, intentId?: string) => void;
}) {
  const { t } = useTranslation();
  const [invoice, setInvoice] = useState<BillingInvoice | null>(null);
  const [loadingInvoice, setLoadingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const planId = plan?.id as string | undefined;

  useEffect(() => {
    if (!planId || !workspaceId) { setInvoice(null); return; }
    let cancelled = false;
    setLoadingInvoice(true);
    setInvoiceError(null);
    setInvoice(null);
    billingInvoicePreview({ workspaceId, planId, interval })
      .then((r) => { if (!cancelled) setInvoice(r.invoice); })
      .catch((e: any) => { if (!cancelled) setInvoiceError(billingError('fa', e?.message)); })
      .finally(() => { if (!cancelled) setLoadingInvoice(false); });
    return () => { cancelled = true; };
  }, [planId, workspaceId, interval]);

  if (!plan) return null;
  const planName = ((plan.localized || {}).fa?.name || '').trim() || plan.name;
  const amount = invoice?.totalIrr ?? plan.prices?.IRR?.[interval] ?? 0;
  const isSamePlan = currentPlan?.id === plan.id;
  const isUpgrade = !isSamePlan && (plan.sort_order ?? 0) > (currentPlan?.sort_order ?? 0);
  const isDowngrade = !isSamePlan && (plan.sort_order ?? 0) < (currentPlan?.sort_order ?? 0);
  // Early renewal never burns paid days — the server stacks the new period on
  // top of the current one, so say so before the customer pays.
  const stacks = invoice ? invoice.stacked : (isSamePlan && !!periodEnd && new Date(periodEnd).getTime() > Date.now());

  function close() {
    // Abandoned invoice → recorded as canceled instead of vanishing.
    if (invoice?.intentId) billingCancelInvoice(invoice.intentId).catch(() => { /* best effort */ });
    setInvoice(null);
    onCancel();
  }

  return (
    <Dialog open={!!plan} onOpenChange={(v) => !v && close()}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('billingIran.invoice.title')}</DialogTitle>
        </DialogHeader>

        {loadingInvoice ? (
          <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : invoiceError ? (
          <p className="rounded-xl bg-destructive/10 border border-destructive/25 px-3 py-2.5 text-sm text-destructive">{invoiceError}</p>
        ) : (
          <div className="space-y-3.5">
            <div className="rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t('billingIran.invoice.number')}</span>
              <span className="font-mono text-sm font-semibold tracking-wider text-foreground" dir="ltr">{invoice?.invoiceNumber || '—'}</span>
            </div>

            <dl className="text-sm space-y-2.5">
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('billingIran.invoice.issuedAt')}</dt><dd className="font-medium">{jalaliDate(invoice?.issuedAt)}</dd></div>
              {invoice?.workspaceName && (
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('billingIran.invoice.workspace')}</dt><dd className="font-medium">{invoice.workspaceName}</dd></div>
              )}

              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('billingIran.renewal.planLabel')}</dt><dd className="font-medium">{planName}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t('billingIran.renewal.periodLabel')}</dt><dd className="font-medium">{interval === 'monthly' ? t('billingIran.plans.monthly') : t('billingIran.plans.yearly')}</dd></div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('billingIran.invoice.purchaseType')}</dt>
                <dd className="font-medium">
                  {t(isUpgrade ? 'billingIran.invoice.typeUpgrade' : isDowngrade ? 'billingIran.invoice.typeDowngrade' : isSamePlan ? 'billingIran.invoice.typeRenewal' : 'billingIran.invoice.typeNew')}
                </dd>
              </div>
              {invoice && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('billingIran.invoice.coverage')}</dt>
                  <dd className="font-medium">{t('billingIran.invoice.coverageValue', { from: jalaliDate(invoice.periodStart), to: jalaliDate(invoice.periodEnd) })}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 border-t border-border/60 pt-2.5">
                <dt className="text-muted-foreground">{t('billingIran.renewal.payableLabel')}</dt>
                <dd className="text-lg font-bold text-foreground">{formatToman(amount, 'fa')}</dd>
              </div>
            </dl>

            {stacks && (
              <p className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                {t('billingIran.renewal.stackHint', { date: jalaliDate(invoice?.periodStart || periodEnd) })}
              </p>
            )}
            {isDowngrade && (
              <p className="rounded-xl bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {t('billingIran.renewal.downgradeHint')}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button size="lg" variant="outline" className="h-12 px-6 rounded-xl" onClick={close} disabled={submitting}>
            {t('billingIran.renewal.cancel')}
          </Button>
          <Button
            size="lg"
            className="h-12 px-7 text-base font-semibold rounded-xl"
            onClick={() => onConfirm(interval, invoice?.intentId)}
            disabled={submitting || loadingInvoice || !invoice}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : <CreditCard className="w-4 h-4 me-2" />}
            {t(isUpgrade ? 'billingIran.renewal.payUpgradeCta' : isDowngrade ? 'billingIran.renewal.payDowngradeCta' : 'billingIran.renewal.payCta')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact AI-credit summary for the Overview tab: remaining credit and how
 * much of this cycle is used, with a single way into the full tab.
 */
function AiCreditSummaryCard({ workspaceId, onOpen }: { workspaceId: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AiBillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    aiBillingSummary(workspaceId)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (loading) return <SkeletonCard lines={3} />;

  if (failed || !summary) {
    return (
      <Card>
        <CardContent className="pt-5 text-center space-y-3">
          <AlertTriangle className="w-5 h-5 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('billingIran.overview.aiCreditLoadFailed')}</p>
        </CardContent>
      </Card>
    );
  }

  const total = summary.available + summary.usedThisCycle;
  const pct = total > 0 ? Math.min(100, Math.round((summary.usedThisCycle / total) * 100)) : 0;

  return (
    <Card>
      <CardContent className="pt-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-primary" /> {t('billingIran.aiCredit.title')}
          </h3>
          <Badge variant="outline" className="text-[11px]">{t('billingIran.aiCredit.usedPct', { percent: pct.toLocaleString('fa-IR') })}</Badge>
        </div>
        <div>
          <div className="text-2xl font-bold text-foreground">{formatToman(summary.available, 'fa')}</div>
          <p className="text-xs text-muted-foreground mt-1">{t('billingIran.aiCredit.remainingLabel')}</p>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <dl className="text-xs space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingIran.aiCredit.monthlyRemainingLabel')}</dt><dd className="font-medium">{formatToman(summary.planRemaining, 'fa')}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingIran.aiCredit.purchasedRemainingLabel')}</dt><dd className="font-medium">{formatToman(summary.purchasedRemaining, 'fa')}</dd></div>
        </dl>
        <Button variant="outline" size="sm" className="w-full" onClick={onOpen}>
          <Sparkles className="w-4 h-4 me-2" /> {t('billingIran.aiCredit.increaseCta')}
        </Button>
      </CardContent>
    </Card>
  );
}
