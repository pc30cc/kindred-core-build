/**
 * Phase 6A — Realtime Control & Failover settings panel.
 *
 * Configuration-only. The active provider continues to flow through
 * `resolveRealtimeProvider()`; the failover engine that consumes these
 * settings is delivered in Phase 6B.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { ArrowDown, ArrowUp, Lock, RotateCcw, Save } from 'lucide-react';
import { realtimeControlApi, type RealtimeControlSettings, type RealtimeProviderId } from '@/lib/realtime-control-api';
import FailoverStatePanel from './FailoverStatePanel';
import { useTranslation } from '@/i18n';

const PROVIDER_LABEL: Record<RealtimeProviderId, string> = {
  centrifugo: 'Centrifugo',
  supabase_realtime: 'Supabase Realtime',
  polling_builtin: 'Polling',
};

const ALL_PROVIDERS: RealtimeProviderId[] = ['centrifugo', 'supabase_realtime', 'polling_builtin'];

function healthBadge(status: string, label: string) {
  if (status === 'healthy') return <Badge className="bg-success/15 text-success">{label}</Badge>;
  if (status === 'degraded') return <Badge className="bg-warning/15 text-warning">{label}</Badge>;
  if (status === 'down') return <Badge variant="destructive">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function BoolRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-foreground">
          {label}
        </Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function RealtimeControlPanel() {
  const { t, locale } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const q = useQuery({
    queryKey: ['admin-realtime-control'],
    queryFn: () => realtimeControlApi.get(),
    refetchInterval: 30_000,
  });
  const auditQ = useQuery({
    queryKey: ['admin-realtime-control-audit'],
    queryFn: () => realtimeControlApi.audit(),
    refetchInterval: 60_000,
  });

  const [draft, setDraft] = useState<RealtimeControlSettings | null>(null);

  useEffect(() => {
    if (q.data?.settings && !draft) setDraft(q.data.settings);
  }, [q.data, draft]);

  const dirty = useMemo(() => {
    if (!draft || !q.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(q.data.settings);
  }, [draft, q.data]);

  const save = useMutation({
    mutationFn: (patch: Partial<RealtimeControlSettings>) => realtimeControlApi.update(patch),
    onSuccess: ({ settings }) => {
      setDraft(settings);
      qc.invalidateQueries({ queryKey: ['admin-realtime-control'] });
      qc.invalidateQueries({ queryKey: ['admin-realtime-control-audit'] });
      toast({ title: t('admin.observability.realtimeControl.saved' as any) });
    },
    onError: (err: Error) =>
      toast({
        title: t('admin.observability.realtimeControl.saveFailed' as any),
        description: err.message,
        variant: 'destructive',
      }),
  });

  if (q.isLoading || !draft) {
    return <p className="text-muted-foreground text-sm">{t('admin.observability.realtimeControl.loading' as any)}</p>;
  }
  if (q.error || !q.data) {
    return <p className="text-destructive text-sm">{t('admin.observability.realtimeControl.loadFailed' as any)}</p>;
  }

  const set = <K extends keyof RealtimeControlSettings>(k: K, v: RealtimeControlSettings[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  function moveProvider(idx: number, dir: -1 | 1) {
    setDraft((d) => {
      if (!d) return d;
      const order = [...d.realtime_provider_order];
      const j = idx + dir;
      if (j < 0 || j >= order.length) return d;
      [order[idx], order[j]] = [order[j], order[idx]];
      return { ...d, realtime_provider_order: order };
    });
  }

  function resetDefaults() {
    if (!q.data) return;
    setDraft(q.data.defaults);
  }

  const active = q.data.active;

  return (
    <div className="space-y-6">
      {/* Active provider snapshot */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.realtimeControl.activeProvider' as any)}
          </CardTitle>
          <CardDescription>
            {t('admin.observability.realtimeControl.activeDescriptionBefore' as any)}
            <span className="font-mono"> realtime_provider_lock</span>.
            {t('admin.observability.realtimeControl.activeDescriptionAfter' as any)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.configured' as any)}
              </p>
              <p className="font-mono text-sm text-foreground">{active.configured_vendor}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.effective' as any)}
              </p>
              <p className="font-mono text-sm text-foreground">{active.effective_vendor}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('admin.observability.realtimeControl.source' as any)}</p>
              <p className="font-mono text-sm text-foreground">{active.source}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('admin.observability.realtimeControl.health' as any)}</p>
              <div>
                {healthBadge(
                  active.health.status,
                  t(`admin.observability.realtimeControl.status.${active.health.status}` as any),
                )}
              </div>
            </div>
          </div>
          {active.health.message && <p className="mt-2 text-xs text-muted-foreground">{active.health.message}</p>}
        </CardContent>
      </Card>

      {/* Phase 6B — Failover engine state */}
      <FailoverStatePanel />

      {/* Degradation policy */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.realtimeControl.degradation.title' as any)}
          </CardTitle>
          <CardDescription>{t('admin.observability.realtimeControl.degradation.description' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <BoolRow
            id="deg-enabled"
            label={t('admin.observability.realtimeControl.degradation.enable' as any)}
            hint={t('admin.observability.realtimeControl.degradation.enableHint' as any)}
            checked={draft.realtime_degraded_mode_enabled}
            onChange={(v) => set('realtime_degraded_mode_enabled', v)}
          />
          <BoolRow
            id="deg-typing"
            label={t('admin.observability.realtimeControl.degradation.disableTyping' as any)}
            hint={t('admin.observability.realtimeControl.degradation.disableTypingHint' as any)}
            checked={draft.realtime_disable_typing_on_overload}
            onChange={(v) => set('realtime_disable_typing_on_overload', v)}
          />
          <BoolRow
            id="deg-polling"
            label={t('admin.observability.realtimeControl.degradation.forcePolling' as any)}
            hint={t('admin.observability.realtimeControl.degradation.forcePollingHint' as any)}
            checked={draft.realtime_force_polling_on_critical_degradation}
            onChange={(v) => set('realtime_force_polling_on_critical_degradation', v)}
          />
          <BoolRow
            id="deg-auto-recover"
            label={t('admin.observability.realtimeControl.degradation.autoRecover' as any)}
            hint={t('admin.observability.realtimeControl.degradation.autoRecoverHint' as any)}
            checked={draft.realtime_degraded_mode_auto_recover}
            onChange={(v) => set('realtime_degraded_mode_auto_recover', v)}
          />
          <BoolRow
            id="deg-fail-open"
            label={t('admin.observability.realtimeControl.degradation.failOpen' as any)}
            hint={t('admin.observability.realtimeControl.degradation.failOpenHint' as any)}
            checked={draft.realtime_fail_open_if_control_plane_stale}
            onChange={(v) => set('realtime_fail_open_if_control_plane_stale', v)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id="deg-backoff"
              label={t('admin.observability.realtimeControl.degradation.backoff' as any)}
              hint={t('admin.observability.realtimeControl.degradation.backoffHint' as any)}
              value={draft.realtime_reconnect_backoff_multiplier_on_overload}
              onChange={(n) => set('realtime_reconnect_backoff_multiplier_on_overload', n)}
              step={0.1}
              min={1}
              max={10}
            />
            <NumberField
              id="deg-ttl"
              label={t('admin.observability.realtimeControl.degradation.ttl' as any)}
              hint={t('admin.observability.realtimeControl.degradation.ttlHint' as any)}
              value={draft.realtime_degraded_mode_ttl_seconds}
              onChange={(n) => set('realtime_degraded_mode_ttl_seconds', n)}
              min={30}
              max={86_400}
            />
          </div>
        </CardContent>
      </Card>

      {/* Provider priority */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.realtimeControl.priority.title' as any)}
          </CardTitle>
          <CardDescription>{t('admin.observability.realtimeControl.priority.description' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            {draft.realtime_provider_order.map((p, idx) => (
              <div key={p} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="font-mono">
                    {idx + 1}
                  </Badge>
                  <span className="text-sm text-foreground">
                    {p === 'polling_builtin'
                      ? t('admin.observability.realtimeControl.pollingBuiltin' as any)
                      : PROVIDER_LABEL[p]}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">{p}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => moveProvider(idx, -1)}
                    disabled={idx === 0}
                    aria-label={t('admin.observability.realtimeControl.priority.moveUp' as any)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => moveProvider(idx, 1)}
                    disabled={idx === draft.realtime_provider_order.length - 1}
                    aria-label={t('admin.observability.realtimeControl.priority.moveDown' as any)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label className="text-foreground flex items-center gap-2">
              <Lock className="h-3.5 w-3.5" />
              {t('admin.observability.realtimeControl.priority.manualLock' as any)}
            </Label>
            <Select
              value={draft.realtime_provider_lock ?? '__none'}
              onValueChange={(v) => set('realtime_provider_lock', v === '__none' ? null : (v as RealtimeProviderId))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">
                  {t('admin.observability.realtimeControl.priority.noneAuto' as any)}
                </SelectItem>
                {ALL_PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p === 'polling_builtin'
                      ? t('admin.observability.realtimeControl.pollingBuiltin' as any)
                      : PROVIDER_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('admin.observability.realtimeControl.priority.lockHint' as any)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Failover thresholds */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.realtimeControl.thresholds.title' as any)}
          </CardTitle>
          <CardDescription>{t('admin.observability.realtimeControl.thresholds.description' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <BoolRow
            id="fo-enabled"
            label={t('admin.observability.realtimeControl.thresholds.enableFailover' as any)}
            hint={t('admin.observability.realtimeControl.thresholds.enableFailoverHint' as any)}
            checked={draft.realtime_failover_enabled}
            onChange={(v) => set('realtime_failover_enabled', v)}
          />
          <BoolRow
            id="fb-enabled"
            label={t('admin.observability.realtimeControl.thresholds.enableFailback' as any)}
            hint={t('admin.observability.realtimeControl.thresholds.enableFailbackHint' as any)}
            checked={draft.realtime_failback_enabled}
            onChange={(v) => set('realtime_failback_enabled', v)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id="fo-cooldown"
              label={t('admin.observability.realtimeControl.thresholds.cooldown' as any)}
              hint={t('admin.observability.realtimeControl.thresholds.cooldownHint' as any)}
              value={draft.realtime_failover_cooldown_seconds}
              onChange={(n) => set('realtime_failover_cooldown_seconds', n)}
              min={30}
              max={86_400}
            />
            <NumberField
              id="fb-stable"
              label={t('admin.observability.realtimeControl.thresholds.stableWindow' as any)}
              hint={t('admin.observability.realtimeControl.thresholds.stableWindowHint' as any)}
              value={draft.realtime_failback_stable_window_seconds}
              onChange={(n) => set('realtime_failback_stable_window_seconds', n)}
              min={30}
              max={86_400}
            />
            <NumberField
              id="fo-error"
              label={t('admin.observability.realtimeControl.thresholds.errorRate' as any)}
              hint={t('admin.observability.realtimeControl.thresholds.errorRateHint' as any)}
              value={draft.realtime_failover_error_threshold}
              onChange={(n) => set('realtime_failover_error_threshold', n)}
              step={0.005}
              min={0}
              max={1}
            />
            <NumberField
              id="fo-latency"
              label={t('admin.observability.realtimeControl.thresholds.latency' as any)}
              hint={t('admin.observability.realtimeControl.thresholds.latencyHint' as any)}
              value={draft.realtime_failover_latency_threshold_ms}
              onChange={(n) => set('realtime_failover_latency_threshold_ms', n)}
              min={50}
              max={60_000}
            />
            <NumberField
              id="fo-window"
              label={t('admin.observability.realtimeControl.thresholds.healthWindow' as any)}
              hint={t('admin.observability.realtimeControl.thresholds.healthWindowHint' as any)}
              value={draft.realtime_failover_health_window_seconds}
              onChange={(n) => set('realtime_failover_health_window_seconds', n)}
              min={30}
              max={86_400}
            />
          </div>
        </CardContent>
      </Card>

      {/* Save bar */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={resetDefaults} disabled={save.isPending}>
          <RotateCcw className="h-4 w-4 me-2" />
          {t('admin.observability.realtimeControl.resetDefaults' as any)}
        </Button>
        <Button onClick={() => draft && save.mutate(draft)} disabled={!dirty || save.isPending}>
          <Save className="h-4 w-4 me-2" />
          {save.isPending
            ? t('admin.observability.realtimeControl.saving' as any)
            : dirty
              ? t('admin.observability.realtimeControl.saveChanges' as any)
              : t('admin.observability.realtimeControl.noChanges' as any)}
        </Button>
      </div>

      {/* Audit */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.realtimeControl.audit.title' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.observability.realtimeControl.audit.time' as any)}</TableHead>
                <TableHead>{t('admin.observability.realtimeControl.audit.action' as any)}</TableHead>
                <TableHead>{t('admin.observability.realtimeControl.audit.result' as any)}</TableHead>
                <TableHead>{t('admin.observability.realtimeControl.audit.diff' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(auditQ.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(e.created_at).toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="text-xs">{e.result ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[420px] truncate">
                    {e.config_diff && Object.keys(e.config_diff).length ? JSON.stringify(e.config_diff) : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!auditQ.isLoading && (auditQ.data?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground text-sm">
                    {t('admin.observability.realtimeControl.audit.empty' as any)}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
