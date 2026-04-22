import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, RefreshCw, Webhook } from 'lucide-react';
import {
  fetchAlertRules,
  fetchAlertEvents,
  evaluateAlertsNow,
  updateAlertRule,
  fetchAlertWebhookConfig,
  updateAlertWebhookConfig,
  type AlertRule,
} from '@/lib/admin-alerts-api';

function severityBadge(severity: 'warn' | 'critical' | 'resolved') {
  if (severity === 'critical') return <Badge className="bg-destructive/15 text-destructive">critical</Badge>;
  if (severity === 'warn') return <Badge className="bg-warning/15 text-warning">warn</Badge>;
  return <Badge variant="outline">resolved</Badge>;
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [warn, setWarn] = useState<string>(String(rule.warn_threshold));
  const [critical, setCritical] = useState<string>(String(rule.critical_threshold));
  const [windowSec, setWindowSec] = useState<string>(String(rule.window_seconds));

  const mut = useMutation({
    mutationFn: (patch: Parameters<typeof updateAlertRule>[1]) =>
      updateAlertRule(rule.id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-alert-rules'] });
      toast({ title: 'Rule updated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' });
    },
  });

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{rule.title}</span>
            <Badge variant="outline" className="text-xs">{rule.kind}</Badge>
          </div>
          {rule.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{rule.description}</p>
          )}
          <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
            {rule.kind === 'count' && rule.metric}
            {rule.kind === 'ratio' && `${rule.numerator} / ${rule.denominator}`}
            {(rule.kind === 'perf_p95' || rule.kind === 'perf_p99' || rule.kind === 'perf_error_rate') &&
              `${rule.route_group} · ${rule.aggregation || rule.kind}`}
            {(rule.kind === 'process_avg' || rule.kind === 'process_ratio') &&
              `${rule.metric} · ${rule.aggregation || rule.kind}`}
            {rule.kind === 'combined' &&
              `combined: ${(rule.subrules || []).length} sub-rules`}
          </p>
        </div>
        <Switch
          checked={rule.enabled}
          onCheckedChange={(v) => mut.mutate({ enabled: v })}
          disabled={mut.isPending}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">Warn</Label>
          <Input
            type="number"
            step="any"
            value={warn}
            onChange={(e) => setWarn(e.target.value)}
            onBlur={() => {
              const n = Number(warn);
              if (Number.isFinite(n) && n !== rule.warn_threshold) {
                mut.mutate({ warn_threshold: n });
              }
            }}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Critical</Label>
          <Input
            type="number"
            step="any"
            value={critical}
            onChange={(e) => setCritical(e.target.value)}
            onBlur={() => {
              const n = Number(critical);
              if (Number.isFinite(n) && n !== rule.critical_threshold) {
                mut.mutate({ critical_threshold: n });
              }
            }}
          />
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">Window (s)</Label>
          <Input
            type="number"
            min={60}
            max={3600}
            value={windowSec}
            onChange={(e) => setWindowSec(e.target.value)}
            onBlur={() => {
              const n = parseInt(windowSec, 10);
              if (Number.isFinite(n) && n !== rule.window_seconds) {
                mut.mutate({ window_seconds: n });
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

function WebhookConfigCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({
    queryKey: ['admin-alert-webhook'],
    queryFn: fetchAlertWebhookConfig,
  });
  const [url, setUrl] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [hasInitialized, setHasInitialized] = useState(false);

  if (cfgQ.data && !hasInitialized) {
    setUrl(cfgQ.data.webhook_url || '');
    setHasInitialized(true);
  }

  const saveMut = useMutation({
    mutationFn: (input: Parameters<typeof updateAlertWebhookConfig>[0]) =>
      updateAlertWebhookConfig(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-alert-webhook'] });
      setSecret('');
      toast({ title: 'Webhook saved' });
    },
    onError: (err: Error) =>
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' }),
  });

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      updateAlertWebhookConfig({
        alerting_enabled: enabled,
        webhook_url: cfgQ.data?.webhook_url ?? null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-alert-webhook'] }),
  });

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-foreground text-sm flex items-center gap-2">
          <Webhook className="h-4 w-4" /> Alert webhook
        </CardTitle>
        <Switch
          checked={cfgQ.data?.alerting_enabled !== false}
          onCheckedChange={(v) => toggleMut.mutate(v)}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Optional outbound POST on every alert state change. Includes HMAC-SHA256
          signature in <code className="font-mono">X-Alert-Signature</code> when a
          secret is set. Disabled by default.
        </p>
        <div>
          <Label className="text-xs">Webhook URL</Label>
          <Input
            type="url"
            placeholder="https://hooks.example.com/alerts"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <Label className="text-xs">
            Signing secret {cfgQ.data?.webhook_secret_set && '(set — leave blank to keep)'}
          </Label>
          <Input
            type="password"
            placeholder={cfgQ.data?.webhook_secret_set ? '••••••••' : 'optional'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={saveMut.isPending}
            onClick={() =>
              saveMut.mutate({
                webhook_url: url.trim() === '' ? null : url.trim(),
                ...(secret ? { webhook_secret: secret } : {}),
              })
            }
          >
            Save webhook
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AlertsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const rulesQ = useQuery({ queryKey: ['admin-alert-rules'], queryFn: fetchAlertRules });
  const eventsQ = useQuery({
    queryKey: ['admin-alert-events'],
    queryFn: () => fetchAlertEvents({ limit: 50 }),
    refetchInterval: 30_000,
  });
  const evalMut = useMutation({
    mutationFn: evaluateAlertsNow,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin-alert-events'] });
      qc.invalidateQueries({ queryKey: ['admin-alert-active'] });
      toast({
        title: 'Evaluation complete',
        description: `${data.result.evaluated} rules evaluated · ${data.result.state_changes} state changes`,
      });
    },
    onError: (err: Error) =>
      toast({ title: 'Evaluation failed', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <h2 className="text-lg font-semibold text-foreground">Alert rules &amp; events</h2>
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

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-sm">Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {rulesQ.isLoading && (
              <p className="text-muted-foreground text-sm">Loading rules…</p>
            )}
            {(rulesQ.data?.rules || []).map((r) => (
              <RuleRow key={r.id} rule={r} />
            ))}
          </CardContent>
        </Card>

        <WebhookConfigCard />
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Recent alert events</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Webhook</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(eventsQ.data?.events || []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(e.fired_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.rule_slug}</TableCell>
                  <TableCell>{severityBadge(e.severity)}</TableCell>
                  <TableCell className="text-xs">{e.state}</TableCell>
                  <TableCell className="text-xs">
                    {e.metric_value != null ? Number(e.metric_value).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {e.threshold_value != null ? Number(e.threshold_value).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className="text-[10px]">
                      {e.webhook_status || '—'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {!eventsQ.isLoading && (eventsQ.data?.events.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground text-sm">
                    No alert events yet.
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