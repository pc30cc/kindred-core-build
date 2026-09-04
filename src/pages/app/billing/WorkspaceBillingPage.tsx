/**
 * Billing V2 — the workspace-facing financial screen.
 *
 * Six sections behind one header: overview, invoices, plans, wallet, AI credit
 * and transactions. Desktop shows them as tabs, mobile as a select, because a
 * six-item tab bar is unusable at 360px.
 *
 * This component owns exactly one piece of state that matters: the overview
 * read-model plus a `reloadKey` that every tab watches. When any action
 * changes money (a payment, a plan change, a deposit), we bump the key and let
 * the server tell us the new truth — the UI never patches financial numbers
 * locally to feel fast.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SkeletonStats, SkeletonCard } from '@/components/common/Skeletons';
import { Badge } from '@/components/ui/badge';
import { LayoutGrid, Receipt, Gauge, Wallet, Sparkles, ArrowLeftRight } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingV2Overview, billingV2CancelPlanChange, type BillingOverview } from '@/lib/billingV2Api';
import { billingVerifyCallback } from '@/lib/api';
import { ErrorState, errorMessage } from './shared';

import OverviewTab from './OverviewTab';
import InvoicesTab from './InvoicesTab';
import PlansTab from './PlansTab';
import WalletTab from './WalletTab';
import AiCreditTab from './AiCreditTab';
import TransactionsTab from './TransactionsTab';

const TABS = [
  { value: 'overview', labelKey: 'overview', icon: LayoutGrid },
  { value: 'invoices', labelKey: 'invoices', icon: Receipt },
  { value: 'plans', labelKey: 'plans', icon: Gauge },
  { value: 'wallet', labelKey: 'wallet', icon: Wallet },
  { value: 'ai', labelKey: 'aiCredit', icon: Sparkles },
  { value: 'transactions', labelKey: 'transactions', icon: ArrowLeftRight },
] as const;

export default function BillingV2Page({ workspaceId }: { workspaceId: string }) {
  const { t, dir } = useTranslation();
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('overview');
  const [reloadKey, setReloadKey] = useState(0);
  const [canceling, setCanceling] = useState(false);
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();

  /** Every invoice opens as its own payable document page, never a dialog. */
  const openInvoice = useCallback(
    (id: string) => navigate(`/${slug}/billing/pay/invoice/${id}`),
    [navigate, slug],
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    billingV2Overview(workspaceId)
      .then(setOverview)
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Any money-moving action funnels through here: refetch, never guess. */
  const refreshAll = useCallback(() => {
    load();
    setReloadKey((k) => k + 1);
  }, [load]);

  /**
   * Gateway return. The redirect carries `intent` + `provider` (added by the
   * server when the checkout session was created) plus the raw gateway params.
   * Verification is server-side; the URL is cleaned afterwards so a refresh
   * cannot replay it.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    const intentId = url.searchParams.get('intent');
    const provider = url.searchParams.get('provider');
    if (!intentId || !provider) return;

    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== 'intent' && key !== 'provider') params[key] = value;
    });

    ['intent', 'provider', ...Object.keys(params)].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

    billingVerifyCallback({ workspaceId, provider, params, intentId })
      .then((res: any) => {
        if (res?.verified) toast.success(t('billingV2.common.paymentSucceeded'));
        else toast.error(t('billingV2.common.paymentFailed'));
      })
      .catch((e) => toast.error(errorMessage(e, t)))
      .finally(() => refreshAll());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function cancelPendingChange() {
    setCanceling(true);
    try {
      await billingV2CancelPlanChange(workspaceId);
      toast.success(t('billingV2.overview.changeCanceled'));
      refreshAll();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setCanceling(false);
    }
  }


  if (loading && !overview) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8" dir={dir}>
        <SkeletonStats count={3} />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="p-4 md:p-6 lg:p-8" dir={dir}>
        <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />
      </div>
    );
  }

  if (!overview) return null;
  const canManage = overview.permissions.manage;

  return (
    <div className="animate-fade-in space-y-6 p-4 text-start md:p-6 lg:p-8" dir={dir}>
      <div className="relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm md:p-6">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/10 to-transparent"
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t('billingV2.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('billingV2.subtitle')}</p>
          </div>
          <Badge
            variant={overview.subscription.status === 'active' ? 'default' : 'secondary'}
            className="rounded-full px-3 py-1 text-sm"
          >
            {overview.subscription.planName || t('billingV2.overview.free')}
          </Badge>
        </div>
      </div>


      <Tabs value={tab} onValueChange={setTab}>
        {/* Mobile: a select keeps six sections reachable at 360px. */}
        <div className="md:hidden">
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="h-12 rounded-xl border-2 text-base font-semibold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <span className="flex items-center gap-2">
                    <item.icon className="h-4 w-4" />
                    {t(`billingV2.tabs.${item.labelKey}` as any)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <TabsList className="hidden h-auto w-full flex-wrap justify-start gap-2 rounded-2xl border bg-card p-2 shadow-sm md:flex">
          {TABS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="group flex-1 gap-2 rounded-xl border border-transparent px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-all hover:bg-muted hover:text-foreground data-[state=active]:border-primary/30 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md"
            >
              <item.icon className="h-4 w-4 shrink-0 transition-transform group-data-[state=active]:scale-110" />
              <span className="whitespace-nowrap">{t(`billingV2.tabs.${item.labelKey}` as any)}</span>
            </TabsTrigger>
          ))}
        </TabsList>



        <TabsContent value="overview" className="mt-5">
          <OverviewTab
            overview={overview}
            workspaceId={workspaceId}
            onPayInvoice={openInvoice}
            onCancelPendingChange={cancelPendingChange}
            onChanged={refreshAll}
            canceling={canceling}
            onGoTo={setTab}
          />

        </TabsContent>

        <TabsContent value="invoices" className="mt-5">
          <InvoicesTab workspaceId={workspaceId} reloadKey={reloadKey} onOpenInvoice={openInvoice} />
        </TabsContent>

        <TabsContent value="plans" className="mt-5">
          <PlansTab
            workspaceId={workspaceId}
            canManage={canManage}
            reloadKey={reloadKey}
            onChanged={refreshAll}
          />
        </TabsContent>

        <TabsContent value="wallet" className="mt-5">
          <WalletTab
            workspaceId={workspaceId}
            canManage={canManage}
            reloadKey={reloadKey}
            onChanged={refreshAll}
          />
        </TabsContent>

        <TabsContent value="ai" className="mt-5">
          <AiCreditTab
            workspaceId={workspaceId}
            canManage={canManage}
            overview={overview}
            onChanged={refreshAll}
          />
        </TabsContent>

        <TabsContent value="transactions" className="mt-5">
          <TransactionsTab workspaceId={workspaceId} reloadKey={reloadKey} />
        </TabsContent>
      </Tabs>

    </div>
  );
}
