/**
 * Super-admin — money that already happened: platform totals, invoices,
 * payments and per-workspace billing customers. Read-only surfaces.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Wallet, Receipt, TrendingUp, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n';
import { adminBillingApi, type AdminFinanceOverview } from '@/lib/adminBillingApi';

const DICT = {
  fa: {
    revenue: 'درآمد ۳۰ روز', outstanding: 'مانده پرداخت‌نشده', wallets: 'موجودی کیف پول‌ها',
    subs: 'اشتراک فعال', invoices: 'فاکتورها', payments: 'پرداخت‌ها', customers: 'مشتریان',
    number: 'شماره', workspace: 'ورک‌اسپیس', amount: 'مبلغ', status: 'وضعیت', date: 'تاریخ',
    method: 'روش', search: 'جستجو…', prev: 'قبلی', next: 'بعدی', empty: 'موردی یافت نشد',
    plan: 'پلن', balance: 'کیف پول', failed: 'دریافت اطلاعات ناموفق بود',
  },
  en: {
    revenue: 'Revenue (30d)', outstanding: 'Outstanding', wallets: 'Wallet balances',
    subs: 'Active subscriptions', invoices: 'Invoices', payments: 'Payments', customers: 'Customers',
    number: 'Number', workspace: 'Workspace', amount: 'Amount', status: 'Status', date: 'Date',
    method: 'Method', search: 'Search…', prev: 'Previous', next: 'Next', empty: 'Nothing found',
    plan: 'Plan', balance: 'Wallet', failed: 'Could not load data',
  },
  tr: {
    revenue: 'Gelir (30g)', outstanding: 'Ödenmemiş', wallets: 'Cüzdan bakiyeleri',
    subs: 'Aktif abonelik', invoices: 'Faturalar', payments: 'Ödemeler', customers: 'Müşteriler',
    number: 'Numara', workspace: 'Çalışma alanı', amount: 'Tutar', status: 'Durum', date: 'Tarih',
    method: 'Yöntem', search: 'Ara…', prev: 'Önceki', next: 'Sonraki', empty: 'Kayıt yok',
    plan: 'Plan', balance: 'Cüzdan', failed: 'Veri alınamadı',
  },
} as const;

function useDict() {
  const { locale } = useTranslation();
  const key = (['fa', 'en', 'tr'] as const).includes(locale as never) ? (locale as 'fa' | 'en' | 'tr') : 'en';
  return { d: DICT[key], intl: key === 'fa' ? 'fa-IR' : key };
}

function money(map: Record<string, number> | undefined, intl: string): string {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return '—';
  return entries.map(([cur, val]) => `${val.toLocaleString(intl)} ${cur}`).join(' · ');
}

export function FinanceOverviewTab() {
  const { d, intl } = useDict();
  const [data, setData] = useState<AdminFinanceOverview | null>(null);

  useEffect(() => {
    adminBillingApi.overview().then(setData).catch(() => toast.error(d.failed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = [
    { icon: TrendingUp, label: d.revenue, value: money(data?.revenue30d, intl) },
    { icon: Receipt, label: d.outstanding, value: money(data?.outstanding, intl) },
    { icon: Wallet, label: d.wallets, value: money(data?.walletBalances, intl) },
    { icon: Users, label: d.subs, value: data ? String(data.activeSubscriptions) : '' },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} className="border-border/70">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <c.icon className="w-4 h-4 text-primary" />
              {c.label}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data ? (
              <div className="text-xl font-bold tabular-nums">{c.value}</div>
            ) : (
              <Skeleton className="h-7 w-32" />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function InvoicesLedgerTab() {
  const { d, intl } = useDict();
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminBillingApi
      .invoices({ page, pageSize: 20, search })
      .then((r) => { setRows(r.invoices); setTotal(r.total); })
      .catch(() => toast.error(d.failed))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-4">
        <CardTitle>{d.invoices}</CardTitle>
        <Input className="max-w-xs" placeholder={d.search} value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }} />
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{d.empty}</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{d.number}</TableHead><TableHead>{d.workspace}</TableHead>
              <TableHead>{d.amount}</TableHead><TableHead>{d.status}</TableHead><TableHead>{d.date}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.invoice_number}</TableCell>
                  <TableCell>{r.workspace_name || r.workspace_id}</TableCell>
                  <TableCell className="tabular-nums">
                    {Number(r.total_amount ?? r.total_amount_irr ?? 0).toLocaleString(intl)} {r.currency || 'IRR'}
                  </TableCell>
                  <TableCell><Badge variant={r.status === 'paid' ? 'default' : 'secondary'}>{r.status}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString(intl) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{total.toLocaleString(intl)}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{d.prev}</Button>
            <Button variant="outline" size="sm" disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>{d.next}</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PaymentsLedgerTab() {
  const { d, intl } = useDict();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminBillingApi
      .payments({ page: 1, pageSize: 50 })
      .then((r) => setRows(r.payments))
      .catch(() => toast.error(d.failed))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader><CardTitle>{d.payments}</CardTitle></CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{d.empty}</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{d.workspace}</TableHead><TableHead>{d.amount}</TableHead>
              <TableHead>{d.method}</TableHead><TableHead>{d.status}</TableHead><TableHead>{d.date}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.workspace_name || r.workspace_id}</TableCell>
                  <TableCell className="tabular-nums">
                    {Number(r.amount ?? r.amount_irr ?? 0).toLocaleString(intl)} {r.currency || 'IRR'}
                  </TableCell>
                  <TableCell className="text-xs">{r.provider || r.method || '—'}</TableCell>
                  <TableCell><Badge variant={r.status === 'succeeded' ? 'default' : 'secondary'}>{r.status}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString(intl) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function CustomersLedgerTab() {
  const { d, intl } = useDict();
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminBillingApi
      .customers(search)
      .then((r) => setRows(r.customers))
      .catch(() => toast.error(d.failed))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-4">
        <CardTitle>{d.customers}</CardTitle>
        <Input className="max-w-xs" placeholder={d.search} value={search} onChange={(e) => setSearch(e.target.value)} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{d.empty}</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{d.workspace}</TableHead><TableHead>{d.plan}</TableHead>
              <TableHead>{d.balance}</TableHead><TableHead>{d.outstanding}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.workspace_id}>
                  <TableCell className="font-medium">{r.workspace_name || r.workspace_id}</TableCell>
                  <TableCell>{r.plan_name || '—'}</TableCell>
                  <TableCell className="tabular-nums">
                    {Number(r.wallet_balance ?? 0).toLocaleString(intl)} {r.currency || 'IRR'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {Number(r.outstanding ?? 0).toLocaleString(intl)} {r.currency || 'IRR'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
