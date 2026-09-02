/**
 * Super Admin — AI Usage Billing.
 *
 * Cost, margin, pricing (rate cards / FX / sell policy), run explorer and
 * billing health. Everything here is platform-internal: workspaces never see
 * provider cost, FX or the margin multiplier.
 *
 * Presentation rules:
 *  - money is STORED in Rial and SHOWN in Toman (conversion only in money());
 *  - every label goes through i18n and the page follows the document direction;
 *  - health is rendered as explained tables, never raw JSON.
 */
import { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '@/lib/apiBase';
import { formatToman, tomanLabel } from '@/lib/money';
import { useTranslation } from '@/i18n';
import { formatDateTime } from '@/lib/date';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { toast } from 'sonner';
import {
  Loader2,
  RefreshCw,
  ShieldAlert,
  DownloadCloud,
  Activity,
  CircleDollarSign,
  TrendingUp,
  Wallet,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/ai-billing${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body as T;
}

export default function AiBillingPage() {
  const { t, locale, dir } = useTranslation();

  /** Plain counts (runs, tokens). */
  const nf = (n: unknown) => new Intl.NumberFormat(locale).format(Math.round(Number(n) || 0));
  /** Money — stored IRR, displayed Toman. */
  const money = (irr: unknown) => formatToman(Number(irr ?? 0), locale);
  const usd = (n: unknown, digits = 4) => `$${(Number(n) || 0).toFixed(digits)}`;
  const when = (v?: string | null) => (v ? formatDateTime(v) : '—');

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<any>(null);
  const [pricing, setPricing] = useState<any>({ rateCards: [], exchangeRates: [], sellPolicies: [] });
  const [coverage, setCoverage] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [fxLoading, setFxLoading] = useState(false);
  const [quotes, setQuotes] = useState<any[] | null>(null);

  const [fxRate, setFxRate] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [card, setCard] = useState({ provider: '', modelKey: '', input: '', output: '' });

  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  /** `silent` = background live tick: refresh data without flashing the spinner. */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [o, p, c, r, h] = await Promise.all([
        api<any>('/admin/overview'),
        api<any>('/admin/pricing'),
        api<any>('/admin/pricing/coverage').catch(() => null),
        api<any>('/admin/runs?limit=50'),
        api<any>('/admin/health'),
      ]);
      setOverview(o);
      setPricing(p);
      setCoverage(c);
      setRuns(r.runs || []);
      setHealth(h);
      setUpdatedAt(new Date());
    } catch (err: any) {
      if (!silent) toast.error(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live stats: poll every 10s while the tab is visible, and immediately on focus.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const id = window.setInterval(tick, 10_000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);


  const toggleMode = async (enforced: boolean) => {
    setSaving(true);
    try {
      await api('/admin/mode', { method: 'POST', body: JSON.stringify({ mode: enforced ? 'ENFORCED' : 'METER_ONLY' }) });
      toast.success(t('aiBilling.modeSaved'));
      void load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const fetchQuotes = async () => {
    setFxLoading(true);
    try {
      const res = await api<any>('/admin/pricing/fx-quotes');
      setQuotes(res.quotes || []);
      const ok = (res.quotes || []).filter((q: any) => q.ok);
      if (!ok.length) toast.error(t('aiBilling.fxFetchFailed'));
      else toast.success(t('aiBilling.fxFetched'));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setFxLoading(false);
    }
  };

  const publishFx = async (value?: string) => {
    const rate = String(value ?? fxRate).trim();
    if (!rate) return;
    try {
      await api('/admin/pricing/exchange-rates', { method: 'POST', body: JSON.stringify({ from: 'USD', to: 'IRR', rate }) });
      toast.success(t('aiBilling.published'));
      setFxRate('');
      void load();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const publishPolicy = async () => {
    try {
      await api('/admin/pricing/sell-policies', { method: 'POST', body: JSON.stringify({ scope: 'GLOBAL', multiplier }) });
      toast.success(t('aiBilling.published'));
      setMultiplier('');
      void load();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const publishCard = async () => {
    try {
      await api('/admin/pricing/rate-cards', {
        method: 'POST',
        body: JSON.stringify({
          provider: card.provider,
          modelKey: card.modelKey,
          currency: 'USD',
          components: [
            { component_type: 'INPUT_TOKENS', unit: 'TOKEN', unit_amount: card.input, per_units: 1_000_000 },
            { component_type: 'OUTPUT_TOKENS', unit: 'TOKEN', unit_amount: card.output, per_units: 1_000_000 },
          ],
        }),
      });
      toast.success(t('aiBilling.published'));
      setCard({ provider: '', modelKey: '', input: '', output: '' });
      void load();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const runRecovery = async () => {
    try {
      await api<any>('/admin/recovery/run', { method: 'POST' });
      toast.success(t('aiBilling.recoveryDone'));
      void load();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const enforced = overview?.mode === 'ENFORCED';
  const checklist = health?.validationChecklist || {};
  const issues =
    (checklist.ingestionConflictsOpen || 0) +
    (checklist.unresolvedRuns || 0) +
    (checklist.staleReservations || 0) +
    (checklist.settlementPendingRuns || 0) +
    (checklist.reconciliationMismatchWallets || 0) +
    (checklist.orphanUsageEvents || 0);

  const activeFx = pricing.exchangeRates?.find((r: any) => r.from_currency === 'USD' && r.to_currency === 'IRR' && !r.effective_to);
  const activePolicy = pricing.sellPolicies?.find((p: any) => p.scope === 'GLOBAL' && !p.effective_to);

  const kpis = [
    {
      icon: CircleDollarSign,
      label: t('aiBilling.providerCostAllTime'),
      hint: `${t('aiBilling.providerCostAllTimeHint')} · ${t('aiBilling.cycle')}: ${usd(overview?.totals?.providerCostUsd)}`,
      value: usd(overview?.providerCostUsdAllTime, 2),
    },

    {
      icon: Wallet,
      label: t('aiBilling.internalCost'),
      hint: t('aiBilling.internalCostHint'),
      value: money(overview?.totals?.internalCostIrr),
    },
    {
      icon: TrendingUp,
      label: t('aiBilling.customerCharge'),
      hint: t('aiBilling.customerChargeHint'),
      value: money(overview?.totals?.customerChargeIrr),
    },
    {
      icon: Activity,
      label: t('aiBilling.margin'),
      hint: t('aiBilling.marginHint'),
      value: `${money(overview?.margin)} · ${nf(overview?.marginPct)}%`,
    },
  ];

  return (
    <div dir={dir} className="space-y-6 p-6 text-[15px] leading-relaxed">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('aiBilling.title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('aiBilling.subtitle')}</p>
          <p className="text-xs text-muted-foreground">
            {t('aiBilling.cycle')}: <span className="font-semibold text-foreground">{overview?.cycleId}</span> ·{' '}
            {t('aiBilling.totalRuns')}: <span className="font-semibold text-foreground">{nf(overview?.runs)}</span>
            {updatedAt && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {t('aiBilling.liveUpdated')}: {updatedAt.toLocaleTimeString(locale)}
                </span>
              </>
            )}
          </p>

        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <Label htmlFor="mode" className="text-sm">{t('aiBilling.enforced')}</Label>
            <Switch id="mode" disabled={saving} checked={enforced} onCheckedChange={toggleMode} />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="me-2 h-4 w-4" /> {t('aiBilling.refresh')}
          </Button>
        </div>
      </div>

      <Alert variant={enforced ? 'destructive' : 'default'}>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>{enforced ? t('aiBilling.modeEnforcedTitle') : t('aiBilling.modeMeterTitle')}</AlertTitle>
        <AlertDescription>{enforced ? t('aiBilling.modeEnforcedHint') : t('aiBilling.modeMeterHint')}</AlertDescription>
      </Alert>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2 text-xs">
                <k.icon className="h-3.5 w-3.5" /> {k.label}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="text-2xl font-bold tabular-nums">{k.value}</div>
              <p className="text-xs text-muted-foreground">{k.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="pricing">
        <TabsList>
          <TabsTrigger value="pricing">{t('aiBilling.pricing')}</TabsTrigger>
          <TabsTrigger value="coverage">{t('aiBilling.coverage')}</TabsTrigger>
          <TabsTrigger value="runs">{t('aiBilling.runs')}</TabsTrigger>
          <TabsTrigger value="health">
            {t('aiBilling.health')}
            {issues > 0 && <Badge variant="destructive" className="ms-2">{nf(issues)}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* ───────── Pricing ───────── */}
        <TabsContent value="pricing" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('aiBilling.fx')}</CardTitle>
                <CardDescription>{t('aiBilling.fxDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                  <div className="text-muted-foreground">{t('aiBilling.fxActive')}</div>
                  <div className="text-lg font-bold tabular-nums">
                    {activeFx ? `${money(activeFx.rate)} / $1` : t('aiBilling.fxNone')}
                  </div>
                  {activeFx && (
                    <div className="text-xs text-muted-foreground">
                      {t('aiBilling.effectiveFrom')}: {when(activeFx.effective_from)} · {t('aiBilling.version')} {nf(activeFx.version)}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t('aiBilling.fxAuto')}</Label>
                    <Button variant="outline" size="sm" onClick={fetchQuotes} disabled={fxLoading}>
                      {fxLoading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <DownloadCloud className="me-2 h-4 w-4" />}
                      {t('aiBilling.fxFetch')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('aiBilling.fxAutoHint')}</p>
                  {quotes && (
                    <div className="space-y-2">
                      {quotes.map((q: any) => (
                        <div key={q.source} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-sm">
                          <div>
                            <div className="font-medium">
                              {q.kind === 'market' ? t('aiBilling.fxKindMarket') : t('aiBilling.fxKindOfficial')}{' '}
                              <span className="text-xs text-muted-foreground">({q.source})</span>
                            </div>
                            {q.ok ? (
                              <div className="text-xs tabular-nums text-muted-foreground">
                                {nf(q.rateToman)} {tomanLabel(locale)} · {when(q.fetchedAt)}
                              </div>
                            ) : (
                              <div className="text-xs text-destructive">{t('aiBilling.fxSourceFailed')}</div>
                            )}
                          </div>
                          {q.ok && (
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" onClick={() => setFxRate(String(q.rateIrr))}>
                                {t('aiBilling.fxUseValue')}
                              </Button>
                              <Button size="sm" onClick={() => void publishFx(String(q.rateIrr))}>
                                {t('aiBilling.publish')}
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">{t('aiBilling.fxManual')}</Label>
                  <div className="flex gap-2">
                    <Input
                      inputMode="numeric"
                      value={fxRate}
                      onChange={(e) => setFxRate(e.target.value)}
                      placeholder={t('aiBilling.fxPlaceholder')}
                    />
                    <Button onClick={() => void publishFx()} disabled={!fxRate}>{t('aiBilling.publish')}</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('aiBilling.fxManualHint')}
                    {fxRate && ` — ${money(fxRate)}`}
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('aiBilling.sellPolicy')}</CardTitle>
                <CardDescription>{t('aiBilling.sellPolicyHint')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                  <div className="text-muted-foreground">{t('aiBilling.multiplierActive')}</div>
                  <div className="text-lg font-bold tabular-nums">×{activePolicy?.multiplier ?? '1'}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('aiBilling.overagePolicy')}: {activePolicy?.overage_policy === 'HALT_BILLABLE_EXECUTION'
                      ? t('aiBilling.overageHalt')
                      : t('aiBilling.overageAbsorb')}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} placeholder="1.5" />
                  <Button onClick={publishPolicy} disabled={!multiplier}>{t('aiBilling.publish')}</Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('aiBilling.multiplierHint')}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('aiBilling.rateCards')}</CardTitle>
              <CardDescription>{t('aiBilling.rateCardsHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 md:grid-cols-5">
                <Input placeholder={t('aiBilling.provider')} value={card.provider} onChange={(e) => setCard({ ...card, provider: e.target.value })} />
                <Input placeholder={t('aiBilling.model')} value={card.modelKey} onChange={(e) => setCard({ ...card, modelKey: e.target.value })} />
                <Input placeholder={t('aiBilling.inputPerMillion')} value={card.input} onChange={(e) => setCard({ ...card, input: e.target.value })} />
                <Input placeholder={t('aiBilling.outputPerMillion')} value={card.output} onChange={(e) => setCard({ ...card, output: e.target.value })} />
                <Button onClick={publishCard} disabled={!card.provider || !card.modelKey}>{t('aiBilling.publish')}</Button>
              </div>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.provider')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.model')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.version')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.components')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.effectiveFrom')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.state')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pricing.rateCards || []).slice(0, 40).map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.provider}</TableCell>
                        <TableCell className="font-mono text-sm">{c.model_key}</TableCell>
                        <TableCell className="tabular-nums">{nf(c.version)}</TableCell>
                        <TableCell className="text-sm">
                          <div className="space-y-1">
                            {(c.ai_rate_card_components || []).map((k: any, i: number) => {
                              const per = Number(k.per_units) || 1;
                              const providerUsd = ((Number(k.unit_amount) || 0) / per) * 1_000_000;
                              const fxRate = Number(activeFx?.rate) || 0;
                              const mult = Number(activePolicy?.multiplier) || 1;
                              const internalIrr = providerUsd * fxRate;
                              const customerIrr = internalIrr * mult;
                              const profitIrr = customerIrr - internalIrr;
                              return (
                                <div key={i} className="rounded-md border bg-muted/30 px-2 py-1.5">
                                  <div className="mb-1 flex items-center gap-2">
                                    <Badge variant="outline" className="text-xs">
                                      {k.component_type === 'INPUT_TOKENS'
                                        ? t('aiBilling.componentInput')
                                        : k.component_type === 'OUTPUT_TOKENS'
                                          ? t('aiBilling.componentOutput')
                                          : k.component_type}
                                    </Badge>
                                    <span className="text-xs text-muted-foreground">{t('aiBilling.perMillionTitle')}</span>
                                  </div>
                                  <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                                    <dt className="text-muted-foreground">{t('aiBilling.colProviderPay')}</dt>
                                    <dd className="tabular-nums">{usd(providerUsd, 2)}{fxRate ? ` · ${money(internalIrr)}` : ''}</dd>
                                    <dt className="text-muted-foreground">{t('aiBilling.colCustomerPay')}</dt>
                                    <dd className="tabular-nums">{fxRate ? money(customerIrr) : '—'}</dd>
                                    <dt className="text-muted-foreground">{t('aiBilling.colProfit')}</dt>
                                    <dd className="tabular-nums text-emerald-600">{fxRate ? money(profitIrr) : '—'}</dd>
                                  </dl>
                                </div>
                              );
                            })}
                          </div>
                        </TableCell>

                        <TableCell className="text-sm">{when(c.effective_from)}</TableCell>
                        <TableCell>
                          <Badge variant={c.effective_to ? 'secondary' : 'default'}>
                            {c.effective_to ? t('aiBilling.stateArchived') : t('aiBilling.stateActive')}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!(pricing.rateCards || []).length && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{t('aiBilling.noRows')}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ───────── Coverage ───────── */}
        <TabsContent value="coverage" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('aiBilling.coverage')}</CardTitle>
              <CardDescription>{t('aiBilling.coverageHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {coverage?.missingRates?.length ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{t('aiBilling.missingRates')}</AlertTitle>
                  <AlertDescription>{t('aiBilling.missingRatesHint', { count: String(coverage.missingRates.length) })}</AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>{t('aiBilling.coverageComplete')}</AlertTitle>
                  <AlertDescription>{t('aiBilling.coverageCompleteHint')}</AlertDescription>
                </Alert>
              )}
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.provider')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.model')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.discoverySource')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.priced')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(coverage?.runtimePaths || []).map((p: any) => (
                      <TableRow key={`${p.provider}/${p.model}`}>
                        <TableCell className="font-medium">{p.provider}</TableCell>
                        <TableCell className="font-mono text-sm">{p.model}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{p.source}</TableCell>
                        <TableCell>
                          <Badge variant={p.priced ? 'secondary' : 'destructive'}>
                            {p.priced ? t('aiBilling.pricedYes') : t('aiBilling.pricedNo')}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!(coverage?.runtimePaths || []).length && (
                      <TableRow>
                        <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">{t('aiBilling.noRows')}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ───────── Runs ───────── */}
        <TabsContent value="runs">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('aiBilling.runs')}</CardTitle>
              <CardDescription>{t('aiBilling.runsHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.time')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.entryPoint')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.model')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.status')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.quality')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.providerCost')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.customerCharge')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{when(r.created_at)}</TableCell>
                        <TableCell className="text-sm">{r.entry_point}</TableCell>
                        <TableCell className="font-mono text-sm">{r.primary_model || '—'}</TableCell>
                        <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                        <TableCell>
                          <Badge variant={r.billing_quality === 'UNRESOLVED' ? 'destructive' : 'secondary'}>
                            {r.billing_quality === 'UNRESOLVED'
                              ? t('aiBilling.qualityUnresolved')
                              : r.billing_quality === 'ESTIMATED'
                                ? t('aiBilling.qualityEstimated')
                                : t('aiBilling.qualityMetered')}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">{usd(r.provider_cost_usd, 5)}</TableCell>
                        <TableCell className="tabular-nums text-sm font-medium">{money(r.customer_charge_irr)}</TableCell>
                      </TableRow>
                    ))}
                    {!runs.length && (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">{t('aiBilling.noRows')}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ───────── Health ───────── */}
        <TabsContent value="health" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('aiBilling.healthHint')}</p>
            <Button variant="outline" size="sm" onClick={runRecovery}>
              <ShieldAlert className="me-2 h-4 w-4" /> {t('aiBilling.runRecovery')}
            </Button>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('aiBilling.checklist')}</CardTitle>
              <CardDescription>{t('aiBilling.checklistHint')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { k: 'orphanUsage', v: checklist.orphanUsageEvents, bad: (checklist.orphanUsageEvents || 0) > 0 },
                { k: 'ingestionConflicts', v: checklist.ingestionConflictsOpen, bad: (checklist.ingestionConflictsOpen || 0) > 0 },
                { k: 'unresolvedRuns', v: checklist.unresolvedRuns, bad: (checklist.unresolvedRuns || 0) > 0 },
                { k: 'staleReservations', v: checklist.staleReservations, bad: (checklist.staleReservations || 0) > 0 },
                { k: 'settlementPending', v: checklist.settlementPendingRuns, bad: (checklist.settlementPendingRuns || 0) > 0 },
                { k: 'walletMismatch', v: checklist.reconciliationMismatchWallets, bad: (checklist.reconciliationMismatchWallets || 0) > 0 },
                { k: 'walletsTracked', v: checklist.walletsTracked, bad: false },
                { k: 'coverageRate', v: `${nf((health?.meterOnlyMetrics?.settlementCoverage ?? 1) * 100)}%`, bad: false },
              ].map((m) => (
                <div key={m.k} className="rounded-xl border p-3">
                  <div className="text-xs text-muted-foreground">{t(`aiBilling.metric.${m.k}` as any)}</div>
                  <div className={`mt-1 text-xl font-bold tabular-nums ${m.bad ? 'text-destructive' : ''}`}>
                    {typeof m.v === 'string' ? m.v : nf(m.v)}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('aiBilling.unresolvedRuns')}{' '}
                  <Badge variant={health?.unresolvedRuns?.length ? 'destructive' : 'secondary'}>{nf(health?.unresolvedRuns?.length)}</Badge>
                </CardTitle>
                <CardDescription>{t('aiBilling.unresolvedRunsHint')}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.time')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.workspace')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.reason')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(health?.unresolvedRuns || []).slice(0, 20).map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap text-sm">{when(r.created_at)}</TableCell>
                        <TableCell className="font-mono text-xs">{String(r.workspace_id || '').slice(0, 8)}</TableCell>
                        <TableCell className="text-sm">{r.unresolved_reason || '—'}</TableCell>
                      </TableRow>
                    ))}
                    {!health?.unresolvedRuns?.length && (
                      <TableRow><TableCell colSpan={3} className="py-4 text-center text-muted-foreground">{t('aiBilling.allClear')}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('aiBilling.staleReservations')}{' '}
                  <Badge variant={health?.staleReservations?.length ? 'destructive' : 'secondary'}>{nf(health?.staleReservations?.length)}</Badge>
                </CardTitle>
                <CardDescription>{t('aiBilling.staleReservationsHint')}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.workspace')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.amount')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.expiredAt')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(health?.staleReservations || []).slice(0, 20).map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">{String(r.workspace_id || '').slice(0, 8)}</TableCell>
                        <TableCell className="tabular-nums text-sm">{money(r.amount)}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{when(r.expires_at)}</TableCell>
                      </TableRow>
                    ))}
                    {!health?.staleReservations?.length && (
                      <TableRow><TableCell colSpan={3} className="py-4 text-center text-muted-foreground">{t('aiBilling.allClear')}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('aiBilling.ingestionConflicts')}{' '}
                  <Badge variant={health?.ingestionConflicts?.length ? 'destructive' : 'secondary'}>{nf(health?.ingestionConflicts?.length)}</Badge>
                </CardTitle>
                <CardDescription>{t('aiBilling.ingestionConflictsHint')}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.time')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.usageKey')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.reason')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(health?.ingestionConflicts || []).slice(0, 20).map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="whitespace-nowrap text-sm">{when(c.created_at)}</TableCell>
                        <TableCell className="font-mono text-xs">{String(c.usage_event_key || '').slice(0, 24)}</TableCell>
                        <TableCell className="text-sm">{c.conflict_reason || c.reason || '—'}</TableCell>
                      </TableRow>
                    ))}
                    {!health?.ingestionConflicts?.length && (
                      <TableRow><TableCell colSpan={3} className="py-4 text-center text-muted-foreground">{t('aiBilling.allClear')}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('aiBilling.idempotencyConflicts')}{' '}
                  <Badge variant={health?.idempotencyConflicts?.length ? 'destructive' : 'secondary'}>{nf(health?.idempotencyConflicts?.length)}</Badge>
                </CardTitle>
                <CardDescription>{t('aiBilling.idempotencyConflictsHint')}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.time')}</TableHead>
                      <TableHead className="font-semibold text-foreground">{t('aiBilling.details')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(health?.idempotencyConflicts || []).slice(0, 20).map((a: any) => (
                      <TableRow key={a.id}>
                        <TableCell className="whitespace-nowrap text-sm">{when(a.created_at)}</TableCell>
                        <TableCell className="font-mono text-xs break-all">{JSON.stringify(a.details ?? {})}</TableCell>
                      </TableRow>
                    ))}
                    {!health?.idempotencyConflicts?.length && (
                      <TableRow><TableCell colSpan={2} className="py-4 text-center text-muted-foreground">{t('aiBilling.allClear')}</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t('aiBilling.scheduler')}</CardTitle>
              <CardDescription>{t('aiBilling.schedulerHint')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">{t('aiBilling.schedulerLastRun')}</div>
                <div className="font-medium">{when(health?.recoveryScheduler?.lastRunAt)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('aiBilling.schedulerRunning')}</div>
                <div className="font-medium">{health?.recoveryScheduler?.running ? t('aiBilling.yes') : t('aiBilling.no')}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('aiBilling.schedulerLastError')}</div>
                <div className={`font-medium ${health?.recoveryScheduler?.lastError ? 'text-destructive' : ''}`}>
                  {health?.recoveryScheduler?.lastError || t('aiBilling.allClear')}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
