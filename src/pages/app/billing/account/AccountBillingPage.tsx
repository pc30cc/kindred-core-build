/**
 * Workspace → Billing (simple billing, docs/billing/SIMPLE_BILLING.md):
 * the balance and its top-up, the current plan, the billing details printed
 * on receipts, and the history of every balance movement with its receipt.
 *
 * Coming back from a gateway (`?payment=…&provider=…` plus the gateway's own
 * parameters) the page asks the server to confirm the payment, shows the
 * outcome, and cleans the address bar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Plus, Receipt, Wallet, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SkeletonCard, SkeletonStats } from '@/components/common/Skeletons';
import { useTranslation, type TranslationKey } from '@/i18n';
import { accountBillingApi, type AccountView, type LedgerEntry, type LedgerPage, type VerifyOutcome } from '@/lib/accountBillingApi';
import { ErrorState, EmptyState, Ltr, Pager, billingDate, money } from '../shared';
import TopupDialog from './TopupDialog';
import PlanCard from './PlanCard';
import PlanPickerDialog, { type PlanPreselect } from './PlanPickerDialog';
import PayOnlineDialog, { type PayOnlineRequest } from './PayOnlineDialog';
import BillingProfileCard from './BillingProfileCard';
import { accountErrorText, planLabel } from './accountUi';
import { refreshEffectiveEntitlements } from '@/hooks/useEntitlements';

const PAGE_SIZE = 20;

type PendingReturn = { paymentId: string; provider: string; params: Record<string, string> };
type Return = { phase: 'checking' } | { phase: 'done'; outcome: VerifyOutcome; amount?: number; pending: PendingReturn };

export default function AccountBillingPage({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const { t, locale, dir } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<AccountView | null>(null);
  const [ledger, setLedger] = useState<LedgerPage | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [topup, setTopup] = useState<{ open: boolean; amountMinor: number | null }>({ open: false, amountMinor: null });
  const [picker, setPicker] = useState<{ open: boolean; preselect: PlanPreselect | null }>({ open: false, preselect: null });
  const [payOnline, setPayOnline] = useState<PayOnlineRequest | null>(null);
  const [ret, setRet] = useState<Return | null>(null);
  const handledReturn = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, l] = await Promise.all([
        accountBillingApi.view(workspaceId),
        accountBillingApi.ledger(workspaceId, page, PAGE_SIZE),
      ]);
      setView(v);
      setLedger(l);
    } catch (e) {
      setError(accountErrorText(e, t));
    }
  }, [workspaceId, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // A plan, renewal or payment changed: the page, and the panel's banners and
  // gating (the workspace's snapshot) at once.
  const changed = useCallback(() => {
    void load();
    void refreshEffectiveEntitlements(workspaceId).catch(() => undefined);
  }, [load, workspaceId]);

  // The return from a gateway. Its parameters are kept in this tab's session
  // storage before the address bar is cleaned, so a check that could not
  // finish (network, a deploy) can be repeated — by the "check again" button
  // or a reload — without them. The server confirms with the gateway (or
  // from the confirmation it already recorded); while the payment is still
  // pending the page asks again, every few seconds, for about a minute.
  const stashKey = `billing:account-return:${workspaceId}`;
  const confirmReturn = useCallback(
    async (pending: { paymentId: string; provider: string; params: Record<string, string> }) => {
      setRet({ phase: 'checking' });
      let outcome: VerifyOutcome = { status: 'pending' };
      for (let i = 0; i < 20 && mounted.current; i += 1) {
        if (i > 0) await new Promise((r) => setTimeout(r, 3000));
        try {
          // Ask the server to confirm on the first tries and every fifth one;
          // in between, read the payment (a card's webhook may settle it).
          if (i < 3 || i % 5 === 0) {
            outcome = await accountBillingApi.verify(workspaceId, pending.paymentId, pending.provider, pending.params);
          } else {
            const status = await accountBillingApi.payment(workspaceId, pending.paymentId);
            outcome = status.status === 'succeeded'
              ? {
                status: 'succeeded',
                ledgerId: status.ledger_id,
                ...(status.purpose && status.purpose !== 'topup'
                  ? { purpose: status.purpose, purposeResult: status.purpose_result ?? null }
                  : {}),
              }
              : status.status === 'pending'
                ? { status: 'pending' }
                : { status: 'failed', reason: status.failure_reason ?? status.status };
          }
        } catch {
          outcome = { status: 'pending' };
        }
        if (outcome.status !== 'pending') break;
      }
      if (!mounted.current) return;
      if (outcome.status !== 'pending') {
        try {
          window.sessionStorage.removeItem(stashKey);
        } catch {
          /* storage unavailable */
        }
      }
      let amount: number | undefined;
      if (outcome.status === 'succeeded') {
        const status = await accountBillingApi.payment(workspaceId, pending.paymentId).catch(() => null);
        amount = status?.net_minor;
      }
      if (!mounted.current) return;
      setRet({ phase: 'done', outcome, amount, pending });
      changed();
    },
    [workspaceId, stashKey, changed],
  );

  useEffect(() => {
    if (handledReturn.current) return;
    const paymentId = params.get('payment');
    const provider = params.get('provider');
    let pending: { paymentId: string; provider: string; params: Record<string, string> } | null = null;
    if (paymentId && provider) {
      const gatewayParams: Record<string, string> = {};
      params.forEach((value, key) => {
        if (key !== 'payment' && key !== 'provider') gatewayParams[key] = value;
      });
      pending = { paymentId, provider, params: gatewayParams };
      try {
        window.sessionStorage.setItem(stashKey, JSON.stringify(pending));
      } catch {
        /* storage unavailable: this check still runs */
      }
      // Cleaning the address bar re-runs this effect; the ref makes that a no-op.
      setParams(new URLSearchParams(), { replace: true });
    } else {
      try {
        const stored = window.sessionStorage.getItem(stashKey);
        if (stored) pending = JSON.parse(stored);
      } catch {
        pending = null;
      }
    }
    if (!pending?.paymentId || !pending.provider) return;
    handledReturn.current = true;
    void confirmReturn(pending);
  }, [params, setParams, stashKey, confirmReturn]);

  if (error && !view) {
    return (
      <div className="p-4 md:p-6 lg:p-8" dir={dir}>
        <ErrorState message={error} onRetry={() => void load()} retryLabel={t('billing.common.retry')} />
      </div>
    );
  }

  if (!view || !ledger) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8">
        <SkeletonStats count={2} />
        <SkeletonCard lines={6} />
      </div>
    );
  }

  const pages = {
    page: `${ledger.page} / ${Math.max(1, Math.ceil(ledger.total / ledger.pageSize))}`,
    prev: dir === 'rtl' ? '›' : '‹',
    next: dir === 'rtl' ? '‹' : '›',
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6 lg:p-8" dir={dir}>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-foreground">{t('billing.account.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('billing.account.subtitle')}</p>
      </header>

      {ret && (
        <ReturnBanner
          ret={ret}
          currency={view.currency}
          slug={slug}
          onDismiss={() => setRet(null)}
          onCheckAgain={(pending) => void confirmReturn(pending)}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="h-4 w-4" aria-hidden />
              {t('billing.account.balance.title')}
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums" data-testid="account-balance">
              {money(view.balance_minor, locale, view.currency)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('billing.account.balance.note')}</p>
            {view.can_manage && (
              <Button onClick={() => setTopup({ open: true, amountMinor: null })}>
                <Plus className="me-2 h-4 w-4" aria-hidden />
                {t('billing.account.balance.topup')}
              </Button>
            )}
          </CardContent>
        </Card>

        <PlanCard
          workspaceId={workspaceId}
          view={view}
          onChanged={changed}
          onChoosePlan={(preselect) => setPicker({ open: true, preselect: preselect ?? null })}
          onPayOnline={setPayOnline}
        />
      </div>

      <BillingProfileCard
        workspaceId={workspaceId}
        edition={view.edition}
        profile={view.billing_profile}
        canManage={view.can_manage}
        onSaved={(profile) => setView((v) => (v ? { ...v, billing_profile: profile } : v))}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('billing.account.history.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {ledger.items.length === 0 ? (
            <EmptyState message={t('billing.account.history.empty')} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('billing.account.history.date')}</TableHead>
                    <TableHead>{t('billing.account.history.description')}</TableHead>
                    <TableHead className="text-end">{t('billing.account.history.amount')}</TableHead>
                    <TableHead className="text-end">{t('billing.account.history.balanceAfter')}</TableHead>
                    <TableHead className="text-end">{t('billing.account.history.receipt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.items.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap">{billingDate(entry.created_at, locale)}</TableCell>
                      <TableCell>
                        <div>{t(`billing.account.history.kinds.${entry.kind}` as TranslationKey)}</div>
                        <LedgerDetail entry={entry} />
                      </TableCell>
                      <TableCell
                        className={`text-end tabular-nums ${entry.amount_minor > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}
                      >
                        <bdi>
                          {entry.amount_minor > 0 ? '+' : '−'}
                          {money(Math.abs(entry.amount_minor), locale, entry.currency)}
                        </bdi>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{money(entry.balance_after, locale, entry.currency)}</TableCell>
                      <TableCell className="text-end">
                        {entry.receipt_number ? (
                          <Button asChild size="sm" variant="ghost">
                            <Link to={`/${slug}/billing/receipts/${entry.id}`}>
                              <Receipt className="me-1 h-4 w-4" aria-hidden />
                              <Ltr>{entry.receipt_number}</Ltr>
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager page={ledger.page} pageSize={ledger.pageSize} total={ledger.total} onPage={setPage} labels={pages} />
        </CardContent>
      </Card>

      {view.can_manage && (
        <TopupDialog
          open={topup.open}
          onOpenChange={(open) => setTopup((v) => ({ ...v, open }))}
          initialAmountMinor={topup.amountMinor}
          workspaceId={workspaceId}
          slug={slug}
          currency={view.currency}
          vatPercent={view.vat_percent}
          gateways={view.gateways}
          onCurrencyChanged={() => void load()}
        />
      )}
      {view.can_manage && (
        <PayOnlineDialog
          key={payOnline ? `${payOnline.purpose}:${payOnline.planId ?? ''}` : 'closed'}
          request={payOnline}
          onOpenChange={(open) => !open && setPayOnline(null)}
          workspaceId={workspaceId}
          slug={slug}
          currency={view.currency}
          vatPercent={view.vat_percent}
          gateways={view.gateways}
          onCurrencyChanged={() => void load()}
        />
      )}
      <PlanPickerDialog
        open={picker.open}
        onOpenChange={(open) => setPicker((v) => ({ ...v, open }))}
        preselect={picker.preselect}
        workspaceId={workspaceId}
        view={view}
        onDone={changed}
        onPayOnline={setPayOnline}
        onTopup={view.can_manage ? (amountMinor) => setTopup({ open: true, amountMinor }) : undefined}
      />
    </div>
  );
}

function ReturnBanner({ ret, currency, slug, onDismiss, onCheckAgain }: {
  ret: Return;
  currency: string;
  slug: string;
  onDismiss: () => void;
  onCheckAgain: (pending: PendingReturn) => void;
}) {
  const { t, locale } = useTranslation();
  if (ret.phase === 'checking') {
    return (
      <Alert role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        <AlertDescription>{t('billing.account.result.checking')}</AlertDescription>
      </Alert>
    );
  }
  const { outcome } = ret;
  // A payment for a plan, renewal or upgrade was spent on it in the same
  // step; if that could no longer be done, the money stayed in the balance.
  const purposeFailed = outcome.status === 'succeeded' && Boolean(outcome.purpose) && !purposeDone(outcome.purposeResult);
  const Icon = outcome.status === 'succeeded' ? (purposeFailed ? AlertTriangle : CheckCircle2) : outcome.status === 'pending' ? Clock : XCircle;
  const text =
    outcome.status === 'succeeded'
      ? outcome.purpose
        ? purposeFailed
          ? t('billing.account.result.purposeFailed', { amount: money(ret.amount ?? 0, locale, currency) })
          : t(`billing.account.result.purposeDone.${outcome.purpose === 'renewal' ? 'renewal' : outcome.purpose === 'upgrade' ? 'upgrade' : 'plan'}` as TranslationKey)
        : t('billing.account.result.succeeded', { amount: money(ret.amount ?? 0, locale, currency) })
      : outcome.status === 'pending'
        ? t('billing.account.result.pending')
        : t('billing.account.result.failed');
  return (
    <Alert role="status" variant={outcome.status === 'failed' ? 'destructive' : 'default'} data-testid="payment-result">
      <Icon className="h-4 w-4" aria-hidden />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{text}</span>
        <span className="flex gap-2">
          {outcome.status === 'pending' && (
            <Button size="sm" variant="outline" onClick={() => onCheckAgain(ret.pending)}>
              {t('billing.account.result.checkAgain')}
            </Button>
          )}
          {outcome.status === 'succeeded' && outcome.ledgerId && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/${slug}/billing/receipts/${outcome.ledgerId}`}>{t('billing.account.result.receipt')}</Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('billing.account.result.dismiss')}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

/** Spending the payment on its purpose happened ({ action }), or not ({ error }, or nothing recorded yet). */
function purposeDone(result: Record<string, unknown> | null | undefined): boolean {
  return Boolean(result && typeof result.action === 'string' && !('error' in result));
}

/** Under a plan, renewal, upgrade or returned-prepayment row: the plan, its interval and the period it paid for. */
function LedgerDetail({ entry }: { entry: LedgerEntry }) {
  const { t, locale } = useTranslation();
  if (!entry.plan_name && !entry.period_start) return null;
  const parts: string[] = [];
  if (entry.plan_name) parts.push(planLabel(entry.plan_name, entry.plan_localized ?? {}, locale));
  if (entry.billing_interval === 'monthly' || entry.billing_interval === 'yearly') {
    parts.push(t(`billing.account.plan.interval.${entry.billing_interval}` as TranslationKey));
  }
  if (entry.period_start && entry.period_end) {
    parts.push(t('billing.account.history.period', {
      start: billingDate(entry.period_start, locale),
      end: billingDate(entry.period_end, locale),
    }));
  }
  return <div className="text-xs text-muted-foreground" data-testid="ledger-detail">{parts.join(' · ')}</div>;
}
