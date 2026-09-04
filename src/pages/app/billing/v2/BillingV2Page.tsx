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
import { LayoutGrid, Receipt, Gauge, Wallet, Sparkles, ArrowLeftRight, type LucideIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { billingV2Overview, billingV2CancelPlanChange, type BillingOverview } from '@/lib/billingV2Api';
import { ErrorState, errorMessage, money, billingDate } from './shared';

import OverviewTab from './OverviewTab';
import InvoicesTab from './InvoicesTab';
import PlansTab from './PlansTab';
import WalletTab from './WalletTab';
import AiCreditTab from './AiCreditTab';
import TransactionsTab from './TransactionsTab';
import InvoiceDetailDialog from './InvoiceDetailDialog';

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
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

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
      <div className="rounded-2xl border bg-card/60 p-5 shadow-sm backdrop-blur md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{t('billingV2.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('billingV2.subtitle')}</p>
          </div>
          <Badge variant={overview.subscription.status === 'active' ? 'default' : 'secondary'}>
            {overview.subscription.planName || t('billingV2.overview.free')}
          </Badge>
        </div>

        {/* Four numbers a workspace owner actually asks for, above the fold. */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryStat
            icon={Wallet}
            label={t('billingV2.overview.walletBalance')}
            value={money(overview.wallet.balanceIrr, locale)}
          />
          <SummaryStat
            icon={Sparkles}
            label={t('billingV2.overview.remaining')}
            value={money(
              (overview.aiCycle?.remainingIrr ?? 0) + (overview.aiPurchasedRemainingIrr ?? 0),
              locale,
            )}
          />
          <SummaryStat
            icon={Receipt}
            label={t('billingV2.overview.upcomingInvoice')}
            value={
              overview.upcomingInvoice
                ? money(overview.upcomingInvoice.amountDueIrr, locale)
                : t('billingV2.overview.noNextInvoice')
            }
          />
          <SummaryStat
            icon={Gauge}
            label={t('billingV2.overview.periodEnd')}
            value={billingDate(overview.servicePeriod?.end, locale)}
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        {/* Mobile: a select keeps six sections reachable at 360px. */}
        <div className="md:hidden">
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {t(`billingV2.tabs.${item.labelKey}` as any)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <TabsList className="hidden h-auto w-full flex-wrap justify-start gap-1 rounded-xl bg-muted/60 p-1 md:flex">
          {TABS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="gap-1.5 rounded-lg px-3 py-2 text-sm data-[state=active]:shadow-sm"
            >
              <item.icon className="h-4 w-4" />
              {t(`billingV2.tabs.${item.labelKey}` as any)}
            </TabsTrigger>
          ))}
        </TabsList>


        <TabsContent value="overview" className="mt-4">
          <OverviewTab
            overview={overview}
            onPayInvoice={setInvoiceId}
            onCancelPendingChange={cancelPendingChange}
            canceling={canceling}
          />
        </TabsContent>

        <TabsContent value="invoices" className="mt-4">
          <InvoicesTab workspaceId={workspaceId} reloadKey={reloadKey} onOpenInvoice={setInvoiceId} />
        </TabsContent>

        <TabsContent value="plans" className="mt-4">
          <PlansTab
            workspaceId={workspaceId}
            canManage={canManage}
            reloadKey={reloadKey}
            onChanged={refreshAll}
            onOpenInvoice={setInvoiceId}
          />
        </TabsContent>

        <TabsContent value="wallet" className="mt-4">
          <WalletTab
            workspaceId={workspaceId}
            canManage={canManage}
            reloadKey={reloadKey}
            onChanged={refreshAll}
          />
        </TabsContent>

        <TabsContent value="ai" className="mt-4">
          <AiCreditTab
            workspaceId={workspaceId}
            canManage={canManage}
            overview={overview}
            onOpenInvoice={setInvoiceId}
            onChanged={refreshAll}
          />
        </TabsContent>

        <TabsContent value="transactions" className="mt-4">
          <TransactionsTab workspaceId={workspaceId} reloadKey={reloadKey} />
        </TabsContent>
      </Tabs>

      <InvoiceDetailDialog
        workspaceId={workspaceId}
        invoiceId={invoiceId}
        onClose={() => setInvoiceId(null)}
        onPaid={refreshAll}
      />
    </div>
  );
}
