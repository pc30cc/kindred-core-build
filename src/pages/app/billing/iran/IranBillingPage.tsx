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
import { Progress } from '@/components/ui/progress';
import { LayoutGrid, Sparkles, Receipt, Gauge, Calendar, Loader2, ArrowRight, CreditCard } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingError } from '@/lib/billing-i18n';
import { formatToman } from '@/lib/money';
import { billingCheckout, billingVerifyCallback, billingGetPortal } from '@/lib/api';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { SkeletonStats, SkeletonCard } from '@/components/common/Skeletons';
import { useIranBilling } from './useIranBilling';
import { jalaliDate } from './format';
import PaymentResult, { type PaymentResultStatus } from './PaymentResult';
import AiCreditTab from './AiCreditTab';
import TransactionsTab from './TransactionsTab';

type Interval = 'monthly' | 'yearly';

export default function IranBillingPage() {
  const { t } = useTranslation();
  const state = useIranBilling();
  const { workspaceId, loading, plans, subscription, payments, effective, providerCapabilities, reload } = state;
  const { data: members } = useWorkspaceMembers(workspaceId || undefined);

  const [result, setResult] = useState<{ status: PaymentResultStatus; amountIrr?: number; purpose?: string; date?: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [interval, setInterval_] = useState<Interval>('monthly');
  const [renewalPlan, setRenewalPlan] = useState<any | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // ── Return & Verify (Phase 2/10) — status ALWAYS comes from the server. ──
  useEffect(() => {
    if (!workspaceId) return;
    const qs = new URLSearchParams(window.location.search);
    const intentId = qs.get('intent');
    const provider = qs.get('provider');
    if (!intentId || !provider) return;

    const params: Record<string, string> = {};
    qs.forEach((v, k) => { if (k !== 'intent' && k !== 'provider') params[k] = v; });

    setVerifying(true);
    billingVerifyCallback({ workspaceId, provider, params, intentId })
      .then((res) => {
        if (res.verified) {
          setResult({ status: 'success', amountIrr: res.amount, date: new Date().toISOString() });
          reload();
        } else {
          setResult({ status: 'failure' });
        }
      })
      .catch(() => setResult({ status: 'failure' }))
      .finally(() => {
        setVerifying(false);
        window.history.replaceState({}, '', window.location.pathname);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const currentPlan = subscription?.billing_plans || plans.find((p) => p.is_free);
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';
  const currentPlanName = ((currentPlan?.localized || {}).fa?.name || '').trim() || currentPlan?.name || t('billingIran.plans.free');

  async function startCheckout(plan: any, targetInterval: Interval) {
    if (!workspaceId) return;
    setCheckingOut(true);
    try {
      const res = await billingCheckout({
        workspaceId,
        planId: plan.id,
        interval: targetInterval,
        currency: 'IRR',
        callbackUrl: `${window.location.origin}${window.location.pathname}`,
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
    return (
      <PaymentResult
        status={result.status}
        amountIrr={result.amountIrr}
        purpose={result.purpose}
        dateIso={result.date}
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
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
            <CreditCard className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t('billingIran.pageTitle')}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{t('billingIran.pageSubtitle')}</p>
          </div>
        </div>
      </div>


      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl">
        <TabsList className="w-full md:w-auto inline-flex h-auto gap-1 p-1.5 rounded-2xl bg-gradient-to-r from-muted/80 to-muted/40 border border-border/60 shadow-sm">
          <TabsTrigger value="overview" className="gap-2 px-4 py-2 rounded-xl text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-md">
            <Gauge className="w-4 h-4" /> {t('billingIran.tabs.overview')}
          </TabsTrigger>
          <TabsTrigger value="plans" className="gap-2 px-4 py-2 rounded-xl text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-md">
            <LayoutGrid className="w-4 h-4" /> {t('billingIran.tabs.plans')}
          </TabsTrigger>
          <TabsTrigger value="aiCredit" className="gap-2 px-4 py-2 rounded-xl text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-md">
            <Sparkles className="w-4 h-4" /> {t('billingIran.tabs.aiCredit')}
          </TabsTrigger>
          <TabsTrigger value="transactions" className="gap-2 px-4 py-2 rounded-xl text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-md">
            <Receipt className="w-4 h-4" /> {t('billingIran.tabs.transactions')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-5 space-y-4">
          <OverviewCard
            currentPlan={currentPlan}
            currentPlanName={currentPlanName}
            subscription={subscription}
            isActive={isActive}
            providerCapabilities={providerCapabilities}
            onRenew={() => setRenewalPlan(currentPlan)}
            onChangePlan={() => setActiveTab('plans')}
          />
          <UsageSummary effective={effective} operatorsUsed={members?.length ?? 0} />
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
          <TransactionsTab payments={payments} currentPlanName={currentPlanName} />
        </TabsContent>
      </Tabs>

      <RenewalDialog
        plan={renewalPlan}
        interval={interval}
        isUpgrade={!!renewalPlan && renewalPlan.id !== currentPlan?.id}
        submitting={checkingOut}
        onCancel={() => setRenewalPlan(null)}
        onConfirm={(targetInterval) => startCheckout(renewalPlan, targetInterval)}
      />
    </div>
  );
}

function OverviewCard({
  currentPlan, currentPlanName, subscription, isActive, providerCapabilities, onRenew, onChangePlan,
}: {
  currentPlan: any; currentPlanName: string; subscription: any; isActive: boolean;
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
  const price = currentPlan?.prices?.IRR?.monthly ?? 0;
  const isFree = !!currentPlan?.is_free;
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
            {!isFree && (
              <p className="text-sm text-muted-foreground">
                {formatToman(price, 'fa')}
                <span className="text-xs">{t('billingIran.overview.perMonth')}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge className={isActive ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' : 'bg-muted text-muted-foreground'}>
                {isActive ? t('billingIran.overview.statusActive') : t('billingIran.overview.statusInactive')}
              </Badge>
              {periodEnd && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5" />
                  {t('billingIran.overview.activeUntil', { date: jalaliDate(periodEnd) })}
                </span>
              )}
            </div>
            {daysLeft !== null && daysLeft <= 60 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('billingIran.overview.daysLeft', { days: daysLeft.toLocaleString('fa-IR') })}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isFree ? (
              <Button onClick={onChangePlan}>{t('billingIran.overview.upgradeCta')}</Button>
            ) : (
              <>
                <Button onClick={onRenew}>{t('billingIran.overview.renewCta')}</Button>
                <Button variant="outline" onClick={onChangePlan}>{t('billingIran.overview.changeCta')}</Button>
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
    { key: 'storage', label: t('billingIran.overview.storage'), used: typeof usage.storage_bytes === 'number' ? Number((usage.storage_bytes / 1024 ** 3).toFixed(1)) : undefined, limit: limits.storage_gb?.value, unit: t('billingIran.overview.gb') },
    { key: 'callMinutes', label: t('billingIran.overview.callMinutes'), used: usage.call_minutes_used, limit: limits.max_call_minutes_per_month?.value },
  ].filter((i) => typeof i.used === 'number' && i.limit != null);

  if (items.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-5">
        <h3 className="text-sm font-semibold text-foreground mb-4">{t('billingIran.overview.usageTitle')}</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {items.map((i) => {
            const unlimited = i.limit === -1;
            const pct = !unlimited && i.limit > 0 ? Math.min(100, Math.round((i.used / i.limit) * 100)) : null;
            return (
              <div key={i.key} className="rounded-xl border border-border/60 bg-card p-4 flex flex-col items-center text-center gap-2">
                <UsageDonut
                  percent={pct}
                  centerLabel={unlimited ? '∞' : pct !== null ? `${pct.toLocaleString('fa-IR')}٪` : '—'}
                />
                <div className="text-xs text-muted-foreground">{i.label}</div>
                <div className="text-sm font-semibold text-foreground">
                  {i.used.toLocaleString('fa-IR')}{i.unit ? ` ${i.unit}` : ''} / {unlimited ? t('billingIran.overview.unlimited') : `${i.limit.toLocaleString('fa-IR')}${i.unit ? ` ${i.unit}` : ''}`}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Small circular gauge used for the overview usage metrics. */
function UsageDonut({ percent, centerLabel }: { percent: number | null; centerLabel: string }) {
  const size = 92;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = percent ?? 0;
  const tone = value >= 90 ? 'hsl(var(--destructive))' : value >= 70 ? 'hsl(38 92% 50%)' : 'hsl(var(--primary))';
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c - (c * value) / 100}
            className="transition-[stroke-dashoffset] duration-700 ease-out"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-foreground">
        {centerLabel}
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
          const isFree = !!plan.is_free;
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
                    {isFree ? (
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

function RenewalDialog({
  plan, interval, isUpgrade, submitting, onCancel, onConfirm,
}: {
  plan: any | null; interval: Interval; isUpgrade: boolean; submitting: boolean;
  onCancel: () => void; onConfirm: (interval: Interval) => void;
}) {
  const { t } = useTranslation();
  if (!plan) return null;
  const planName = ((plan.localized || {}).fa?.name || '').trim() || plan.name;
  const amount = plan.prices?.IRR?.[interval] ?? 0;

  return (
    <Dialog open={!!plan} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>{t(isUpgrade ? 'billingIran.renewal.titleUpgrade' : 'billingIran.renewal.title', { plan: planName })}</DialogTitle>
        </DialogHeader>
        <dl className="text-sm space-y-2.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingIran.renewal.planLabel')}</dt><dd className="font-medium">{planName}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingIran.renewal.periodLabel')}</dt><dd className="font-medium">{interval === 'monthly' ? t('billingIran.plans.monthly') : t('billingIran.plans.yearly')}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">{t('billingIran.renewal.payableLabel')}</dt><dd className="font-semibold text-foreground">{formatToman(amount, 'fa')}</dd></div>
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>{t('billingIran.renewal.cancel')}</Button>
          <Button onClick={() => onConfirm(interval)} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
            {t(isUpgrade ? 'billingIran.renewal.payUpgradeCta' : 'billingIran.renewal.payCta')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
