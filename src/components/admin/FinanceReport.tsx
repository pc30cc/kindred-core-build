/**
 * Super Admin — platform financial report.
 *
 * Every number here comes from the server aggregation
 * (`/api/billing/admin/finance-report`), which reads the two financial
 * sources of truth (settled payments + payment attempts). The component
 * only renders; it never derives revenue client-side.
 */
import { useEffect, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { SkeletonStats, SkeletonCard } from '@/components/common/Skeletons';
import { billingAdminFinanceReport, type AdminFinanceReport } from '@/lib/api';
import { useTranslation } from '@/i18n';
import { formatDate } from '@/lib/date';
import { TrendingUp, Repeat, Percent, Receipt, Wallet, RefreshCcw } from 'lucide-react';

const PALETTE = [
  'hsl(var(--primary))',
  'hsl(142 71% 45%)',
  'hsl(38 92% 50%)',
  'hsl(199 89% 48%)',
  'hsl(280 65% 60%)',
  'hsl(0 72% 51%)',
];

function toman(value: number, locale: string): string {
  const l = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.NumberFormat(l, { maximumFractionDigits: 0 }).format(Math.round(value / 10));
}

export default function FinanceReport() {
  const { t, locale } = useTranslation();
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<AdminFinanceReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    billingAdminFinanceReport(months)
      .then((r) => { if (alive) setData(r); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [months]);

  const label = (k: string, fallback?: string) => {
    const v = t(`admin.financeReport.${k}` as never) as unknown as string;
    return v && !v.startsWith('admin.financeReport') ? v : (fallback ?? k);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonStats count={4} />
        <div className="grid gap-4 lg:grid-cols-2"><SkeletonCard /><SkeletonCard /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-10 text-center text-muted-foreground">{label('unavailable', '—')}</CardContent>
      </Card>
    );
  }

  const series = data.series.map((s) => ({
    ...s,
    monthLabel: formatDate(`${s.month}-01T00:00:00Z`, { year: '2-digit', month: 'short' }),
    revenueToman: Math.round(s.revenue / 10),
    subscriptionToman: Math.round(s.subscription / 10),
    topupToman: Math.round(s.topup / 10),
  }));

  const kpis = [
    { key: 'netRevenue', icon: Wallet, value: toman(data.totals.netRevenue, locale), tone: 'text-emerald-600 bg-emerald-500/10' },
    { key: 'mrr', icon: Repeat, value: toman(data.totals.mrrIrr, locale), tone: 'text-primary bg-primary/10' },
    { key: 'avgOrder', icon: Receipt, value: toman(data.totals.avgOrderValue, locale), tone: 'text-blue-600 bg-blue-500/10' },
    { key: 'conversion', icon: Percent, value: `${data.totals.conversionRate}%`, tone: 'text-amber-600 bg-amber-500/10', raw: true },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{label('title', 'گزارش مالی')}</h3>
          <p className="text-sm text-muted-foreground">{label('subtitle', '')}</p>
        </div>
        <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[3, 6, 12, 24].map((m) => (
              <SelectItem key={m} value={String(m)}>{t('admin.financeReport.rangeMonths' as never, { count: m })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(({ key, icon: Icon, value, tone, raw }) => (
          <Card key={key} className="bg-card border-border">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${tone}`}><Icon className="w-5 h-5" /></div>
                <div className="min-w-0">
                  <p className="text-xl font-bold text-foreground truncate">
                    {value}{!raw && <span className="text-xs font-normal text-muted-foreground ms-1">{label('currency', 'تومان')}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">{label(`kpi.${key}`, key)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Revenue trend */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <TrendingUp className="w-4 h-4" /> {label('charts.trend', 'روند درآمد')}
          </CardTitle>
          <CardDescription>{label('charts.trendHint', '')}</CardDescription>
        </CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="monthLabel" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false}
                tickFormatter={(v) => new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { notation: 'compact' }).format(v)} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }}
                formatter={(v: any) => [new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US').format(v as number), label('currency', 'تومان')]}
              />
              <Area type="monotone" dataKey="revenueToman" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#revFill)" name={label('charts.revenue', 'درآمد')} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Subscription vs top-up */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground">{label('charts.composition', 'ترکیب درآمد')}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="monthLabel" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false}
                  tickFormatter={(v) => new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { notation: 'compact' }).format(v)} />
                <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="subscriptionToman" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} name={label('charts.subscriptions', 'اشتراک')} />
                <Bar dataKey="topupToman" stackId="a" fill="hsl(142 71% 45%)" radius={[6, 6, 0, 0]} name={label('charts.topups', 'اعتبار هوش مصنوعی')} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Payment attempt statuses */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground">{label('charts.attempts', 'وضعیت تلاش‌های پرداخت')}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {data.byStatus.length === 0 ? (
              <div className="h-full grid place-items-center text-sm text-muted-foreground">{label('empty', '—')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.byStatus} dataKey="count" nameKey="status" innerRadius={55} outerRadius={90} paddingAngle={3}>
                    {data.byStatus.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 12 }}
                    formatter={(v: any) => (t(`admin.financeReport.status.${v}` as never) as unknown as string)?.replace(/^admin\.financeReport.*/, v)} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Revenue by provider */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground">{label('charts.byProvider', 'درآمد بر اساس درگاه')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.byProvider.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">{label('empty', '—')}</p>}
            {data.byProvider.map((p, i) => {
              const max = data.byProvider[0]?.revenue || 1;
              return (
                <div key={p.provider} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-foreground" dir="ltr">{p.provider}</span>
                    <span className="text-muted-foreground">{toman(p.revenue, locale)} · {p.count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, (p.revenue / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Plan distribution */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-foreground">{label('charts.byPlan', 'اشتراک‌های فعال بر اساس پلن')}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {data.planDistribution.length === 0 ? (
              <div className="h-full grid place-items-center text-sm text-muted-foreground">{label('empty', '—')}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.planDistribution} dataKey="count" nameKey="plan" outerRadius={90}>
                    {data.planDistribution.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top workspaces */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <RefreshCcw className="w-4 h-4" /> {label('charts.topWorkspaces', 'بیشترین پرداخت‌ها')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.topWorkspaces.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">{label('empty', '—')}</p>}
          {data.topWorkspaces.map((w, i) => (
            <div key={w.workspaceId} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
              <div className="flex items-center gap-3 min-w-0">
                <Badge variant="outline" className="text-xs">{i + 1}</Badge>
                <span className="text-sm text-foreground truncate">{w.name}</span>
              </div>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {toman(w.revenue, locale)} <span className="text-xs">{label('currency', 'تومان')}</span> · {w.count}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
