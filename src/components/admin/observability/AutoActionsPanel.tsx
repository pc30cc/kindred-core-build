import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { Activity, RefreshCw, Shield, X } from 'lucide-react';
import { useState } from 'react';
import {
  fetchAutoActionDefinitions,
  fetchAutoActionEvents,
  fetchActiveAutoActions,
  evaluateAutoActionsNow,
  updateAutoActionDefinition,
  overrideAutoAction,
  type AutoActionDefinition,
  type AutoActionEvent,
} from '@/lib/admin-auto-actions-api';
import { useTranslation } from '@/i18n';

type Translate = ReturnType<typeof useTranslation>['t'];

function stateBadge(state: AutoActionEvent['state'], t: Translate) {
  const label = t(`admin.observability.autoActions.states.${state}` as any);
  if (state === 'active') return <Badge className="bg-warning/15 text-warning">{label}</Badge>;
  if (state === 'expired') return <Badge variant="outline">{label}</Badge>;
  if (state === 'resolved') return <Badge className="bg-success/15 text-success">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}

function DefinitionRow({ def }: { def: AutoActionDefinition }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cooldown, setCooldown] = useState<string>(String(def.cooldown_seconds));
  const [duration, setDuration] = useState<string>(String(def.max_duration_seconds));

  const mut = useMutation({
    mutationFn: (patch: Parameters<typeof updateAutoActionDefinition>[1]) => updateAutoActionDefinition(def.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-auto-action-defs'] });
      toast({
        title: t('admin.observability.autoActions.actionUpdated' as any),
      });
    },
    onError: (err: Error) =>
      toast({
        title: t('admin.observability.autoActions.updateFailed' as any),
        description: err.message,
        variant: 'destructive',
      }),
  });

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{def.title}</span>
            <Badge variant="outline" className="text-xs">
              {def.action_type}
            </Badge>
          </div>
          {def.description && <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>}
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
            {t('admin.observability.autoActions.triggerSummary' as any, {
              trigger: def.trigger_rule_slug || t('admin.observability.autoActions.anyCritical' as any),
              severity: t(`admin.observability.autoActions.severity.${def.min_severity}` as any),
            })}
          </p>
        </div>
        <Switch checked={def.enabled} onCheckedChange={(v) => mut.mutate({ enabled: v })} disabled={mut.isPending} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">
            {t('admin.observability.autoActions.cooldownSeconds' as any)}
          </Label>
          <Input
            type="number"
            min={60}
            max={86400}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
            onBlur={() => {
              const n = parseInt(cooldown, 10);
              if (Number.isFinite(n) && n !== def.cooldown_seconds) {
                mut.mutate({ cooldown_seconds: n });
              }
            }}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">
            {t('admin.observability.autoActions.maxDurationSeconds' as any)}
          </Label>
          <Input
            type="number"
            min={60}
            max={86400}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            onBlur={() => {
              const n = parseInt(duration, 10);
              if (Number.isFinite(n) && n !== def.max_duration_seconds) {
                mut.mutate({ max_duration_seconds: n });
              }
            }}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">
            {t('admin.observability.autoActions.minSeverity' as any)}
          </Label>
          <Select
            value={def.min_severity}
            onValueChange={(v) => mut.mutate({ min_severity: v as 'warn' | 'critical' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">{t('admin.observability.autoActions.severity.warn' as any)}</SelectItem>
              <SelectItem value="critical">{t('admin.observability.autoActions.severity.critical' as any)}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

export default function AutoActionsPanel() {
  const { t, locale } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const defsQ = useQuery({
    queryKey: ['admin-auto-action-defs'],
    queryFn: fetchAutoActionDefinitions,
  });
  const activeQ = useQuery({
    queryKey: ['admin-auto-action-active'],
    queryFn: fetchActiveAutoActions,
    refetchInterval: 30_000,
  });
  const eventsQ = useQuery({
    queryKey: ['admin-auto-action-events'],
    queryFn: () => fetchAutoActionEvents({ limit: 50 }),
    refetchInterval: 30_000,
  });

  const evalMut = useMutation({
    mutationFn: evaluateAutoActionsNow,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin-auto-action-active'] });
      qc.invalidateQueries({ queryKey: ['admin-auto-action-events'] });
      toast({
        title: t('admin.observability.autoActions.cycleComplete' as any),
        description: t('admin.observability.autoActions.cycleSummary' as any, {
          activated: data.result.activated,
          resolved: data.result.resolved,
          expired: data.result.expired,
        }),
      });
    },
    onError: (err: Error) =>
      toast({
        title: t('admin.observability.autoActions.evaluationFailed' as any),
        description: err.message,
        variant: 'destructive',
      }),
  });

  const overrideMut = useMutation({
    mutationFn: (id: string) => overrideAutoAction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-auto-action-active'] });
      qc.invalidateQueries({ queryKey: ['admin-auto-action-events'] });
      toast({
        title: t('admin.observability.autoActions.actionOverridden' as any),
      });
    },
    onError: (err: Error) =>
      toast({
        title: t('admin.observability.autoActions.overrideFailed' as any),
        description: err.message,
        variant: 'destructive',
      }),
  });

  const active = activeQ.data?.active || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">{t('admin.observability.autoActions.title' as any)}</h2>
        </div>
        <Button size="sm" variant="outline" onClick={() => evalMut.mutate()} disabled={evalMut.isPending}>
          <RefreshCw className={`h-4 w-4 me-1 ${evalMut.isPending ? 'animate-spin' : ''}`} />
          {t('admin.observability.autoActions.evaluateNow' as any)}
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />{' '}
            {t('admin.observability.autoActions.activeActions' as any, {
              count: active.length,
            })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 && (
            <p className="text-muted-foreground text-sm">{t('admin.observability.autoActions.noActive' as any)}</p>
          )}
          {active.length > 0 && (
            <div className="space-y-2">
              {active.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-warning/40 bg-warning/5 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-warning/15 text-warning">{a.action_type}</Badge>
                      <span className="font-mono text-xs text-foreground">{a.action_slug}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t('admin.observability.autoActions.activeSummary' as any, {
                        trigger: a.trigger_rule_slug || t('admin.observability.autoActions.anyCritical' as any),
                        expires: new Date(a.expires_at).toLocaleTimeString(locale),
                      })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => overrideMut.mutate(a.id)}
                    disabled={overrideMut.isPending}
                  >
                    <X className="h-3 w-3 me-1" />
                    {t('admin.observability.autoActions.end' as any)}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.autoActions.definitions' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {defsQ.isLoading && (
            <p className="text-muted-foreground text-sm">
              {t('admin.observability.autoActions.loadingDefinitions' as any)}
            </p>
          )}
          {(defsQ.data?.definitions || []).map((d) => (
            <DefinitionRow key={d.id} def={d} />
          ))}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.autoActions.recentEvents' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.observability.autoActions.started' as any)}</TableHead>
                <TableHead>{t('admin.observability.autoActions.action' as any)}</TableHead>
                <TableHead>{t('admin.observability.autoActions.trigger' as any)}</TableHead>
                <TableHead>{t('admin.observability.autoActions.severityLabel' as any)}</TableHead>
                <TableHead>{t('admin.observability.autoActions.state' as any)}</TableHead>
                <TableHead>{t('admin.observability.autoActions.ended' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(eventsQ.data?.events || []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(e.started_at).toLocaleString(locale)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action_slug}</TableCell>
                  <TableCell className="font-mono text-xs">{e.trigger_rule_slug || '—'}</TableCell>
                  <TableCell className="text-xs">
                    {e.trigger_severity
                      ? t(`admin.observability.autoActions.severity.${e.trigger_severity}` as any)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs">{stateBadge(e.state, t)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.ended_at ? e.ended_reason || t('admin.observability.autoActions.endedFallback' as any) : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!eventsQ.isLoading && (eventsQ.data?.events.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground text-sm">
                    {t('admin.observability.autoActions.noEvents' as any)}
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
