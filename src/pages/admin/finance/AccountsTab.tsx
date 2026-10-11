/**
 * Finance → Accounts (phase 6, docs/billing/SIMPLE_BILLING.md).
 *
 * Every workspace with its simple-billing account: balance, plan, card and
 * last payment. Workspaces with no account yet are listed under "All
 * workspaces", so an admin can find one and credit it. A row opens the
 * account detail (/admin/finance/accounts/:workspaceId). Above the table, the
 * balances owed to customers per currency (the revenue report's snapshot).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CreditCard, Download, RefreshCw, Search } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/i18n';
import {
  ACCOUNT_FILTERS,
  ACCOUNT_SORTS,
  listAllAccounts,
  useAdminAccounts,
  useAdminRevenue,
  type AccountSort,
  type AdminAccountRow,
} from '@/lib/adminSimpleBillingApi';
import { formatRelative } from '@/lib/date';
import { toast } from '@/lib/toast';
import { ErrorState, Pager, billingDate, money } from '@/pages/app/billing/shared';
import { planLabel } from '@/pages/app/billing/account/accountUi';
import { LiabilityTiles } from './RevenueTab';
import { accountsCsvRows, downloadCsv, fileDate, intervalLabel, periodEndSoon, planStatusLabel, sbLabel } from './financeUi';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
const ALL = '__all__';

const STATUS_STYLES: Record<string, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  trialing: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  past_due: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function PlanStatusBadge({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={STATUS_STYLES[status] ?? 'text-muted-foreground'}>
      {planStatusLabel(t, status)}
    </Badge>
  );
}

export function CardStatusBadge({ status }: { status: 'active' | 'past_due' | null }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={status === 'past_due' ? STATUS_STYLES.past_due : 'gap-1'}>
      <CreditCard className="h-3 w-3" aria-hidden />
      {sbLabel(t, `accounts.card.${status}`, status)}
    </Badge>
  );
}

function AccountRow({ a, onOpen }: { a: AdminAccountRow; onOpen: () => void }) {
  const { t, locale } = useTranslation();
  const plan = a.plan_id ? planLabel(a.plan_name, a.plan_localized, locale) : '';
  return (
    <TableRow
      className="cursor-pointer"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid={`account-row-${a.workspace_id}`}
    >
      <TableCell>
        <div className="font-medium">{a.name}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span dir="ltr">{a.slug}</span>
          {a.workspace_status === 'deleting' && <Badge variant="outline" className="px-1 py-0 text-[10px] text-destructive">{sbLabel(t, 'accounts.deleting')}</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-sm"><bdi>{a.owner_email || '—'}</bdi></TableCell>
      <TableCell>
        {plan ? (
          <div className="text-sm">
            {plan}
            {a.is_free ? (
              <span className="ms-1 text-xs text-muted-foreground">({sbLabel(t, 'accounts.free')})</span>
            ) : a.billing_interval ? (
              <span className="ms-1 text-xs text-muted-foreground">· {intervalLabel(t, a.billing_interval)}</span>
            ) : null}
          </div>
        ) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell><PlanStatusBadge status={a.status} /></TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {a.current_period_end && !a.is_free ? (
          <span
            className={periodEndSoon(a.current_period_end) ? 'font-medium text-destructive' : undefined}
            title={billingDate(a.current_period_end, locale)}
          >
            {formatRelative(a.current_period_end, locale)}
          </span>
        ) : '—'}
      </TableCell>
      <TableCell className="text-end">
        {a.has_account && a.currency ? (
          <div className="flex flex-col items-end gap-0.5">
            <span className="font-medium tabular-nums">{money(a.balance_minor, locale, a.currency)}</span>
            {(a.next_period_prepaid_minor ?? 0) > 0 && (
              <Badge variant="secondary" className="px-1 py-0 text-[10px]">{sbLabel(t, 'accounts.prepaid')}</Badge>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{sbLabel(t, 'accounts.noAccount')}</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        {a.has_account ? (
          a.auto_renew
            ? <RefreshCw className="mx-auto h-4 w-4 text-emerald-600" aria-label={sbLabel(t, 'common.yes')} />
            : <span className="text-muted-foreground" aria-label={sbLabel(t, 'common.no')}>—</span>
        ) : null}
      </TableCell>
      <TableCell><CardStatusBadge status={a.card_status} /></TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {a.last_payment_at ? billingDate(a.last_payment_at, locale) : '—'}
      </TableCell>
    </TableRow>
  );
}

export default function AccountsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('with_account');
  const [currency, setCurrency] = useState<string>(ALL);
  const [sort, setSort] = useState<AccountSort>('balance_desc');
  const [page, setPage] = useState(1);

  // Search waits until typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const params = { q, filter, currency: currency === ALL ? null : currency, sort, page, pageSize: PAGE_SIZE };
  const { data, isLoading, isError, isFetching, refetch } = useAdminAccounts(params);
  const liability = useAdminRevenue({ months: 1 });
  const currencies = data?.currencies ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const [exporting, setExporting] = useState(false);

  // The CSV holds every workspace the filters match, not the page on screen.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await listAllAccounts({ q: params.q, filter: params.filter, currency: params.currency, sort: params.sort });
      downloadCsv(`accounts-${all.edition}-${fileDate()}.csv`, accountsCsvRows(all.items));
    } catch {
      toast.error(sbLabel(t, 'accounts.csvFailed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {liability.data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {liability.data.currencies.map((c) => (
              <Card key={c} className="border-border/70">
                <CardHeader className="pb-2">
                  <CardDescription>{t('admin.simpleBilling.accounts.liability.title', { currency: c })}</CardDescription>
                </CardHeader>
                <CardContent>
                  <LiabilityTiles row={liability.data.liability.find((l) => l.currency === c)} currency={c} />
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{sbLabel(t, 'accounts.title')}</CardTitle>
          <CardDescription>{sbLabel(t, 'accounts.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={sbLabel(t, 'accounts.search')}
                aria-label={sbLabel(t, 'accounts.search')}
                className="ps-9"
                maxLength={100}
              />
            </div>
            <Select value={filter} onValueChange={(v) => { setFilter(v); setPage(1); }}>
              <SelectTrigger className="w-52" aria-label={sbLabel(t, 'accounts.filterLabel')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACCOUNT_FILTERS.map((f) => (
                  <SelectItem key={f} value={f}>{sbLabel(t, `accounts.filter.${f}`, f)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currencies.length > 1 && (
              <Select value={currency} onValueChange={(v) => { setCurrency(v); setPage(1); }}>
                <SelectTrigger className="w-40" aria-label={sbLabel(t, 'accounts.currencyLabel')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{sbLabel(t, 'accounts.currencyAll')}</SelectItem>
                  {currencies.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={(v) => { setSort(v as AccountSort); setPage(1); }}>
              <SelectTrigger className="w-52" aria-label={sbLabel(t, 'accounts.sortLabel')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACCOUNT_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>{sbLabel(t, `accounts.sort.${s}`, s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || data.items.length === 0 || exporting}
              onClick={() => void exportCsv()}
            >
              <Download className="me-2 h-4 w-4" aria-hidden />
              {exporting ? sbLabel(t, 'accounts.csvExporting') : sbLabel(t, 'accounts.csv')}
            </Button>
          </div>

          {data && (
            <div className="text-xs text-muted-foreground" aria-live="polite">
              {t('admin.simpleBilling.accounts.total', { count: data.total })}
              {isFetching && ' …'}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : isError || !data ? (
            <ErrorState message={sbLabel(t, 'common.loadFailed')} onRetry={() => void refetch()} retryLabel={sbLabel(t, 'common.retry')} />
          ) : data.items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{sbLabel(t, 'accounts.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{sbLabel(t, 'accounts.col.workspace')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.owner')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.plan')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.status')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.periodEnd')}</TableHead>
                    <TableHead className="text-end">{sbLabel(t, 'accounts.col.balance')}</TableHead>
                    <TableHead className="text-center">{sbLabel(t, 'accounts.col.autoRenew')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.card')}</TableHead>
                    <TableHead>{sbLabel(t, 'accounts.col.lastPayment')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((a) => (
                    <AccountRow
                      key={a.workspace_id}
                      a={a}
                      onOpen={() => navigate(`/admin/finance/accounts/${a.workspace_id}`)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {data && (
            <Pager
              page={page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
              labels={{
                page: t('admin.simpleBilling.common.page', { page, pages }),
                prev: sbLabel(t, 'common.prev'),
                next: sbLabel(t, 'common.next'),
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
