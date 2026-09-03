/**
 * Phase 7.5 — Admin Enforcement panel.
 * Read/write surface for SLO breaches, enforcement rules, active actions,
 * and the safety flags (kill switch, dry-run, max concurrent).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import {
  fetchEnforcementRules,
  fetchEnforcementFlags,
  updateEnforcementFlags,
  updateEnforcementRule,
  fetchSloBreaches,
  fetchEnforcementActions,
  fetchActiveEnforcementActions,
  evaluateEnforcementNow,
  overrideEnforcementAction,
  fetchEnforcementNormalizations,
  type EnforcementFlags,
} from '@/lib/admin-enforcement-api';
import { AlertTriangle, ShieldAlert, ShieldOff, ShieldCheck, Play, Power, GitMerge } from 'lucide-react';
import { useTranslation } from '@/i18n';

function fmtTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale);
}

export default function EnforcementPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [tab, setTab] = useState<'overview' | 'rules' | 'breaches' | 'history' | 'normalizations'>('overview');

  const flagsQ = useQuery({
    queryKey: ['enforcement-flags'],
    queryFn: fetchEnforcementFlags,
    refetchInterval: 15_000,
  });
  const rulesQ = useQuery({
    queryKey: ['enforcement-rules'],
    queryFn: fetchEnforcementRules,
    refetchInterval: 30_000,
  });
  const activeQ = useQuery({
    queryKey: ['enforcement-active'],
    queryFn: fetchActiveEnforcementActions,
    refetchInterval: 10_000,
  });
  const breachesQ = useQuery({
    queryKey: ['enforcement-breaches'],
    queryFn: () => fetchSloBreaches(),
    refetchInterval: 30_000,
  });
  const actionsQ = useQuery({
    queryKey: ['enforcement-actions'],
    queryFn: () => fetchEnforcementActions(50),
    refetchInterval: 30_000,
  });
  const normsQ = useQuery({
    queryKey: ['enforcement-normalizations'],
    queryFn: () => fetchEnforcementNormalizations(50),
    refetchInterval: 30_000,
  });

  const flagsMut = useMutation({
    mutationFn: (patch: Partial<EnforcementFlags>) => updateEnforcementFlags(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enforcement-flags'] });
      toast({ title: t('admin.observability.enforcement.flagsUpdated' as any) });
    },
    onError: (e: Error) =>
      toast({
        title: t('admin.observability.enforcement.updateFailed' as any),
        description: e.message,
        variant: 'destructive',
      }),
  });

  const ruleMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: any }) => updateEnforcementRule(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enforcement-rules'] });
      toast({ title: t('admin.observability.enforcement.ruleUpdated' as any) });
    },
    onError: (e: Error) =>
      toast({
        title: t('admin.observability.enforcement.ruleUpdateFailed' as any),
        description: e.message,
        variant: 'destructive',
      }),
  });

  const evalMut = useMutation({
    mutationFn: evaluateEnforcementNow,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['enforcement-active'] });
      qc.invalidateQueries({ queryKey: ['enforcement-breaches'] });
      qc.invalidateQueries({ queryKey: ['enforcement-actions'] });
      toast({
        title: t('admin.observability.enforcement.cycleComplete' as any),
        description: t('admin.observability.enforcement.cycleSummary' as any, {
          triggered: data.enforcement?.triggered ?? 0,
          opened: data.slo?.opened ?? 0,
        }),
      });
    },
    onError: (e: Error) =>
      toast({
        title: t('admin.observability.enforcement.cycleFailed' as any),
        description: e.message,
        variant: 'destructive',
      }),
  });

  const overrideMut = useMutation({
    mutationFn: overrideEnforcementAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enforcement-active'] });
      toast({ title: t('admin.observability.enforcement.actionOverridden' as any) });
    },
    onError: (e: Error) =>
      toast({
        title: t('admin.observability.enforcement.overrideFailed' as any),
        description: e.message,
        variant: 'destructive',
      }),
  });

  const flags = flagsQ.data?.flags;
  const active = activeQ.data?.active || [];
  const rules = rulesQ.data?.rules || [];
  const breaches = breachesQ.data?.breaches || [];
  const actions = actionsQ.data?.actions || [];
  const norms = normsQ.data?.normalizations || [];

  const openBreaches = breaches.filter((b) => b.state === 'open');

  return (
    <div className="space-y-6">
      {/* Safety flags */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2 text-sm">
            <ShieldAlert className="h-4 w-4" /> {t('admin.observability.enforcement.safety.title' as any)}
          </CardTitle>
          <CardDescription>{t('admin.observability.enforcement.safety.description' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flagsQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {flags && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <Label className="text-foreground flex items-center gap-2 text-sm">
                    <Power className="h-3.5 w-3.5" /> {t('admin.observability.enforcement.safety.killSwitch' as any)}
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {t('admin.observability.enforcement.safety.killSwitchHint' as any)}
                  </p>
                </div>
                <Switch checked={flags.kill_switch} onCheckedChange={(v) => flagsMut.mutate({ kill_switch: v })} />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <Label className="text-foreground text-sm">
                    {t('admin.observability.enforcement.safety.dryRun' as any)}
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {t('admin.observability.enforcement.safety.dryRunHint' as any)}
                  </p>
                </div>
                <Switch checked={flags.dry_run} onCheckedChange={(v) => flagsMut.mutate({ dry_run: v })} />
              </div>
              <div className="rounded-md border border-border p-3">
                <Label className="text-foreground text-sm">
                  {t('admin.observability.enforcement.safety.maxConcurrent' as any)}
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  defaultValue={flags.max_concurrent}
                  className="mt-2"
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v !== flags.max_concurrent) {
                      flagsMut.mutate({ max_concurrent: v });
                    }
                  }}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('admin.observability.enforcement.safety.maxConcurrentHint' as any)}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-2">
              {flags?.kill_switch ? (
                <Badge className="bg-destructive/15 text-destructive">
                  <ShieldOff className="me-1 h-3 w-3" /> {t('admin.observability.enforcement.disabled' as any)}
                </Badge>
              ) : (
                <Badge className="bg-success/15 text-success">
                  <ShieldCheck className="me-1 h-3 w-3" /> {t('admin.observability.enforcement.live' as any)}
                </Badge>
              )}
              {flags?.dry_run && (
                <Badge variant="outline">{t('admin.observability.enforcement.dryRunBadge' as any)}</Badge>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => evalMut.mutate()} disabled={evalMut.isPending}>
              <Play className="me-1 h-3 w-3" />
              {evalMut.isPending
                ? t('admin.observability.enforcement.running' as any)
                : t('admin.observability.enforcement.evaluateNow' as any)}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="overview">
            {t('admin.observability.enforcement.tabs.active' as any, { count: active.length })}
          </TabsTrigger>
          <TabsTrigger value="rules">
            {t('admin.observability.enforcement.tabs.rules' as any, { count: rules.length })}
          </TabsTrigger>
          <TabsTrigger value="breaches">
            {t('admin.observability.enforcement.tabs.breaches' as any, { count: openBreaches.length })}
          </TabsTrigger>
          <TabsTrigger value="history">{t('admin.observability.enforcement.tabs.history' as any)}</TabsTrigger>
          <TabsTrigger value="normalizations">
            {t('admin.observability.enforcement.tabs.normalizations' as any, { count: norms.length })}
          </TabsTrigger>
        </TabsList>

        {/* Active enforcement actions */}
        <TabsContent value="overview">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm">
                {t('admin.observability.enforcement.active.title' as any)}
              </CardTitle>
              <CardDescription>{t('admin.observability.enforcement.active.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {t('admin.observability.enforcement.active.empty' as any)}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.observability.enforcement.action' as any)}</TableHead>
                      <TableHead>{t('admin.observability.enforcement.rule' as any)}</TableHead>
                      <TableHead>{t('admin.observability.enforcement.started' as any)}</TableHead>
                      <TableHead>{t('admin.observability.enforcement.expires' as any)}</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {active.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono text-xs">{a.action_type}</TableCell>
                        <TableCell className="text-xs">{a.trigger_rule_slug || '—'}</TableCell>
                        <TableCell className="text-xs">{fmtTime(a.started_at, locale)}</TableCell>
                        <TableCell className="text-xs">{fmtTime(a.expires_at, locale)}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => overrideMut.mutate(a.id)}
                            disabled={overrideMut.isPending}
                          >
                            {t('admin.observability.enforcement.endNow' as any)}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Rules */}
        <TabsContent value="rules">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm">
                {t('admin.observability.enforcement.rules.title' as any)}
              </CardTitle>
              <CardDescription>{t('admin.observability.enforcement.rules.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {rules.map((r) => (
                <div key={r.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-foreground font-medium text-sm flex items-center gap-2">
                        {r.title}
                        {r.is_builtin && (
                          <Badge variant="outline" className="text-[10px]">
                            {t('admin.observability.enforcement.rules.builtin' as any)}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {t('admin.observability.enforcement.rules.priorityShort' as any)}{' '}
                          {r.priority.toLocaleString(locale)}
                        </Badge>
                      </p>
                      <p className="text-muted-foreground text-xs">{r.description}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t('admin.observability.enforcement.trigger' as any)}:{' '}
                        <span className="font-mono">
                          {t(`admin.observability.enforcement.triggerTypes.${r.trigger_type}` as any)}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.actions_json.map((a) => (
                          <Badge key={a} variant="outline" className="text-[10px] font-mono">
                            {a}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => ruleMut.mutate({ id: r.id, patch: { enabled: v } })}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label className="text-muted-foreground text-xs">
                        {t('admin.observability.enforcement.rules.cooldown' as any)}
                      </Label>
                      <Input
                        type="number"
                        min={60}
                        max={86_400}
                        defaultValue={r.cooldown_seconds}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (Number.isFinite(v) && v !== r.cooldown_seconds) {
                            ruleMut.mutate({ id: r.id, patch: { cooldown_seconds: v } });
                          }
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-muted-foreground text-xs">
                        {t('admin.observability.enforcement.rules.ttl' as any)}
                      </Label>
                      <Input
                        type="number"
                        min={60}
                        max={86_400}
                        defaultValue={r.ttl_seconds}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (Number.isFinite(v) && v !== r.ttl_seconds) {
                            ruleMut.mutate({ id: r.id, patch: { ttl_seconds: v } });
                          }
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-muted-foreground text-xs">
                        {t('admin.observability.enforcement.rules.priority' as any)}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={1000}
                        defaultValue={r.priority}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (Number.isFinite(v) && v !== r.priority) {
                            ruleMut.mutate({ id: r.id, patch: { priority: v } });
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('admin.observability.enforcement.rules.empty' as any)}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Open breaches */}
        <TabsContent value="breaches">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> {t('admin.observability.enforcement.breaches.title' as any)}
              </CardTitle>
              <CardDescription>{t('admin.observability.enforcement.breaches.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SLO</TableHead>
                    <TableHead>{t('admin.observability.enforcement.scope' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.breaches.observedTarget' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.state' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.breaches.lastBreach' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breaches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">{b.slo_slug}</TableCell>
                      <TableCell className="text-xs">
                        {b.scope_type}:{b.scope_key.slice(0, 12)}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {b.observed_value ?? '—'} / {b.target_value} ({b.target_type})
                      </TableCell>
                      <TableCell>
                        {b.state === 'open' ? (
                          <Badge className="bg-destructive/15 text-destructive">
                            {t('admin.observability.enforcement.breaches.openCount' as any, {
                              count: b.consecutive_breaches,
                            })}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t('admin.observability.enforcement.resolved' as any)}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{fmtTime(b.last_breach_at, locale)}</TableCell>
                    </TableRow>
                  ))}
                  {breaches.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                        {t('admin.observability.enforcement.breaches.empty' as any)}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History */}
        <TabsContent value="history">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm">
                {t('admin.observability.enforcement.history.title' as any)}
              </CardTitle>
              <CardDescription>{t('admin.observability.enforcement.history.description' as any)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.observability.enforcement.time' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.rule' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.trigger' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.scope' as any)}</TableHead>
                    <TableHead>{t('admin.observability.enforcement.mode' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtTime(a.created_at, locale)}</TableCell>
                      <TableCell className="font-mono text-xs">{a.rule_slug}</TableCell>
                      <TableCell className="text-xs">
                        {t(`admin.observability.enforcement.triggerTypes.${a.trigger_type}` as any)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {a.scope_type}:{a.scope_key.slice(0, 12)}
                      </TableCell>
                      <TableCell>
                        {a.dry_run ? (
                          <Badge variant="outline">{t('admin.observability.enforcement.dryRunBadge' as any)}</Badge>
                        ) : (
                          <Badge className="bg-primary/15 text-primary">
                            {t('admin.observability.enforcement.applied' as any)}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {actions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                        {t('admin.observability.enforcement.history.empty' as any)}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Normalizations */}
        <TabsContent value="normalizations">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm flex items-center gap-2">
                <GitMerge className="h-4 w-4" /> {t('admin.observability.enforcement.normalizations.title' as any)}
              </CardTitle>
              <CardDescription>
                {t('admin.observability.enforcement.normalizations.description' as any)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {norms.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  {t('admin.observability.enforcement.normalizations.empty' as any)}
                </p>
              )}
              {norms.map((n) => (
                <div key={n.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-foreground text-sm font-medium">{fmtTime(n.created_at, locale)}</p>
                    <Badge variant="outline" className="text-[10px]">
                      {t('admin.observability.enforcement.normalizations.changes' as any, { count: n.reasons.length })}
                    </Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-muted-foreground text-[11px] uppercase">
                        {t('admin.observability.enforcement.normalizations.raw' as any)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {n.raw_actions.map((r, i) => (
                          <Badge key={i} variant="outline" className="text-[10px] font-mono">
                            {r.action_type} · {r.rule_slug} · p{r.rule_priority}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-[11px] uppercase">
                        {t('admin.observability.enforcement.normalizations.normalized' as any)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {n.normalized_actions.map((r, i) => (
                          <Badge key={i} className="bg-primary/15 text-primary text-[10px] font-mono">
                            {r.action_type} · {r.rule_slug} · p{r.rule_priority}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                  <ul className="text-muted-foreground space-y-1 text-xs">
                    {n.reasons.map((r, i) => (
                      <li key={i}>
                        <span className="font-mono text-foreground/70">[{r.kind}]</span>{' '}
                        <span className="font-mono">{r.action_type}</span> ({r.rule_slug}) — {r.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
