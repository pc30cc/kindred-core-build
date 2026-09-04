/**
 * Super Admin — Realtime → Deployment Architecture.
 *
 * Lives inside the existing Centrifugo configuration dialog. It never
 * shows or accepts cluster secrets: the API key and HMAC secret stay in
 * the Centrifugo tab (server-side, masked), and a node record carries
 * public URLs only.
 *
 *   single_memory        → nothing extra to configure (Mode 1 fields only)
 *   app_routed_redis     → node registry table + add/drain/test
 *   load_balanced_redis  → one public load balancer URL (+ node health)
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle, AlertTriangle, XCircle, PauseCircle, PlayCircle, RefreshCw, Plus, Trash2, TestTube,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import {
  realtimeAdminApi,
  type CentrifugoDeploymentMode,
  type CentrifugoNodeRow,
} from '@/lib/realtime-admin-api';

const MODES: CentrifugoDeploymentMode[] = ['single_memory', 'app_routed_redis', 'load_balanced_redis'];

function StatusIcon({ status }: { status: CentrifugoNodeRow['effective_status'] }) {
  if (status === 'healthy') return <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'degraded') return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  if (status === 'down') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'draining' || status === 'maintenance') return <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function RealtimeTopologyTab({
  mode,
  loadBalancerUrl,
  onModeChange,
  onLoadBalancerUrlChange,
}: {
  mode: CentrifugoDeploymentMode;
  loadBalancerUrl: string;
  onModeChange: (m: CentrifugoDeploymentMode) => void;
  onLoadBalancerUrlChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', ws_url: '', api_url: '', weight: 100 });

  const showNodes = mode !== 'single_memory';

  const { data, isLoading } = useQuery({
    queryKey: ['admin-realtime-nodes'],
    queryFn: () => realtimeAdminApi.listNodes(),
    enabled: showNodes,
    refetchInterval: showNodes ? 15000 : false,
  });

  const nodes = data?.nodes ?? [];
  const reload = () => qc.invalidateQueries({ queryKey: ['admin-realtime-nodes'] });

  const run = async (key: string, fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (successMsg) toast({ title: successMsg });
      reload();
    } catch (err) {
      toast({ title: t('admin.realtimeTopology.actionFailed'), description: (err as Error).message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-foreground">{t('admin.realtimeTopology.mode')}</Label>
        <Select value={mode} onValueChange={(v) => onModeChange(v as CentrifugoDeploymentMode)}>
          <SelectTrigger className="bg-input border-border text-foreground"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m} value={m}>{t(`admin.realtimeTopology.modes.${m}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t(`admin.realtimeTopology.modeHints.${mode}`)}</p>
      </div>

      {mode === 'load_balanced_redis' && (
        <div className="space-y-1.5">
          <Label className="text-foreground">{t('admin.realtimeTopology.lbUrl')}</Label>
          <Input
            value={loadBalancerUrl}
            onChange={(e) => onLoadBalancerUrlChange(e.target.value)}
            placeholder="wss://rt.yourdomain.com/connection/websocket"
            className="bg-input border-border text-foreground"
          />
          <p className="text-[11px] text-muted-foreground">{t('admin.realtimeTopology.lbUrlHint')}</p>
        </div>
      )}

      {showNodes && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-foreground">{t('admin.realtimeTopology.nodes')}</Label>
            <Button
              variant="outline" size="sm" className="h-7 text-xs"
              disabled={busy === 'test-all' || !nodes.length}
              onClick={() => run('test-all', () => realtimeAdminApi.testAllNodes(), t('admin.realtimeTopology.tested'))}
            >
              {busy === 'test-all'
                ? <RefreshCw className="h-3 w-3 animate-spin" />
                : <><TestTube className="h-3 w-3 me-1" />{t('admin.realtimeTopology.testAll')}</>}
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : nodes.length === 0 ? (
            <p className="text-[11px] text-muted-foreground rounded-md border border-border p-3">
              {t('admin.realtimeTopology.noNodes')}
            </p>
          ) : (
            <div className="space-y-2">
              {nodes.map((n) => (
                <div key={n.id} className="rounded-md border border-border p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusIcon status={n.effective_status} />
                      <span className="text-xs font-medium text-foreground truncate">{n.name}</span>
                      <Badge variant="outline" className="text-[9px] h-4 border-border text-muted-foreground">{n.id}</Badge>
                      {n.draining && (
                        <Badge className="text-[9px] h-4 bg-amber-500/15 text-amber-500 border-amber-500/30">
                          {t('admin.realtimeTopology.draining')}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="sm" className="h-6 px-2 text-[11px]"
                        disabled={busy === `test-${n.id}`}
                        onClick={() => run(`test-${n.id}`, () => realtimeAdminApi.testNode(n.id))}
                      >
                        <TestTube className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-6 px-2 text-[11px]"
                        disabled={busy === `drain-${n.id}`}
                        onClick={() => run(
                          `drain-${n.id}`,
                          () => realtimeAdminApi.setNodeDraining(n.id, !n.draining),
                          n.draining ? t('admin.realtimeTopology.resumed') : t('admin.realtimeTopology.drained'),
                        )}
                      >
                        {n.draining
                          ? <><PlayCircle className="h-3 w-3 me-1" />{t('admin.realtimeTopology.resume')}</>
                          : <><PauseCircle className="h-3 w-3 me-1" />{t('admin.realtimeTopology.drain')}</>}
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-6 px-2 text-destructive"
                        disabled={busy === `del-${n.id}`}
                        onClick={() => run(`del-${n.id}`, () => realtimeAdminApi.removeNode(n.id))}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="text-[10px] text-muted-foreground space-y-0.5">
                    <div className="truncate">WS: {n.ws_url}</div>
                    <div className="truncate">API: {n.api_url}</div>
                    <div className="flex flex-wrap gap-3">
                      <span>{t('admin.realtimeTopology.connections')}: {n.health?.connections ?? '—'}</span>
                      <span>{t('admin.realtimeTopology.weight')}: {n.weight}</span>
                      <span>
                        {t('admin.realtimeTopology.lastCheck')}:{' '}
                        {n.health?.checked_at ? new Date(n.health.checked_at).toLocaleTimeString() : '—'}
                      </span>
                      {n.health?.message && <span className="truncate">{n.health.message}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pt-1">
                    <label className="flex items-center gap-2 text-[11px] text-foreground">
                      <Switch
                        checked={n.enabled}
                        onCheckedChange={(v) => run(`en-${n.id}`, () => realtimeAdminApi.updateNode(n.id, { enabled: v }))}
                      />
                      {t('admin.realtimeTopology.enabled')}
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-foreground">
                      <Switch
                        checked={n.accepting_new_connections}
                        onCheckedChange={(v) => run(`ac-${n.id}`, () => realtimeAdminApi.updateNode(n.id, { accepting_new_connections: v }))}
                      />
                      {t('admin.realtimeTopology.accepting')}
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add node */}
          <div className="rounded-md border border-dashed border-border p-2 space-y-2">
            <Label className="text-[11px] text-foreground">{t('admin.realtimeTopology.addNode')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('admin.realtimeTopology.nodeName')} className="bg-input border-border text-foreground h-8 text-xs"
              />
              <Input
                type="number" value={draft.weight}
                onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })}
                placeholder={t('admin.realtimeTopology.weight')} className="bg-input border-border text-foreground h-8 text-xs"
              />
              <Input
                value={draft.ws_url} onChange={(e) => setDraft({ ...draft, ws_url: e.target.value })}
                placeholder="wss://rt1.yourdomain.com/connection/websocket"
                className="bg-input border-border text-foreground h-8 text-xs col-span-2"
              />
              <Input
                value={draft.api_url} onChange={(e) => setDraft({ ...draft, api_url: e.target.value })}
                placeholder="http://rt-node-01:8000/api"
                className="bg-input border-border text-foreground h-8 text-xs col-span-2"
              />
            </div>
            <Button
              size="sm" className="h-7 text-xs"
              disabled={busy === 'add' || !draft.ws_url || !draft.api_url}
              onClick={() => run('add', async () => {
                await realtimeAdminApi.addNode({
                  name: draft.name || undefined,
                  ws_url: draft.ws_url,
                  api_url: draft.api_url,
                  weight: draft.weight,
                });
                setDraft({ name: '', ws_url: '', api_url: '', weight: 100 });
              }, t('admin.realtimeTopology.nodeAdded'))}
            >
              <Plus className="h-3 w-3 me-1" />{t('admin.realtimeTopology.addNode')}
            </Button>
          </div>

          <p className="text-[10px] text-muted-foreground">{t('admin.realtimeTopology.drainHint')}</p>
        </div>
      )}
    </div>
  );
}
