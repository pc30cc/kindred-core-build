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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function EnforcementPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<
    'overview' | 'rules' | 'breaches' | 'history' | 'normalizations'
  >('overview');

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
      toast({ title: 'Flags updated' });
    },
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });

  const ruleMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: any }) => updateEnforcementRule(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enforcement-rules'] });
      toast({ title: 'Rule updated' });
    },
    onError: (e: Error) => toast({ title: 'Rule update failed', description: e.message, variant: 'destructive' }),
  });

  const evalMut = useMutation({
    mutationFn: evaluateEnforcementNow,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['enforcement-active'] });
      qc.invalidateQueries({ queryKey: ['enforcement-breaches'] });
      qc.invalidateQueries({ queryKey: ['enforcement-actions'] });
      toast({
        title: 'Cycle complete',
        description: `Triggered: ${data.enforcement?.triggered ?? 0} · SLO opened: ${data.slo?.opened ?? 0}`,
      });
    },
    onError: (e: Error) => toast({ title: 'Cycle failed', description: e.message, variant: 'destructive' }),
  });

  const overrideMut = useMutation({
    mutationFn: overrideEnforcementAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['enforcement-active'] });
      toast({ title: 'Action overridden' });
    },
    onError: (e: Error) => toast({ title: 'Override failed', description: e.message, variant: 'destructive' }),
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
            <ShieldAlert className="h-4 w-4" /> Safety controls
          </CardTitle>
          <CardDescription>
            Kill switch, dry-run mode, and platform-wide max concurrent enforcement actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {flagsQ.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {flags && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <Label className="text-foreground flex items-center gap-2 text-sm">
                    <Power className="h-3.5 w-3.5" /> Kill switch
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Disables ALL enforcement activations.
                  </p>
                </div>
                <Switch
                  checked={flags.kill_switch}
                  onCheckedChange={(v) => flagsMut.mutate({ kill_switch: v })}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <Label className="text-foreground text-sm">Dry-run mode</Label>
                  <p className="text-muted-foreground text-xs">
                    Logs what would happen without applying.
                  </p>
                </div>
                <Switch
                  checked={flags.dry_run}
                  onCheckedChange={(v) => flagsMut.mutate({ dry_run: v })}
                />
              </div>
              <div className="rounded-md border border-border p-3">
                <Label className="text-foreground text-sm">Max concurrent</Label>
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
                  Cap on simultaneous active enforcement actions.
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-2">
              {flags?.kill_switch ? (
                <Badge className="bg-destructive/15 text-destructive">
                  <ShieldOff className="mr-1 h-3 w-3" /> Enforcement disabled
                </Badge>
              ) : (
                <Badge className="bg-success/15 text-success">
                  <ShieldCheck className="mr-1 h-3 w-3" /> Enforcement live
                </Badge>
              )}
              {flags?.dry_run && <Badge variant="outline">Dry-run</Badge>}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => evalMut.mutate()}
              disabled={evalMut.isPending}
            >
              <Play className="mr-1 h-3 w-3" />
              {evalMut.isPending ? 'Running…' : 'Evaluate now'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="overview">Active actions ({active.length})</TabsTrigger>
          <TabsTrigger value="rules">Rules ({rules.length})</TabsTrigger>
          <TabsTrigger value="breaches">Open breaches ({openBreaches.length})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="normalizations">Normalizations ({norms.length})</TabsTrigger>
        </TabsList>

        {/* Active enforcement actions */}
        <TabsContent value="overview">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm">Currently active</CardTitle>
              <CardDescription>
                Actions inserted by the enforcement engine that are still in TTL.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {active.length === 0 ? (
                <p className="text-muted-foreground text-sm">No active enforcement actions.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {active.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-mono text-xs">{a.action_type}</TableCell>
                        <TableCell className="text-xs">{a.trigger_rule_slug || '—'}</TableCell>
                        <TableCell className="text-xs">{fmtTime(a.started_at)}</TableCell>
                        <TableCell className="text-xs">{fmtTime(a.expires_at)}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => overrideMut.mutate(a.id)}
                            disabled={overrideMut.isPending}
                          >
                            End now
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
              <CardTitle className="text-foreground text-sm">Enforcement rules</CardTitle>
              <CardDescription>
                Built-in rules. You can toggle them and tune cooldown / TTL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="rounded-md border border-border p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-foreground font-medium text-sm flex items-center gap-2">
                        {r.title}
                        {r.is_builtin && (
                          <Badge variant="outline" className="text-[10px]">builtin</Badge>
                        )}
                      </p>
                      <p className="text-muted-foreground text-xs">{r.description}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Trigger: <span className="font-mono">{r.trigger_type}</span>
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
                      onCheckedChange={(v) =>
                        ruleMut.mutate({ id: r.id, patch: { enabled: v } })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-muted-foreground text-xs">Cooldown (s)</Label>
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
                      <Label className="text-muted-foreground text-xs">TTL (s)</Label>
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
                  </div>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="text-muted-foreground text-sm">No rules defined.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Open breaches */}
        <TabsContent value="breaches">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> SLO breaches
              </CardTitle>
              <CardDescription>
                Sustained breaches detected across SLO definitions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SLO</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Observed / Target</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Last breach</TableHead>
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
                          <Badge className="bg-destructive/15 text-destructive">open ×{b.consecutive_breaches}</Badge>
                        ) : (
                          <Badge variant="outline">resolved</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{fmtTime(b.last_breach_at)}</TableCell>
                    </TableRow>
                  ))}
                  {breaches.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                        No breaches recorded.
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
              <CardTitle className="text-foreground text-sm">Enforcement history</CardTitle>
              <CardDescription>
                Audit log of every rule activation (including dry-run).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Mode</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {actions.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtTime(a.created_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{a.rule_slug}</TableCell>
                      <TableCell className="text-xs">{a.trigger_type}</TableCell>
                      <TableCell className="text-xs">
                        {a.scope_type}:{a.scope_key.slice(0, 12)}
                      </TableCell>
                      <TableCell>
                        {a.dry_run ? (
                          <Badge variant="outline">dry-run</Badge>
                        ) : (
                          <Badge className="bg-primary/15 text-primary">applied</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {actions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center text-sm">
                        No history yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
