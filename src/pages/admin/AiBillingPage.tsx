/**
 * Super Admin — AI Usage Billing.
 *
 * Cost, margin, pricing (rate cards / FX / sell policy), run explorer and
 * billing health. Everything here is platform-internal: workspaces never see
 * provider cost, FX or the margin multiplier.
 */
import { useEffect, useState, useCallback } from 'react';
import { API_BASE } from '@/lib/apiBase';
import { formatToman } from '@/lib/money';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

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

/** Plain counts (runs, tokens). */
const nf = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0));
/**
 * Money. Everything financial is STORED in IRR and SHOWN in Toman — the
 * conversion lives only here, at the presentation boundary.
 */
const money = (irr: unknown, locale?: string) => formatToman(Number(irr ?? 0), locale);

export default function AiBillingPage() {
  const { t, locale } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<any>(null);
  const [pricing, setPricing] = useState<any>({ rateCards: [], exchangeRates: [], sellPolicies: [] });
  const [runs, setRuns] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  const [fxRate, setFxRate] = useState('');
  const [multiplier, setMultiplier] = useState('');
  const [card, setCard] = useState({ provider: '', modelKey: '', input: '', output: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, p, r, h] = await Promise.all([
        api<any>('/admin/overview'),
        api<any>('/admin/pricing'),
        api<any>('/admin/runs?limit=50'),
        api<any>('/admin/health'),
      ]);
      setOverview(o);
      setPricing(p);
      setRuns(r.runs || []);
      setHealth(h);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
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

  const publishFx = async () => {
    try {
      await api('/admin/pricing/exchange-rates', { method: 'POST', body: JSON.stringify({ from: 'USD', to: 'IRR', rate: fxRate }) });
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
      const report = await api<any>('/admin/recovery/run', { method: 'POST' });
      toast.success(`${t('aiBilling.recoveryDone')}: ${JSON.stringify(report)}`);
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

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('aiBilling.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('aiBilling.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
            <Label htmlFor="mode" className="text-sm">{t('aiBilling.enforced')}</Label>
            <Switch id="mode" disabled={saving} checked={overview?.mode === 'ENFORCED'} onCheckedChange={toggleMode} />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="me-2 h-4 w-4" /> {t('aiBilling.refresh')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: t('aiBilling.providerCost'), value: `$${(overview?.totals?.providerCostUsd || 0).toFixed(4)}` },
          { label: t('aiBilling.internalCost'), value: money(overview?.totals?.internalCostIrr, i18n.language) },
          { label: t('aiBilling.customerCharge'), value: money(overview?.totals?.customerChargeIrr, i18n.language) },
          { label: t('aiBilling.margin'), value: `${money(overview?.margin, i18n.language)} (${(overview?.marginPct || 0).toFixed(1)}%)` },
        ].map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-2">
              <CardDescription>{k.label}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold">{k.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="pricing">
        <TabsList>
          <TabsTrigger value="pricing">{t('aiBilling.pricing')}</TabsTrigger>
          <TabsTrigger value="runs">{t('aiBilling.runs')}</TabsTrigger>
          <TabsTrigger value="health">{t('aiBilling.health')}</TabsTrigger>
        </TabsList>

        <TabsContent value="pricing" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('aiBilling.fx')}</CardTitle>
                <CardDescription>{t('aiBilling.fxDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  {t('aiBilling.current')}: {money(Number(pricing.exchangeRates?.[0]?.rate || 0), i18n.language)} / USD
                </div>
                <div className="flex gap-2">
                  <Input value={fxRate} onChange={(e) => setFxRate(e.target.value)} placeholder="1000000" />
                  <Button onClick={publishFx} disabled={!fxRate}>{t('aiBilling.publish')}</Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('aiBilling.sellPolicy')}</CardTitle>
                <CardDescription>{t('aiBilling.sellPolicyHint')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  {t('aiBilling.current')}: ×{pricing.sellPolicies?.[0]?.multiplier ?? '1'}
                </div>
                <div className="flex gap-2">
                  <Input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} placeholder="1.5" />
                  <Button onClick={publishPolicy} disabled={!multiplier}>{t('aiBilling.publish')}</Button>
                </div>
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
                <Input placeholder="provider" value={card.provider} onChange={(e) => setCard({ ...card, provider: e.target.value })} />
                <Input placeholder="model" value={card.modelKey} onChange={(e) => setCard({ ...card, modelKey: e.target.value })} />
                <Input placeholder="input $/1M" value={card.input} onChange={(e) => setCard({ ...card, input: e.target.value })} />
                <Input placeholder="output $/1M" value={card.output} onChange={(e) => setCard({ ...card, output: e.target.value })} />
                <Button onClick={publishCard} disabled={!card.provider || !card.modelKey}>{t('aiBilling.publish')}</Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('aiBilling.provider')}</TableHead>
                    <TableHead>{t('aiBilling.model')}</TableHead>
                    <TableHead>v</TableHead>
                    <TableHead>{t('aiBilling.components')}</TableHead>
                    <TableHead>{t('aiBilling.effectiveFrom')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(pricing.rateCards || []).slice(0, 25).map((c: any) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.provider}</TableCell>
                      <TableCell className="font-mono text-xs">{c.model_key}</TableCell>
                      <TableCell>{c.version}</TableCell>
                      <TableCell className="text-xs">
                        {(c.ai_rate_card_components || [])
                          .map((k: any) => `${k.component_type}: ${k.unit_amount}/${nf(Number(k.per_units))}`)
                          .join(' · ')}
                      </TableCell>
                      <TableCell className="text-xs">{new Date(c.effective_from).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('aiBilling.entryPoint')}</TableHead>
                    <TableHead>{t('aiBilling.model')}</TableHead>
                    <TableHead>{t('aiBilling.status')}</TableHead>
                    <TableHead>{t('aiBilling.quality')}</TableHead>
                    <TableHead>$</TableHead>
                    <TableHead>{t('aiBilling.customerCharge')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{r.entry_point}</TableCell>
                      <TableCell className="font-mono text-xs">{r.primary_model || '—'}</TableCell>
                      <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={r.billing_quality === 'UNRESOLVED' ? 'destructive' : 'secondary'}>{r.billing_quality}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">{Number(r.provider_cost_usd || 0).toFixed(5)}</TableCell>
                      <TableCell className="text-xs">{money(r.customer_charge_irr, i18n.language)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="health" className="space-y-4">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={runRecovery}>
              <ShieldAlert className="me-2 h-4 w-4" /> {t('aiBilling.runRecovery')}
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[
              { title: t('aiBilling.ingestionConflicts'), rows: health?.ingestionConflicts },
              { title: t('aiBilling.unresolvedRuns'), rows: health?.unresolvedRuns },
              { title: t('aiBilling.staleReservations'), rows: health?.staleReservations },
              { title: t('aiBilling.idempotencyConflicts'), rows: health?.idempotencyConflicts },
            ].map((b) => (
              <Card key={b.title}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {b.title} <Badge variant={b.rows?.length ? 'destructive' : 'secondary'}>{b.rows?.length ?? 0}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="max-h-56 overflow-auto text-xs">
                  {(b.rows || []).slice(0, 20).map((row: any) => (
                    <pre key={row.id} className="whitespace-pre-wrap border-b py-1">{JSON.stringify(row)}</pre>
                  ))}
                  {!b.rows?.length && <span className="text-muted-foreground">{t('aiBilling.allClear')}</span>}
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
