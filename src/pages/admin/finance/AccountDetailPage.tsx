/**
 * Super Admin → Finance → Accounts → one workspace's billing account
 * (phase 6, /admin/finance/accounts/:workspaceId).
 *
 * Read only, apart from the Credit / Debit buttons: opening it never renews,
 * syncs a card or calls Paddle (the server's detail route only reads). A
 * period that ended but the hourly job has not processed yet shows as
 * "Due, waits for the job". Ledger and payments are paged; a receipt opens in
 * a dialog with the same document the customer prints.
 */
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownCircle, ArrowLeft, ArrowRight, ArrowUpCircle, ChevronDown, ChevronRight,
  CreditCard, FileText, Printer, Receipt, Wallet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  AdminBillingApiError,
  useAdminAccount,
  useAdminLedger,
  useAdminPayments,
  useAdminReceipt,
  type AdminAccountDetail,
  type AdminLedgerEntry,
  type AdminPaymentRow,
} from '@/lib/adminSimpleBillingApi';
import { ErrorState, Ltr, Pager, TxStatusBadge, billingDate, money } from '@/pages/app/billing/shared';
import { billingMoment, cardLabel, planLabel } from '@/pages/app/billing/account/accountUi';
import ReceiptDocument from '@/pages/app/billing/account/ReceiptDocument';
import { BILLING_PROFILE_KEYS } from '../../../../shared/simpleBilling';
import AdjustBalanceDialog from './AdjustBalanceDialog';
import { CardStatusBadge, PlanStatusBadge } from './AccountsTab';
import { intervalLabel, kindLabel, sbLabel, type AdjustDirection } from './financeUi';

const PAGE_SIZE = 20;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end">{children}</span>
    </div>
  );
}

function BalanceCard({ account, onAdjust }: { account: AdminAccountDetail; onAdjust: (d: AdjustDirection) => void }) {
  const { t, locale } = useTranslation();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-primary" aria-hidden />
          {sbLabel(t, 'detail.balance')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-2xl font-bold tabular-nums" data-testid="detail-balance">{money(account.balance_minor, locale, account.currency)}</div>
        {!account.has_account && (
          <p className="text-xs text-muted-foreground">{t('admin.simpleBilling.detail.noAccount', { currency: account.currency })}</p>
        )}
        <Field label={sbLabel(t, 'detail.autoRenew')}>{sbLabel(t, account.auto_renew ? 'common.yes' : 'common.no')}</Field>
        {account.vat_percent !== null && <Field label={sbLabel(t, 'detail.vat')}>{`${account.vat_percent}%`}</Field>}
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => onAdjust('credit')}>
            <ArrowUpCircle className="me-2 h-4 w-4" aria-hidden />
            {sbLabel(t, 'adjust.credit')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onAdjust('debit')} disabled={account.balance_minor <= 0}>
            <ArrowDownCircle className="me-2 h-4 w-4" aria-hidden />
            {sbLabel(t, 'adjust.debit')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanCardView({ account }: { account: AdminAccountDetail }) {
  const { t, locale } = useTranslation();
  const plan = account.plan;
  const name = plan.plan_id ? planLabel(plan.name, plan.localized, locale) : sbLabel(t, 'detail.noPlan');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4 text-primary" aria-hidden />
          {sbLabel(t, 'detail.plan')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{name}</span>
          {plan.billing_interval && !plan.is_free && <span className="text-xs text-muted-foreground">{intervalLabel(t, plan.billing_interval)}</span>}
          <PlanStatusBadge status={plan.status} />
        </div>
        {account.due_unprocessed && (
          <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" data-testid="due-unprocessed">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {sbLabel(t, 'detail.dueUnprocessed')}
          </Badge>
        )}
        {plan.current_period_end && !plan.is_free && (
          <Field label={sbLabel(t, 'detail.period')}>
            {billingDate(plan.current_period_start, locale)} – {billingDate(plan.current_period_end, locale)}
          </Field>
        )}
        {plan.trial_end && <Field label={sbLabel(t, 'detail.trialEnd')}>{billingDate(plan.trial_end, locale)}</Field>}
        {account.scheduled && (
          <Field label={sbLabel(t, 'detail.scheduled')}>
            {account.scheduled.plan_name ?? account.scheduled.plan_id}
            {account.scheduled.interval ? ` · ${intervalLabel(t, account.scheduled.interval)}` : ''}
          </Field>
        )}
        {(account.next_period_prepaid_minor ?? 0) > 0 && (
          <Field label={sbLabel(t, 'detail.prepaidNext')}>
            {money(account.next_period_prepaid_minor ?? 0, locale, account.currency)}
            {account.next_period_start ? ` · ${billingDate(account.next_period_start, locale)}` : ''}
          </Field>
        )}
        <div className="pt-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/admin/plans?tab=assign&workspace=${encodeURIComponent(account.workspace.id)}`}>{sbLabel(t, 'detail.openAssign')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SavedCardView({ account }: { account: AdminAccountDetail }) {
  const { t, locale } = useTranslation();
  const card = account.card;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="h-4 w-4 text-primary" aria-hidden />
          {sbLabel(t, 'detail.card')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {!card ? (
          <p className="text-sm text-muted-foreground">{sbLabel(t, 'detail.noCard')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{cardLabel(card, t as (k: TranslationKey) => string)}</span>
              <CardStatusBadge status={card.status} />
            </div>
            <Field label={sbLabel(t, 'detail.col.provider')}><span dir="ltr">{card.provider}</span></Field>
            {card.paddle_next_billed_at && (
              <Field label={sbLabel(t, 'detail.nextCharge')}>{billingMoment(card.paddle_next_billed_at, locale)}</Field>
            )}
            {card.cancel_intent && (
              <Field label={sbLabel(t, 'detail.cancelIntent')}>{sbLabel(t, `detail.cancelIntents.${card.cancel_intent}`, card.cancel_intent)}</Field>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileCard({ account }: { account: AdminAccountDetail }) {
  const { t } = useTranslation();
  const profile = account.billing_profile ?? {};
  const keys = BILLING_PROFILE_KEYS.filter((k) => typeof profile[k] === 'string' && profile[k]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4 text-primary" aria-hidden />
          {sbLabel(t, 'detail.profile')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{sbLabel(t, 'detail.profileEmpty')}</p>
        ) : (
          keys.map((k) => (
            <Field key={k} label={t(`billing.account.profile.fields.${k}` as TranslationKey)}>
              <bdi>{profile[k]}</bdi>
            </Field>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** The reason and category an admin gave for a manual credit or debit. */
function adminReason(entry: AdminLedgerEntry): { reason: string; category: string } | null {
  if (entry.kind !== 'admin_credit' && entry.kind !== 'admin_debit') return null;
  const d = entry.description ?? {};
  return {
    reason: typeof d.reason === 'string' ? d.reason : '',
    category: typeof d.category === 'string' ? d.category : '',
  };
}

function LedgerTab({ account, onReceipt }: { account: AdminAccountDetail; onReceipt: (id: string) => void }) {
  const { t, locale } = useTranslation();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useAdminLedger(account.workspace.id, { page, pageSize: PAGE_SIZE });
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <ErrorState message={sbLabel(t, 'common.loadFailed')} onRetry={() => void refetch()} retryLabel={sbLabel(t, 'common.retry')} />;
  }
  if (data.items.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{sbLabel(t, 'detail.ledgerEmpty')}</p>;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{sbLabel(t, 'detail.col.date')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.kind')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.amount')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.balanceAfter')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.reason')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.actor')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((e) => {
              const admin = adminReason(e);
              const plan = e.plan_id ? planLabel(e.plan_name ?? null, e.plan_localized, locale) : '';
              return (
                <TableRow key={e.id} data-testid={`ledger-row-${e.id}`}>
                  <TableCell className="whitespace-nowrap text-sm">{billingMoment(e.created_at, locale)}</TableCell>
                  <TableCell className="text-sm">
                    <div>{kindLabel(t, e.kind)}</div>
                    {(plan || e.period_end) && (
                      <div className="text-xs text-muted-foreground">
                        {plan}
                        {e.billing_interval ? ` · ${intervalLabel(t, e.billing_interval)}` : ''}
                        {e.period_start && e.period_end ? ` · ${billingDate(e.period_start, locale)} – ${billingDate(e.period_end, locale)}` : ''}
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-end font-medium tabular-nums ${e.amount_minor < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`}
                  >
                    <span dir="ltr">{e.amount_minor < 0 ? '−' : '+'}{money(Math.abs(e.amount_minor), locale, e.currency)}</span>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{money(e.balance_after, locale, e.currency)}</TableCell>
                  <TableCell className="max-w-[280px] text-sm">
                    {admin ? (
                      <div className="space-y-0.5">
                        {admin.category && (
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            {sbLabel(t, `adjust.categories.${admin.category}`, admin.category)}
                          </Badge>
                        )}
                        <div className="break-words text-muted-foreground">{admin.reason}</div>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm"><bdi>{e.actor_email ?? (admin ? e.actor_id ?? '' : '')}</bdi></TableCell>
                  <TableCell className="text-end">
                    {e.receipt_number && (
                      <Button variant="ghost" size="sm" onClick={() => onReceipt(e.id)}>
                        <Receipt className="me-1 h-3.5 w-3.5" aria-hidden />
                        {sbLabel(t, 'detail.receipt')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Pager
        page={page}
        pageSize={data.pageSize}
        total={data.total}
        onPage={setPage}
        labels={{ page: t('admin.simpleBilling.common.page', { page, pages }), prev: sbLabel(t, 'common.prev'), next: sbLabel(t, 'common.next') }}
      />
    </>
  );
}

function resultText(result: Record<string, unknown> | null): string {
  if (!result) return '';
  const status = typeof result.status === 'string' ? result.status : typeof result.result === 'string' ? result.result : '';
  return status;
}

function PaymentRow({ p }: { p: AdminPaymentRow }) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const m = (v: number) => money(v, locale, p.currency);
  const Chevron = open ? ChevronDown : ChevronRight;
  const hasRefunds = p.refunds.length > 0;
  return (
    <Fragment>
      <TableRow data-testid={`payment-row-${p.id}`}>
        <TableCell className="whitespace-nowrap text-sm">{billingMoment(p.completed_at ?? p.created_at, locale)}</TableCell>
        <TableCell className="text-sm">
          <span dir="ltr">{p.provider}</span>
          {p.is_test && <Badge variant="secondary" className="ms-1 px-1 py-0 text-[10px]">{sbLabel(t, 'common.test')}</Badge>}
        </TableCell>
        <TableCell className="text-sm">{sbLabel(t, `revenue.source.${p.source}`, p.source)}</TableCell>
        <TableCell className="text-sm">
          <div>{sbLabel(t, `revenue.purpose.${p.purpose}`, p.purpose)}</div>
          {resultText(p.purpose_result) && <div className="text-xs text-muted-foreground" dir="ltr">{resultText(p.purpose_result)}</div>}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            <TxStatusBadge status={p.status} label={sbLabel(t, `paymentStatus.${p.status}`, p.status)} />
            {p.review && (
              <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400" title={p.review}>
                {sbLabel(t, 'detail.review')}
              </Badge>
            )}
          </div>
          {p.failure_reason && <div className="mt-0.5 text-xs text-muted-foreground" dir="ltr">{p.failure_reason}</div>}
        </TableCell>
        <TableCell className="text-end tabular-nums">{m(p.amount_minor)}</TableCell>
        <TableCell className="text-end tabular-nums">{m(p.net_minor)}</TableCell>
        <TableCell className="text-end tabular-nums">{p.tax_minor ? m(p.tax_minor) : '—'}</TableCell>
        <TableCell className="text-end tabular-nums">
          {hasRefunds ? (
            <Button variant="ghost" size="sm" className="h-auto px-1 py-0.5" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={sbLabel(t, 'detail.showRefunds')}>
              <Chevron className="me-1 h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
              {m(p.refunded_minor)}
            </Button>
          ) : p.refunded_minor ? m(p.refunded_minor) : '—'}
        </TableCell>
      </TableRow>
      {open && hasRefunds && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={9}>
            <div className="text-xs font-medium text-muted-foreground">{sbLabel(t, 'detail.refunds')}</div>
            <table className="mt-1 w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 text-start font-normal">{sbLabel(t, 'detail.refundedAt')}</th>
                  <th className="py-1 text-end font-normal">{sbLabel(t, 'detail.col.amount')}</th>
                  <th className="py-1 text-end font-normal">{sbLabel(t, 'detail.refundCredit')}</th>
                  <th className="py-1 text-end font-normal">{sbLabel(t, 'detail.refundShortfall')}</th>
                  <th className="py-1 text-end font-normal">{sbLabel(t, 'detail.refundPrepaid')}</th>
                  <th className="py-1 text-end font-normal">{sbLabel(t, 'detail.refundPack')}</th>
                </tr>
              </thead>
              <tbody>
                {p.refunds.map((r) => (
                  <tr key={r.refund_id} className="border-t border-border/50">
                    <td className="py-1">{r.refunded_at ? billingMoment(r.refunded_at, locale) : '—'} <Ltr>{r.refund_id}</Ltr></td>
                    <td className="py-1 text-end tabular-nums">{m(r.amount_minor)}</td>
                    <td className="py-1 text-end tabular-nums">{m(r.credit_minor)}</td>
                    <td className="py-1 text-end tabular-nums">{r.shortfall_minor ? m(r.shortfall_minor) : '—'}</td>
                    <td className="py-1 text-end tabular-nums">{r.released_prepaid_minor ? m(r.released_prepaid_minor) : '—'}</td>
                    <td className="py-1 text-end tabular-nums">{r.pack_returned_minor ? m(r.pack_returned_minor) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

function PaymentsTab({ account }: { account: AdminAccountDetail }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useAdminPayments(account.workspace.id, { page, pageSize: PAGE_SIZE });
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <ErrorState message={sbLabel(t, 'common.loadFailed')} onRetry={() => void refetch()} retryLabel={sbLabel(t, 'common.retry')} />;
  }
  if (data.items.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{sbLabel(t, 'detail.paymentsEmpty')}</p>;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{sbLabel(t, 'detail.col.date')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.provider')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.source')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.purpose')}</TableHead>
              <TableHead>{sbLabel(t, 'detail.col.status')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.gross')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.net')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.tax')}</TableHead>
              <TableHead className="text-end">{sbLabel(t, 'detail.col.refunded')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => <PaymentRow key={p.id} p={p} />)}
          </TableBody>
        </Table>
      </div>
      <Pager
        page={page}
        pageSize={data.pageSize}
        total={data.total}
        onPage={setPage}
        labels={{ page: t('admin.simpleBilling.common.page', { page, pages }), prev: sbLabel(t, 'common.prev'), next: sbLabel(t, 'common.next') }}
      />
    </>
  );
}

const RECEIPT_PRINT_CSS = `@media print {
  body > *:not(:has([data-receipt-print])) { display: none !important; }
  body > *:has([data-receipt-print]) > *:not([data-receipt-print]) { display: none !important; }
  [data-receipt-print] { position: static !important; transform: none !important; max-height: none !important; max-width: none !important; width: 100% !important; overflow: visible !important; border: 0 !important; box-shadow: none !important; }
  [data-receipt-print] [data-slot="dialog-close"] { display: none !important; }
}`;

function ReceiptDialog({ workspaceId, ledgerId, onClose }: { workspaceId: string; ledgerId: string | null; onClose: () => void }) {
  const { t, locale, dir } = useTranslation();
  const { data, isLoading, isError } = useAdminReceipt(workspaceId, ledgerId);
  return (
    <Dialog open={ledgerId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" dir={dir} data-receipt-print="">
        {/* Print only the receipt: not the admin page behind the dialog, its overlay or the close button. */}
        <style>{RECEIPT_PRINT_CSS}</style>
        <DialogHeader className="print:hidden">
          <DialogTitle className="flex items-center justify-between gap-2">
            {sbLabel(t, 'detail.receiptTitle')}
            <Button variant="outline" size="sm" className="me-6" onClick={() => window.print()} disabled={!data}>
              <Printer className="me-2 h-4 w-4" aria-hidden />
              {sbLabel(t, 'detail.print')}
            </Button>
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError || !data ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{sbLabel(t, 'common.loadFailed')}</p>
        ) : (
          <ReceiptDocument receipt={data.receipt} locale={locale} dir={dir} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AccountDetailPage() {
  const { workspaceId = '' } = useParams<{ workspaceId: string }>();
  const { t, dir } = useTranslation();
  const { data: account, isLoading, isError, error, refetch } = useAdminAccount(workspaceId);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [direction, setDirection] = useState<AdjustDirection>('credit');
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to="/admin/finance?tab=accounts">
        <Back className="me-2 h-4 w-4" aria-hidden />
        {sbLabel(t, 'detail.back')}
      </Link>
    </Button>
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 w-full" />)}
        </div>
      </div>
    );
  }
  if (isError || !account) {
    const notFound = error instanceof AdminBillingApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="space-y-4">
        {back}
        <ErrorState
          message={sbLabel(t, notFound ? 'detail.notFound' : 'common.loadFailed')}
          onRetry={notFound ? undefined : () => void refetch()}
          retryLabel={sbLabel(t, 'common.retry')}
        />
      </div>
    );
  }

  const openAdjust = (d: AdjustDirection) => {
    setDirection(d);
    setAdjustOpen(true);
  };
  const owner = account.workspace.owner;

  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{account.workspace.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Link to={`/admin/workspaces?id=${encodeURIComponent(account.workspace.id)}`} className="hover:underline" dir="ltr">
              {account.workspace.slug}
            </Link>
            {owner.id && (
              <span>
                {sbLabel(t, 'detail.owner')}:{' '}
                <Link to={`/admin/users?user=${encodeURIComponent(owner.id)}`} className="hover:underline"><bdi>{owner.email || owner.id}</bdi></Link>
              </span>
            )}
            <span>{sbLabel(t, 'detail.edition')}: {sbLabel(t, `detail.editions.${account.edition}`, account.edition)}</span>
            <span>{sbLabel(t, 'detail.currency')}: {account.currency}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <BalanceCard account={account} onAdjust={openAdjust} />
        <PlanCardView account={account} />
        <SavedCardView account={account} />
        <ProfileCard account={account} />
      </div>

      <Tabs defaultValue="ledger" className="space-y-4">
        <TabsList>
          <TabsTrigger value="ledger">{sbLabel(t, 'detail.tabs.ledger')}</TabsTrigger>
          <TabsTrigger value="payments">{sbLabel(t, 'detail.tabs.payments')}</TabsTrigger>
        </TabsList>
        <TabsContent value="ledger" className="mt-0">
          <Card><CardContent className="pt-6"><LedgerTab account={account} onReceipt={setReceiptId} /></CardContent></Card>
        </TabsContent>
        <TabsContent value="payments" className="mt-0">
          <Card><CardContent className="pt-6"><PaymentsTab account={account} /></CardContent></Card>
        </TabsContent>
      </Tabs>

      <AdjustBalanceDialog open={adjustOpen} onOpenChange={setAdjustOpen} account={account} direction={direction} />
      <ReceiptDialog workspaceId={account.workspace.id} ledgerId={receiptId} onClose={() => setReceiptId(null)} />
    </div>
  );
}
