/**
 * Finance → Revenue (phase 6, docs/billing/SIMPLE_BILLING.md).
 *
 * What customers paid per month, in the edition's calendar (Jalali in Iran,
 * Gregorian abroad), one section per currency: amounts in two currencies are
 * never added together. Payments are bucketed by when they completed, refunds
 * by when they happened. Balance movements (credits, debits, plans paid from
 * the balance) are shown apart and are not revenue; the outstanding balance
 * is a snapshot of now. The server builds every number (GET /revenue); this
 * tab only lays them out and exports them as CSV.
 */
import { Fragment, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronDown, ChevronRight, Download, Info, Landmark } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/i18n';
import {
  useAdminRevenue,
  type LiabilityRow,
  type RevenueReport,
  type RevenueRow,
  type RevenueSums,
} from '@/lib/adminSimpleBillingApi';
import { ErrorState, money } from '@/pages/app/billing/shared';
import {
  displayUnits, downloadCsv, fileDate, kindLabel, kpiRows, monthLabel, revenueCsvRows, sbLabel, shortMonthLabel, type Translate,
} from './financeUi';

const MONTH_CHOICES = [6, 12, 24] as const;

/**
 * Purposes keep their colour whatever the period shows (categorical slots in
 * a fixed order, never by rank); refunds use the reserved red slot.
 */
const PURPOSE_COLORS: Record<string, string> = {
  topup: '#2a78d6',
  renewal: '#eb6834',
  upgrade: '#1baf7a',
  plan: '#eda100',
  ai_pack: '#e87ba4',
};
const OTHER_COLOR = '#6250d6';
const REFUND_COLOR = '#e34948';
const PURPOSE_ORDER = ['topup', 'renewal', 'upgrade', 'plan', 'ai_pack'];

function purposeLabel(t: Translate, purpose: string): string {
  return sbLabel(t, `revenue.purpose.${purpose}`, purpose);
}

function sourceLabel(t: Translate, source: string): string {
  return sbLabel(t, `revenue.source.${source}`, source);
}

function emptySums(): RevenueSums {
  return {
    payments: 0, gross_minor: 0, tax_minor: 0, net_minor: 0,
    refunds: 0, refund_gross_minor: 0, refund_tax_minor: 0, refund_net_minor: 0, net_after_refunds_minor: 0,
  };
}

function sumRows(rows: readonly RevenueRow[]): RevenueSums {
  const s = emptySums();
  for (const r of rows) {
    s.payments += r.payments;
    s.gross_minor += r.gross_minor;
    s.tax_minor += r.tax_minor;
    s.net_minor += r.net_minor;
    s.refunds += r.refunds;
    s.refund_gross_minor += r.refund_gross_minor;
    s.refund_tax_minor += r.refund_tax_minor;
    s.refund_net_minor += r.refund_net_minor;
  }
  s.net_after_refunds_minor = s.net_minor - s.refund_net_minor;
  return s;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function KpiRow({ title, sums, currency }: { title: string; sums: RevenueSums | null; currency: string }) {
  const { t, locale } = useTranslation();
  const m = (v: number) => money(v, locale, currency);
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={sbLabel(t, 'revenue.gross')} value={sums ? m(sums.gross_minor) : '—'} sub={sums ? `${sbLabel(t, 'revenue.payments')}: ${sums.payments}` : undefined} />
        <Kpi label={sbLabel(t, 'revenue.tax')} value={sums ? m(sums.tax_minor) : '—'} />
        <Kpi label={sbLabel(t, 'revenue.refunds')} value={sums ? m(sums.refund_gross_minor) : '—'} sub={sums && sums.refunds ? String(sums.refunds) : undefined} />
        <Kpi label={sbLabel(t, 'revenue.netAfterRefunds')} value={sums ? m(sums.net_after_refunds_minor) : '—'} />
      </div>
    </div>
  );
}

function RevenueChart({ report, currency }: { report: RevenueReport; currency: string }) {
  const { t, locale } = useTranslation();
  const rows = report.rows.filter((r) => r.currency === currency);
  const purposes = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) for (const p of Object.keys(r.by_purpose)) seen.add(p);
    return [...seen].sort((a, b) => {
      const ia = PURPOSE_ORDER.indexOf(a);
      const ib = PURPOSE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }, [rows]);
  const hasRefunds = rows.some((r) => r.refund_net_minor > 0);
  const data = rows.map((r) => {
    const point: Record<string, number | string> = { month: shortMonthLabel(r.month, report.calendar, locale, t) };
    for (const p of purposes) point[p] = displayUnits(r.by_purpose[p]?.net_minor ?? 0, currency);
    if (hasRefunds) point.refunds = -displayUnits(r.refund_net_minor, currency);
    return point;
  });
  const factor = currency.toUpperCase() === 'IRR' ? 10 : 100;
  const fmt = (v: number) => money(Math.round(v * factor), locale, currency);
  if (purposes.length === 0 && !hasRefunds) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{sbLabel(t, 'revenue.chartTitle')}</h4>
      <div className="h-64 w-full" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} stackOffset="sign">
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={11}
              width={72}
              stroke="hsl(var(--muted-foreground))"
              tickFormatter={(v: number) => new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale, { notation: 'compact' }).format(v)}
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
              contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
              formatter={(value: number, name: string) => [fmt(value), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {purposes.map((p, i) => (
              <Bar
                key={p}
                dataKey={p}
                stackId="net"
                name={purposeLabel(t, p)}
                fill={PURPOSE_COLORS[p] ?? OTHER_COLOR}
                stroke="hsl(var(--card))"
                strokeWidth={2}
                maxBarSize={36}
                radius={i === purposes.length - 1 ? [4, 4, 0, 0] : 0}
              />
            ))}
            {hasRefunds && (
              <Bar dataKey="refunds" stackId="net" name={sbLabel(t, 'revenue.refundBar')} fill={REFUND_COLOR} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={36} radius={[0, 0, 4, 4]} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SplitTable({ title, entries, currency, labelOf }: {
  title: string;
  entries: Array<[string, { count: number; gross_minor: number; net_minor: number; is_test?: boolean }]>;
  currency: string;
  labelOf: (key: string) => string;
}) {
  const { t, locale } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([key, v]) => (
            <tr key={key} className="border-b border-border/50 last:border-0">
              <td className="py-1 pe-2">
                {labelOf(key)}
                {v.is_test && <Badge variant="secondary" className="ms-1 px-1 py-0 text-[10px]">{sbLabel(t, 'common.test')}</Badge>}
              </td>
              <td className="py-1 pe-2 text-end tabular-nums text-muted-foreground">{v.count}</td>
              <td className="py-1 text-end tabular-nums">{money(v.net_minor, locale, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthlyTable({ report, currency }: { report: RevenueReport; currency: string }) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const rows = report.rows.filter((r) => r.currency === currency).slice().reverse();
  const current = report.months[report.months.length - 1];
  const total = report.totals[currency];
  const m = (v: number) => money(v, locale, currency);
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{sbLabel(t, 'revenue.month')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.payments')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.gross')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.tax')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.net')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.refunds')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.refundsNet')}</TableHead>
            <TableHead className="text-end">{sbLabel(t, 'revenue.netAfterRefunds')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const id = `${r.month}|${r.currency}`;
            const expandable = r.payments > 0;
            const isOpen = open === id;
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <Fragment key={id}>
                <TableRow
                  className={expandable ? 'cursor-pointer' : undefined}
                  onClick={expandable ? () => setOpen(isOpen ? null : id) : undefined}
                  aria-expanded={expandable ? isOpen : undefined}
                >
                  <TableCell className="whitespace-nowrap font-medium">
                    <span className="inline-flex items-center gap-1">
                      {expandable ? <Chevron className="h-3.5 w-3.5 text-muted-foreground rtl:-scale-x-100" aria-hidden /> : <span className="w-3.5" />}
                      {monthLabel(r.month, report.calendar, locale, t)}
                      {r.month === current && <span className="text-xs font-normal text-muted-foreground">({sbLabel(t, 'revenue.toDate')})</span>}
                    </span>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{r.payments}</TableCell>
                  <TableCell className="text-end tabular-nums">{m(r.gross_minor)}</TableCell>
                  <TableCell className="text-end tabular-nums">{m(r.tax_minor)}</TableCell>
                  <TableCell className="text-end tabular-nums">{m(r.net_minor)}</TableCell>
                  <TableCell className="text-end tabular-nums">{r.refunds ? m(r.refund_gross_minor) : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">{r.refunds ? m(r.refund_net_minor) : '—'}</TableCell>
                  <TableCell className="text-end font-medium tabular-nums">{m(r.net_after_refunds_minor)}</TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={8}>
                      <div className="grid gap-4 py-1 md:grid-cols-3">
                        <SplitTable
                          title={sbLabel(t, 'revenue.byPurpose')}
                          entries={Object.entries(r.by_purpose)}
                          currency={currency}
                          labelOf={(k) => purposeLabel(t, k)}
                        />
                        <SplitTable
                          title={sbLabel(t, 'revenue.byProvider')}
                          entries={Object.entries(r.by_provider)}
                          currency={currency}
                          labelOf={(k) => k}
                        />
                        <SplitTable
                          title={sbLabel(t, 'revenue.bySource')}
                          entries={Object.entries(r.by_source)}
                          currency={currency}
                          labelOf={(k) => sourceLabel(t, k)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
          {total && (
            <TableRow className="border-t-2 font-semibold hover:bg-transparent">
              <TableCell />
              <TableCell className="text-end tabular-nums">{total.payments}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.gross_minor)}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.tax_minor)}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.net_minor)}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.refund_gross_minor)}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.refund_net_minor)}</TableCell>
              <TableCell className="text-end tabular-nums">{m(total.net_after_refunds_minor)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function MovementsTable({ report, currency }: { report: RevenueReport; currency: string }) {
  const { t, locale } = useTranslation();
  const rows = report.ledger.filter((l) => l.currency === currency).slice().reverse();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">{sbLabel(t, 'revenue.movements')}</h4>
        <Badge variant="outline" className="text-muted-foreground">{sbLabel(t, 'revenue.notRevenue')}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{sbLabel(t, 'revenue.movementsHint')}</p>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">{sbLabel(t, 'revenue.movementsEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{sbLabel(t, 'revenue.month')}</TableHead>
                <TableHead>{sbLabel(t, 'revenue.kind')}</TableHead>
                <TableHead className="text-end">{sbLabel(t, 'revenue.count')}</TableHead>
                <TableHead className="text-end">{sbLabel(t, 'revenue.in')}</TableHead>
                <TableHead className="text-end">{sbLabel(t, 'revenue.out')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => (
                <TableRow key={`${l.month}|${l.kind}`}>
                  <TableCell className="whitespace-nowrap">{monthLabel(l.month, report.calendar, locale, t)}</TableCell>
                  <TableCell>{kindLabel(t, l.kind)}</TableCell>
                  <TableCell className="text-end tabular-nums">{l.count}</TableCell>
                  <TableCell className="text-end tabular-nums">{l.in_minor ? money(l.in_minor, locale, currency) : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">{l.out_minor ? money(l.out_minor, locale, currency) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function LiabilityTiles({ row, currency }: { row: LiabilityRow | undefined; currency: string }) {
  const { t, locale } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Kpi label={sbLabel(t, 'accounts.liability.balance')} value={money(row?.balance_minor ?? 0, locale, currency)} />
      <Kpi label={sbLabel(t, 'accounts.liability.prepaid')} value={money(row?.prepaid_minor ?? 0, locale, currency)} />
      <Kpi
        label={sbLabel(t, 'accounts.liability.accounts')}
        value={String(row?.accounts ?? 0)}
        sub={t('admin.simpleBilling.accounts.liability.positive', { count: row?.positive_accounts ?? 0 })}
      />
    </div>
  );
}

/** The 12-month report year to date is computed from, and where its query is. */
interface YtdState {
  report: RevenueReport | undefined;
  failed: boolean;
  retry: () => void;
}

/**
 * Year to date, from the 12-month report only. While it loads the tiles
 * show a placeholder, and when it failed an error with a retry: never the
 * sum of a shorter report, which would leave months of this year out.
 */
function YtdRow({ ytd, currency }: { ytd: YtdState; currency: string }) {
  const { t } = useTranslation();
  const title = sbLabel(t, 'revenue.ytd');
  if (ytd.report) return <KpiRow title={title} sums={sumRows(kpiRows(ytd.report, currency).ytd)} currency={currency} />;
  if (ytd.failed) {
    return (
      <div className="space-y-2" data-testid={`revenue-ytd-failed-${currency}`}>
        <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-destructive/50 p-3 text-sm text-destructive">
          <span>{sbLabel(t, 'revenue.ytdFailed')}</span>
          <Button variant="outline" size="sm" onClick={ytd.retry}>{sbLabel(t, 'common.retry')}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid={`revenue-ytd-loading-${currency}`}>
      <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      <Skeleton className="h-[74px] w-full" />
    </div>
  );
}

function CurrencySection({ report, ytd, currency }: { report: RevenueReport; ytd: YtdState; currency: string }) {
  const { t } = useTranslation();
  const { lastMonth } = kpiRows(report, currency);
  const empty = (report.totals[currency]?.payments ?? 0) === 0 && (report.totals[currency]?.refunds ?? 0) === 0;
  return (
    <Card data-testid={`revenue-section-${currency}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          {t('admin.simpleBilling.revenue.section', { currency })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-6 xl:grid-cols-2">
          <KpiRow title={sbLabel(t, 'revenue.lastMonth')} sums={lastMonth} currency={currency} />
          <YtdRow ytd={ytd} currency={currency} />
        </div>
        {empty ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{sbLabel(t, 'revenue.empty')}</p>
        ) : (
          <>
            <RevenueChart report={report} currency={currency} />
            <MonthlyTable report={report} currency={currency} />
          </>
        )}
        <MovementsTable report={report} currency={currency} />
        <div className="space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-medium">
            <Landmark className="h-4 w-4 text-primary" aria-hidden />
            {sbLabel(t, 'revenue.liability')}
          </h4>
          <LiabilityTiles row={report.liability.find((l) => l.currency === currency)} currency={currency} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function RevenueTab() {
  const { t } = useTranslation();
  const [months, setMonths] = useState<number>(12);
  const [includeTest, setIncludeTest] = useState(false);
  const { data, isLoading, isError, refetch } = useAdminRevenue({ months, includeTest });
  // Year to date always comes from the 12-month report (the same query, and
  // cache entry, as the main one at 12 months). A placeholder (the previous
  // period or test switch, kept while the new one loads) is not used.
  const ytdQuery = useAdminRevenue({ months: 12, includeTest });
  const ytdData = ytdQuery.isPlaceholderData ? undefined : ytdQuery.data;
  const ytd: YtdState = { report: ytdData, failed: ytdQuery.isError && !ytdData, retry: () => void ytdQuery.refetch() };
  const csvNotes = [sbLabel(t, 'revenue.footnote.csvNote')];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{sbLabel(t, 'revenue.title')}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{sbLabel(t, 'revenue.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="revenue-months" className="text-sm text-muted-foreground">{sbLabel(t, 'revenue.months')}</Label>
            <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
              <SelectTrigger id="revenue-months" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTH_CHOICES.map((n) => (
                  <SelectItem key={n} value={String(n)}>{t('admin.simpleBilling.revenue.monthsOption', { count: n })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="revenue-include-test" checked={includeTest} onCheckedChange={setIncludeTest} />
            <Label htmlFor="revenue-include-test" className="text-sm">{sbLabel(t, 'revenue.includeTest')}</Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!data}
            onClick={() => data && downloadCsv(`revenue-${data.edition}-${fileDate()}.csv`, revenueCsvRows(data, csvNotes))}
          >
            <Download className="me-2 h-4 w-4" aria-hidden />
            {sbLabel(t, 'revenue.csv')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError || !data ? (
        <ErrorState message={sbLabel(t, 'common.loadFailed')} onRetry={() => void refetch()} retryLabel={sbLabel(t, 'common.retry')} />
      ) : (
        <>
          {data.currencies.map((currency) => (
            <CurrencySection key={currency} report={data} ytd={ytd} currency={currency} />
          ))}
          <Card className="border-dashed">
            <CardContent className="space-y-1.5 py-4 text-xs text-muted-foreground">
              {(['refundMonth', 'paddle', 'chargeback', 'purged'] as const).map((k) => (
                <p key={k} className="flex gap-2">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{sbLabel(t, `revenue.footnote.${k}`)}</span>
                </p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
