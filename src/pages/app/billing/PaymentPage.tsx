/**
 * Payment document page — a real, printable-looking invoice (or wallet
 * top-up proforma) on its own URL, with the ACTIVE gateways listed as
 * explicit choices.
 *
 * Everything financial is server-decided: the lines, the totals, whether the
 * document is payable, and which gateways may take the money. This page only
 * renders those answers and forwards the customer's gateway choice back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SkeletonCard } from '@/components/common/Skeletons';
import { ArrowRight, CheckCircle2, CreditCard, Loader2, Printer, RefreshCw, Wallet, XCircle } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import {
  billingInvoiceDetail,
  billingPayInvoiceFromWallet,
  billingInvoiceCheckout,
  billingDepositDetail,
  billingDepositCheckout,
  billingGateways,
  type InvoiceDetail,
  type DepositDocument,
  type PayableGateway,
} from '@/lib/billingApi';
import { billingDate, money, Ltr, InvoiceStatusBadge, ErrorState, errorMessage } from './shared';
import { billingGetPaymentIntent, billingVerifyCallback, type BillingReceipt } from '@/lib/api';

type Kind = 'invoice' | 'deposit';

/**
 * The Lovable/local preview proxies API calls as the deployed app origin so
 * the remote Express server can enforce CSRF safely. Payment callbacks must
 * use that same public app origin rather than the temporary preview host,
 * otherwise every provider is rejected before its handler is reached.
 */
function billingReturnOrigin(): string {
  if (!import.meta.env.DEV) return window.location.origin;

  const configured = import.meta.env.VITE_PREVIEW_PROXY_ORIGIN?.trim();
  const apiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');
  const candidate = configured || apiBase?.replace('://api.', '://app.');
  if (!candidate) return window.location.origin;

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
}

export default function PaymentPage() {
  const { kind, id, slug } = useParams<{ kind: Kind; id: string; slug: string }>();
  const navigate = useNavigate();
  const { t, locale, dir } = useTranslation();
  const { workspace, isLoading: wsLoading } = useActiveWorkspace();
  const workspaceId = workspace?.id;

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [deposit, setDeposit] = useState<DepositDocument | null>(null);
  const [gateways, setGateways] = useState<PayableGateway[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentResult, setPaymentResult] = useState<{
    state: 'processing' | 'succeeded' | 'failed';
    receipt?: BillingReceipt | null;
    /**
     * Stable diagnostic code (never a raw error message or provider
     * response) — the customer never sees this, but it lets a developer
     * know exactly which stage failed. See PaymentPage's verify effect.
     */
    errorCode?: string;
  } | null>(null);
  const [redirectSeconds, setRedirectSeconds] = useState(15);
  const [canRetryStatus, setCanRetryStatus] = useState(false);
  const callbackHandled = useRef(false);

  const pendingStorageKey = id ? `billing:pending:${kind}:${id}` : null;

  const load = useCallback(() => {
    if (!workspaceId || !id) return;
    setLoading(true);
    setError(null);
    const doc =
      kind === 'deposit'
        ? billingDepositDetail(workspaceId, id).then((r) => setDeposit(r.deposit))
        : billingInvoiceDetail(workspaceId, id).then(setInvoice);

    Promise.all([
      doc,
      billingGateways(workspaceId)
        .then((r) => {
          setGateways(r.gateways);
          setSelected((prev) => prev ?? r.gateways[0]?.provider_name ?? null);
        })
        .catch(() => setGateways([])),
    ])
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, id, kind]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!workspaceId || callbackHandled.current) return;
    const url = new URL(window.location.href);
    const stored = pendingStorageKey ? window.sessionStorage.getItem(pendingStorageKey) : null;
    let storedContext: { intentId?: string; provider?: string; params?: Record<string, string> } = {};
    try { storedContext = stored ? JSON.parse(stored) : {}; } catch { storedContext = {}; }
    const intentId = url.searchParams.get('intent') || storedContext.intentId;
    const provider = url.searchParams.get('provider') || storedContext.provider;
    if (!intentId || !provider) return;
    callbackHandled.current = true;
    setPaymentResult({ state: 'processing' });

    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== 'intent' && key !== 'provider') params[key] = value;
    });
    const callbackParams = Object.keys(params).length > 0 ? params : (storedContext.params || {});
    if (pendingStorageKey) {
      window.sessionStorage.setItem(pendingStorageKey, JSON.stringify({ intentId, provider, params: callbackParams }));
    }

    const finish = (receipt?: BillingReceipt | null) => {
      setPaymentResult({ state: 'succeeded', receipt });
      setCanRetryStatus(false);
      if (pendingStorageKey) window.sessionStorage.removeItem(pendingStorageKey);
      window.history.replaceState({}, '', url.pathname);
      load();
    };
    // A gateway that already verified the payment must never be reported to
    // the customer as "failed" — downstream finalization can still complete
    // via retry/recovery. The friendly UI stays generic; the code is only
    // for logs/diagnostics (never a raw exception or provider response).
    const markPending = (errorCode: string) => {
      // eslint-disable-next-line no-console
      console.error('[billing] payment finalization pending', { intentId, provider, errorCode });
      setPaymentResult({ state: 'processing', errorCode });
      setCanRetryStatus(true);
    };
    const markFailed = (errorCode: string) => {
      // eslint-disable-next-line no-console
      console.error('[billing] payment verification failed', { intentId, provider, errorCode });
      setPaymentResult({ state: 'failed', errorCode });
      setCanRetryStatus(false);
      if (pendingStorageKey) window.sessionStorage.removeItem(pendingStorageKey);
      window.history.replaceState({}, '', url.pathname);
    };
    const pollFinalState = async (attempts = 30) => {
      setCanRetryStatus(false);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, Math.min(1000 + attempt * 250, 4000)));
        // A transient network error while polling is not proof the payment
        // failed — keep polling rather than giving up on a verified payment.
        const current = await billingGetPaymentIntent(intentId).catch(() => null);
        if (!current) continue;
        if (current.status === 'succeeded') return finish(current.receipt);
        if (!current.pending) return markFailed(current.failureReason || 'SETTLEMENT_FAILED');
      }
      return markPending('FINALIZATION_PENDING');
    };

    const verifyOrResume = Object.keys(callbackParams).length > 0
      ? billingVerifyCallback({ workspaceId, provider, params: callbackParams, intentId })
      : billingGetPaymentIntent(intentId).then((current) => ({
          success: true,
          verified: current.status === 'succeeded' || current.pending,
          pending: current.pending,
          receipt: current.receipt || undefined,
          status: current.status,
        }));

    verifyOrResume
      .then(async (result) => {
        if (result.verified && !result.pending) return finish(result.receipt);
        if (result.verified && result.pending) return pollFinalState();
        return markFailed(result.status === 'canceled' ? 'GATEWAY_CANCELED' : 'GATEWAY_NOT_VERIFIED');
      })
      .catch((e) => markFailed(e instanceof Error && e.message ? e.message : 'VERIFY_NETWORK_ERROR'));
  }, [load, pendingStorageKey, workspaceId]);

  const checkPaymentStatus = useCallback(async () => {
    if (!pendingStorageKey) return;
    const raw = window.sessionStorage.getItem(pendingStorageKey);
    if (!raw) return;
    try {
      const { intentId } = JSON.parse(raw) as { intentId?: string };
      if (!intentId) return;
      setCanRetryStatus(false);
      const current = await billingGetPaymentIntent(intentId);
      if (current.status === 'succeeded') {
        setPaymentResult({ state: 'succeeded', receipt: current.receipt });
        window.sessionStorage.removeItem(pendingStorageKey);
        load();
      } else if (!current.pending) {
        setPaymentResult({ state: 'failed', errorCode: current.failureReason || 'SETTLEMENT_FAILED' });
        window.sessionStorage.removeItem(pendingStorageKey);
      } else {
        setPaymentResult({ state: 'processing', errorCode: 'FINALIZATION_PENDING' });
        setCanRetryStatus(true);
      }
    } catch {
      setCanRetryStatus(true);
    }
  }, [load, pendingStorageKey]);

  useEffect(() => {
    if (paymentResult?.state !== 'succeeded') return;
    setRedirectSeconds(15);
    const countdown = window.setInterval(() => setRedirectSeconds((value) => Math.max(0, value - 1)), 1000);
    const redirect = window.setTimeout(() => navigate(slug ? `/${slug}` : '/app'), 15000);
    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(redirect);
    };
  }, [navigate, paymentResult?.state, slug]);

  const backToBilling = () => navigate(slug ? `/${slug}/billing` : '/app/billing');

  async function payOnline() {
    if (!workspaceId || !id) return;
    setBusy(true);
    try {
      const callbackUrl = `${billingReturnOrigin()}/${slug}/billing/pay/${kind}/${id}`;
      const res =
        kind === 'deposit'
          ? await billingDepositCheckout(workspaceId, id, callbackUrl, selected || undefined)
          : await billingInvoiceCheckout(workspaceId, id, callbackUrl, selected || undefined);
      const url = res.paymentUrl || res.checkoutUrl || res.url;
      if (!url) throw new Error('NO_PROVIDER_CONFIGURED');
      window.location.href = url;
    } catch (e) {
      toast.error(errorMessage(e, t));
      setBusy(false);
    }
  }

  async function payFromWallet() {
    if (!workspaceId || !id) return;
    setBusy(true);
    try {
      await billingPayInvoiceFromWallet(workspaceId, id);
      toast.success(t('billing.invoices.detail.walletPaid'));
      backToBilling();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  if (wsLoading || loading) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8">
        <SkeletonCard lines={8} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-6 lg:p-8" dir={dir}>
        <ErrorState message={error} onRetry={load} retryLabel={t('billing.common.retry')} />
      </div>
    );
  }

  const isDeposit = kind === 'deposit';
  const docNumber = isDeposit ? deposit?.documentNumber : invoice?.invoice.invoiceNumber;
  const amountDue = isDeposit ? deposit?.amountIrr ?? 0 : invoice?.totals.dueIrr ?? 0;
  const alreadyPaid = isDeposit
    ? deposit?.status === 'paid'
    : invoice
      ? !invoice.actions.payable && invoice.totals.dueIrr <= 0
      : false;
  const blockedMessage = !isDeposit && invoice?.actions.blockedReason
    ? errorMessage(new Error(invoice.actions.blockedReason), t)
    : null;

  return (
    <div className="animate-fade-in mx-auto max-w-4xl space-y-5 p-4 text-start md:p-6 lg:p-8" dir={dir}>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" onClick={backToBilling} className="gap-2">
          <ArrowRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
          {t('billing.checkout.back')}
        </Button>
        <Button variant="outline" onClick={() => window.print()} className="gap-2">
          <Printer className="h-4 w-4" />
          {t('billing.checkout.print')}
        </Button>
      </div>

      {/* ── The document ─────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="bg-gradient-to-b from-primary/10 to-transparent p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">
                {isDeposit ? t('billing.checkout.depositTitle') : t('billing.checkout.invoiceTitle')}
              </p>
              <h1 className="mt-1 text-2xl font-bold">
                <Ltr>{docNumber || '—'}</Ltr>
              </h1>
            </div>
            {!isDeposit && invoice && (
              <InvoiceStatusBadge
                status={invoice.invoice.status}
                label={t(`billing.invoices.statuses.${invoice.invoice.status}` as any)}
              />
            )}
          </div>
        </div>

        <CardContent className="space-y-5 p-6">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <Row
              label={t('billing.invoices.detail.issuedAt')}
              value={billingDate(
                isDeposit ? deposit?.createdAt : invoice?.invoice.issuedAt || invoice?.invoice.createdAt,
                locale,
              )}
            />
            {!isDeposit && invoice?.invoice.dueAt && (
              <Row label={t('billing.invoices.detail.dueAt')} value={billingDate(invoice.invoice.dueAt, locale)} />
            )}
            {!isDeposit && invoice?.invoice.workspaceName && (
              <Row label={t('billing.invoices.detail.workspace')} value={invoice.invoice.workspaceName} />
            )}
          </div>

          <Separator />

          {/* Lines */}
          <div className="space-y-2">
            <p className="text-sm font-semibold">{t('billing.invoices.detail.lines')}</p>
            <div className="overflow-hidden rounded-xl border">
              {isDeposit ? (
                <LineRow
                  description={t('billing.checkout.depositLine')}
                  qty={1}
                  amount={money(deposit?.amountIrr ?? 0, locale)}
                />
              ) : (
                invoice?.lines.map((line) => (
                  <LineRow
                    key={line.id}
                    description={line.description}
                    qty={line.quantity}
                    amount={money(line.amountIrr, locale)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Totals */}
          <div className="ms-auto w-full max-w-sm space-y-1.5 text-sm">
            {!isDeposit && invoice && (
              <>
                <Total label={t('billing.invoices.detail.subtotal')} value={money(invoice.totals.subtotalIrr, locale)} />
                {invoice.totals.discountIrr > 0 && (
                  <Total
                    label={t('billing.invoices.detail.discount')}
                    value={`− ${money(invoice.totals.discountIrr, locale)}`}
                  />
                )}
                {invoice.totals.taxIrr > 0 && (
                  <Total label={t('billing.invoices.detail.tax')} value={money(invoice.totals.taxIrr, locale)} />
                )}
                {invoice.totals.paidIrr > 0 && (
                  <Total label={t('billing.invoices.detail.paid')} value={money(invoice.totals.paidIrr, locale)} />
                )}
              </>
            )}
            <Separator className="my-2" />
            <div className="flex items-center justify-between text-base font-bold">
              <span>{t('billing.checkout.payable')}</span>
              <span className="text-primary">{money(amountDue, locale)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Payment ──────────────────────────────────────────────────── */}
      {paymentResult ? (
        <Card className={paymentResult.state === 'failed' ? 'border-destructive/30 print:hidden' : 'border-primary/30 print:hidden'}>
          <CardContent className="space-y-5 p-6 text-center">
            {paymentResult.state === 'processing' ? (
              <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
            ) : paymentResult.state === 'succeeded' ? (
              <CheckCircle2 className="mx-auto h-14 w-14 text-primary" />
            ) : (
              <XCircle className="mx-auto h-14 w-14 text-destructive" />
            )}
            <div>
              <h2 className="text-xl font-bold">
                {t(`billing.paymentResult.${paymentResult.state}Title` as any)}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {paymentResult.state === 'succeeded'
                  ? t(paymentResult.receipt?.purchaseType === 'wallet_deposit'
                      ? 'billing.paymentResult.walletSuccessDescription'
                      : paymentResult.receipt?.purchaseType === 'ai_credit_topup'
                        ? 'billing.paymentResult.aiSuccessDescription'
                        : 'billing.paymentResult.successDescription', {
                      plan: paymentResult.receipt?.planName || t('billing.overview.currentPlan'),
                    })
                  : t(`billing.paymentResult.${paymentResult.state}Description` as any)}
              </p>
            </div>
            {paymentResult.state === 'succeeded' && paymentResult.receipt && (
              <div className="mx-auto grid max-w-xl gap-2 text-sm sm:grid-cols-2">
                <Row label={t('billing.paymentResult.receiptNumber')} value={paymentResult.receipt.invoiceNumber || paymentResult.receipt.orderId} />
                <Row label={t('billing.common.amount')} value={money(paymentResult.receipt.amountIrr, locale)} />
                <Row label={t('billing.paymentResult.trackingCode')} value={paymentResult.receipt.providerRef || '—'} />
                <Row label={t('billing.common.date')} value={billingDate(paymentResult.receipt.paidAt, locale)} />
              </div>
            )}
            {paymentResult.state === 'succeeded' ? (
              <div className="space-y-2">
                <Button onClick={() => navigate(slug ? `/${slug}` : '/app')}>
                  {t('billing.paymentResult.dashboard')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t('billing.paymentResult.redirectCountdown', { seconds: redirectSeconds })}
                </p>
              </div>
            ) : paymentResult.state === 'failed' ? (
              <Button variant="outline" onClick={() => setPaymentResult(null)}>
                {t('billing.common.retry')}
              </Button>
            ) : canRetryStatus ? (
              <Button variant="outline" className="gap-2" onClick={checkPaymentStatus}>
                <RefreshCw className="h-4 w-4" />
                {t('billing.paymentResult.checkStatus')}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : alreadyPaid ? (
        <Card className="border-emerald-500/30 print:hidden">
          <CardContent className="py-6 text-center text-sm text-emerald-600">
            {t('billing.checkout.alreadyPaid')}
          </CardContent>
        </Card>
      ) : (
        <Card className="print:hidden">
          <CardContent className="space-y-4 p-6">
            <div>
              <p className="text-base font-semibold">{t('billing.checkout.chooseGateway')}</p>
              <p className="text-sm text-muted-foreground">{t('billing.checkout.chooseGatewayHint')}</p>
            </div>

            {gateways.length === 0 ? (
              <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                {t('billing.checkout.noGateway')}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {gateways.map((g) => {
                  const active = selected === g.provider_name;
                  const name =
                    g.display_name?.[locale] || g.display_name?.en || g.display_name?.fa || g.provider_name;
                  return (
                    <button
                      key={g.provider_name}
                      type="button"
                      onClick={() => setSelected(g.provider_name)}
                      className={`flex items-center gap-3 rounded-xl border-2 p-4 text-start transition-all ${
                        active
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-border hover:border-primary/40 hover:bg-muted/50'
                      }`}
                    >
                      <CreditCard className={`h-5 w-5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{name}</span>
                        {g.is_test && (
                          <span className="text-xs text-amber-600">{t('billing.checkout.testGateway')}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button size="lg" className="gap-2" onClick={payOnline} disabled={busy || gateways.length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                <CreditCard className="h-4 w-4" />
                {t('billing.checkout.payNow', { amount: money(amountDue, locale) })}
              </Button>

              {!isDeposit && invoice?.actions.canPayWallet && (
                <Button size="lg" variant="outline" className="gap-2" onClick={payFromWallet} disabled={busy}>
                  <Wallet className="h-4 w-4" />
                  {t('billing.invoices.detail.payWallet')}
                </Button>
              )}
            </div>

            {blockedMessage && (
              <p className="text-sm text-destructive">
                {blockedMessage}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function LineRow({ description, qty, amount }: { description: string; qty: number; amount: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b p-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{description}</p>
        {qty > 1 && <p className="text-xs text-muted-foreground">× {qty}</p>}
      </div>
      <span className="text-sm font-semibold">{amount}</span>
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
