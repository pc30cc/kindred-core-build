import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

function stateBadge(state: AutoActionEvent['state']) {
  if (state === 'active') return <Badge className="bg-warning/15 text-warning">active</Badge>;
  if (state === 'expired') return <Badge variant="outline">expired</Badge>;
  if (state === 'resolved') return <Badge className="bg-success/15 text-success">resolved</Badge>;
  return <Badge variant="outline">overridden</Badge>;
}

function DefinitionRow({ def }: { def: AutoActionDefinition }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cooldown, setCooldown] = useState<string>(String(def.cooldown_seconds));
  const [duration, setDuration] = useState<string>(String(def.max_duration_seconds));

  const mut = useMutation({
    mutationFn: (patch: Parameters<typeof updateAutoActionDefinition>[1]) =>
      updateAutoActionDefinition(def.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-auto-action-defs'] });
      toast({ title: 'Action updated' });
    },
    onError: (err: Error) =>
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' }),
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
          {def.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
          )}
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
            trigger: {def.trigger_rule_slug || 'any-critical'} · min severity: {def.min_severity}
          </p>
        </div>
        <Switch
          checked={def.enabled}
          onCheckedChange={(v) => mut.mutate({ enabled: v })}
          disabled={mut.isPending}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">Cooldown (s)</Label>
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
          <Label className="text-[11px] text-muted-foreground">Max duration (s)</Label>
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
          <Label className="text-[11px] text-muted-foreground">Min severity</Label>
          <Select
            value={def.min_severity}
            onValueChange={(v) => mut.mutate({ min_severity: v as 'warn' | 'critical' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">warn</SelectItem>
              <SelectItem value="critical">critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

export default function AutoActionsPanel() {
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
        title: 'Cycle complete',
        description: `activated ${data.result.activated} · resolved ${data.result.resolved} · expired ${data.result.expired}`,
      });
    },
    onError: (err: Error) =>
      toast({ title: 'Evaluation failed', description: err.message, variant: 'destructive' }),
  });

  const overrideMut = useMutation({
    mutationFn: (id: string) => overrideAutoAction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-auto-action-active'] });
      qc.invalidateQueries({ queryKey: ['admin-auto-action-events'] });
      toast({ title: 'Action overridden' });
    },
    onError: (err: Error) =>
      toast({ title: 'Override failed', description: err.message, variant: 'destructive' }),
  });

  const active = activeQ.data?.active || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Self-healing actions</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => evalMut.mutate()}
          disabled={evalMut.isPending}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${evalMut.isPending ? 'animate-spin' : ''}`} />
          Evaluate now
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" /> Active actions ({active.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {active.length === 0 && (
            <p className="text-muted-foreground text-sm">No active auto-actions.</p>
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
                      trigger: {a.trigger_rule_slug || 'any-critical'} ·{' '}
                      expires {new Date(a.expires_at).toLocaleTimeString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => overrideMut.mutate(a.id)}
                    disabled={overrideMut.isPending}
                  >
                    <X className="h-3 w-3 mr-1" />
                    End
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Action definitions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {defsQ.isLoading && (
            <p className="text-muted-foreground text-sm">Loading definitions…</p>
          )}
          {(defsQ.data?.definitions || []).map((d) => (
            <DefinitionRow key={d.id} def={d} />
          ))}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Ended</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(eventsQ.data?.events || []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(e.started_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action_slug}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {e.trigger_rule_slug || '—'}
                  </TableCell>
                  <TableCell className="text-xs">{e.trigger_severity || '—'}</TableCell>
                  <TableCell className="text-xs">{stateBadge(e.state)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.ended_at ? `${e.ended_reason || 'ended'}` : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!eventsQ.isLoading && (eventsQ.data?.events.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground text-sm">
                    No auto-action events yet.
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