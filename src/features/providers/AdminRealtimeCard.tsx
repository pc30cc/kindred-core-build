/**
 * Super Admin — Realtime Provider Card
 * Phase 3: global-only configuration of the realtime provider (Centrifugo / Polling / Disabled).
 *
 * Drop-in replacement for AdminProviderCard when type === 'realtime'.
 * No workspace-level overrides in this phase.
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import {
  Radio, Settings, TestTube, RefreshCw, ShieldAlert, History, CheckCircle, AlertTriangle, XCircle, Zap,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { realtimeAdminApi, type RealtimeAdminConfig } from '@/lib/realtime-admin-api';
import { RealtimeTopologyTab } from './RealtimeTopologyTab';

const SECRET_PLACEHOLDER = '••••••••';

function hasMaskedSecret(value?: string) {
  return typeof value === 'string' && value.includes('•');
}

function toSecretInputValue(value?: string) {
  return value ? SECRET_PLACEHOLDER : '';
}

export function AdminRealtimeCard() {
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message?: string } | null>(null);

  const { data: config, isLoading } = useQuery({
    queryKey: ['admin-realtime-config'],
    queryFn: realtimeAdminApi.getConfig,
  });

  const isActive = !!config && config.enabled && config.vendor !== 'disabled';
  const isCentrifugo = config?.vendor === 'centrifugo';

  const handleTest = async () => {
    setTesting(true);
    try {
      const r = await realtimeAdminApi.testConnection();
      setTestResult({ status: r.status, message: r.message });
      toast({
        title: r.status === 'healthy' ? '✓ Connection OK' : '⚠ Connection Issue',
        description: r.message || `Status: ${r.status}`,
        variant: r.status === 'healthy' ? 'default' : 'destructive',
      });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-6 text-center text-muted-foreground text-xs">Loading realtime config…</CardContent>
      </Card>
    );
  }

  const statusBorder = isActive ? 'border-emerald-500/30' : 'border-amber-500/30';

  return (
    <>
      <Card className={`bg-card ${statusBorder} hover:border-admin-accent/50 transition-colors`}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${isActive ? 'bg-emerald-500/10' : 'bg-muted'}`}>
                <Radio className={`h-5 w-5 ${isActive ? 'text-emerald-400' : 'text-muted-foreground'}`} />
              </div>
              <div>
                <CardTitle className="text-sm text-foreground flex items-center gap-2">
                  Realtime
                  <Badge className={
                    isCentrifugo
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] h-4'
                      : 'bg-muted text-muted-foreground border-border text-[9px] h-4'
                  }>
                    {isCentrifugo ? 'Centrifugo' : config?.vendor === 'disabled' ? 'Disabled' : 'Polling'}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] h-4 border-border text-muted-foreground">Global</Badge>
                </CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                  WebSocket channels, presence, and live updates
                </p>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between p-2 rounded-md border border-border bg-muted/20">
            <div className="flex items-center gap-2">
              <Zap className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">Vendor:</span>
              <span className="text-xs font-medium text-foreground">{config?.vendor}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>Fallback:</span>
              <Badge variant="outline" className="text-[9px] h-4 border-border text-foreground">
                {config?.fallback_policy ?? 'lenient'}
              </Badge>
            </div>
          </div>

          {isCentrifugo && (
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <div className="truncate"><span className="text-foreground">WS:</span> {config?.centrifugo?.ws_url || '—'}</div>
              <div className="truncate"><span className="text-foreground">API:</span> {config?.centrifugo?.api_url || '—'}</div>
              <div className="flex gap-3">
                <span>typing: {config?.centrifugo?.typing_enabled ? 'on' : 'off'}</span>
                <span>presence: {config?.centrifugo?.presence_enabled ? 'on' : 'off'}</span>
                <span>TTL: {config?.centrifugo?.token_ttl_seconds ?? 900}s</span>
              </div>
            </div>
          )}

          {testResult && (
            <div className={`flex items-center gap-1.5 text-[11px] ${
              testResult.status === 'healthy' ? 'text-emerald-400' :
              testResult.status === 'degraded' ? 'text-amber-400' : 'text-red-400'
            }`}>
              {testResult.status === 'healthy' ? <CheckCircle className="h-3 w-3" /> :
               testResult.status === 'degraded' ? <AlertTriangle className="h-3 w-3" /> :
               <XCircle className="h-3 w-3" />}
              <span>{testResult.message || testResult.status}</span>
            </div>
          )}

          <div className="flex items-center gap-1 pt-1">
            <Button variant="outline" size="sm"
              className="h-7 text-xs flex-1 border-border text-foreground hover:bg-muted"
              onClick={() => setConfigOpen(true)}>
              <Settings className="h-3 w-3 me-1" />
              Configure
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={handleTest} disabled={testing || !isCentrifugo}>
              {testing ? <RefreshCw className="h-3 w-3 animate-spin" /> : <><TestTube className="h-3 w-3 me-1" />Test</>}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={() => setAuditOpen(true)}>
              <History className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <RealtimeConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        config={config}
        onSaved={() => qc.invalidateQueries({ queryKey: ['admin-realtime-config'] })}
      />

      <RealtimeAuditDialog open={auditOpen} onOpenChange={setAuditOpen} />
    </>
  );
}

// ─── Config dialog ──────────────────────────────────────────────────
function RealtimeConfigDialog({
  open, onOpenChange, config, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  config?: RealtimeAdminConfig;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [vendor, setVendor] = useState<'centrifugo' | 'polling_builtin' | 'disabled'>('polling_builtin');
  const [enabled, setEnabled] = useState(true);
  const [fallbackPolicy, setFallbackPolicy] = useState<'lenient' | 'strict'>('lenient');
  const [centrifugo, setCentrifugo] = useState<NonNullable<RealtimeAdminConfig['centrifugo']>>({});

  useEffect(() => {
    if (!open || !config) return;
    setVendor(config.vendor);
    setEnabled(config.enabled);
    setFallbackPolicy(config.fallback_policy);
    setCentrifugo({
      ...(config.centrifugo ?? {}),
      api_key: toSecretInputValue(config.centrifugo?.api_key),
      token_hmac_secret: toSecretInputValue(config.centrifugo?.token_hmac_secret),
    });
  }, [open, config]);

  const save = useMutation({
    mutationFn: async () => {
      const payload: Partial<RealtimeAdminConfig> = {
        vendor, enabled, fallback_policy: fallbackPolicy,
      };
      if (vendor === 'centrifugo') {
        // Strip masked secrets — empty string means "do not change".
        const c: typeof centrifugo = { ...centrifugo };
        if (!c.api_key || hasMaskedSecret(c.api_key)) delete c.api_key;
        if (!c.token_hmac_secret || hasMaskedSecret(c.token_hmac_secret)) delete c.token_hmac_secret;
        payload.centrifugo = c;
      }
      return realtimeAdminApi.saveConfig(payload);
    },
    onSuccess: () => {
      toast({ title: 'Realtime saved', description: 'Configuration updated globally.' });
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const updateC = (k: keyof NonNullable<RealtimeAdminConfig['centrifugo']>, v: unknown) =>
    setCentrifugo((prev) => ({ ...prev, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="admin-scope max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Radio className="h-5 w-5 text-admin-accent" />
            Configure Realtime Provider <Badge variant="outline" className="ms-2 border-border text-muted-foreground text-[9px]">Global</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400 mt-0.5" />
          <div className="text-[11px] text-muted-foreground">
            This is a <strong>global</strong> setting and applies to every workspace. Workspace-level overrides are not available in this phase.
            Secrets are stored server-side and never returned to the browser.
          </div>
        </div>

        <Tabs defaultValue="vendor" className="space-y-3">
          <TabsList className="bg-muted">
            <TabsTrigger value="vendor">Vendor</TabsTrigger>
            <TabsTrigger value="centrifugo" disabled={vendor !== 'centrifugo'}>Centrifugo</TabsTrigger>
            <TabsTrigger value="topology" disabled={vendor !== 'centrifugo'}>
              {t('admin.realtimeTopology.tab')}
            </TabsTrigger>
            <TabsTrigger value="policy">Fallback Policy</TabsTrigger>
          </TabsList>

          <TabsContent value="topology" className="space-y-3">
            <RealtimeTopologyTab
              mode={centrifugo.deployment_mode ?? 'single_memory'}
              loadBalancerUrl={centrifugo.load_balancer_ws_url ?? ''}
              onModeChange={(m) => updateC('deployment_mode', m)}
              onLoadBalancerUrlChange={(v) => updateC('load_balancer_ws_url', v)}
            />
          </TabsContent>


          <TabsContent value="vendor" className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-foreground">Realtime Vendor</Label>
              <Select value={vendor} onValueChange={(v) => setVendor(v as typeof vendor)}>
                <SelectTrigger className="bg-input border-border text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="centrifugo">Centrifugo (Self-Hosted) — real WebSocket realtime</SelectItem>
                  <SelectItem value="polling_builtin">Built-in Polling — REST fallback</SelectItem>
                  <SelectItem value="disabled">Disabled — no realtime path</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-2 rounded-md border border-border">
              <div>
                <Label className="text-foreground">Enabled</Label>
                <p className="text-[11px] text-muted-foreground">Master switch for the realtime layer.</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </TabsContent>

          <TabsContent value="centrifugo" className="space-y-3">
            <FieldRow label="Public WebSocket URL" hint="URL given to browser clients">
              <Input value={centrifugo.ws_url ?? ''} onChange={(e) => updateC('ws_url', e.target.value)}
                placeholder="wss://rt.yourdomain.com/connection/websocket" className="bg-input border-border text-foreground" />
            </FieldRow>
            <FieldRow label="Server-to-Server API URL" hint="Internal HTTP API for backend → Centrifugo">
              <Input value={centrifugo.api_url ?? ''} onChange={(e) => updateC('api_url', e.target.value)}
                placeholder="http://centrifugo:8000/api" className="bg-input border-border text-foreground" />
            </FieldRow>
            <FieldRow label="Admin API Key" hint="Stored server-side. Leave blank to keep current.">
              <Input type="password" value={centrifugo.api_key ?? ''} onChange={(e) => updateC('api_key', e.target.value)}
                placeholder={config?.centrifugo?.api_key ? SECRET_PLACEHOLDER : 'enter API key'}
                className="bg-input border-border text-foreground" />
            </FieldRow>
            <FieldRow label="Token HMAC Secret (HS256)" hint="Must match Centrifugo CENTRIFUGO_TOKEN_HMAC_SECRET_KEY.">
              <Input type="password" value={centrifugo.token_hmac_secret ?? ''} onChange={(e) => updateC('token_hmac_secret', e.target.value)}
                placeholder={config?.centrifugo?.token_hmac_secret ? SECRET_PLACEHOLDER : 'enter HMAC secret'}
                className="bg-input border-border text-foreground" />
            </FieldRow>
            <FieldRow label="Allowed Origins (CSV)">
              <Input value={(centrifugo.allowed_origins ?? []).join(',')}
                onChange={(e) => updateC('allowed_origins', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                placeholder="https://app.yourdomain.com,https://*.yourdomain.com"
                className="bg-input border-border text-foreground" />
            </FieldRow>
            <div className="grid grid-cols-3 gap-2">
              <FieldRow label="Connect TO (ms)">
                <Input type="number" value={centrifugo.connect_timeout_ms ?? 8000}
                  onChange={(e) => updateC('connect_timeout_ms', Number(e.target.value))}
                  className="bg-input border-border text-foreground" />
              </FieldRow>
              <FieldRow label="Subscribe TO (ms)">
                <Input type="number" value={centrifugo.subscribe_timeout_ms ?? 5000}
                  onChange={(e) => updateC('subscribe_timeout_ms', Number(e.target.value))}
                  className="bg-input border-border text-foreground" />
              </FieldRow>
              <FieldRow label="Token TTL (s)">
                <Input type="number" value={centrifugo.token_ttl_seconds ?? 900}
                  onChange={(e) => updateC('token_ttl_seconds', Number(e.target.value))}
                  className="bg-input border-border text-foreground" />
              </FieldRow>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch checked={!!centrifugo.presence_enabled} onCheckedChange={(v) => updateC('presence_enabled', v)} />
                Presence
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch checked={!!centrifugo.typing_enabled} onCheckedChange={(v) => updateC('typing_enabled', v)} />
                Typing indicators
              </label>
            </div>
          </TabsContent>

          <TabsContent value="policy" className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-foreground">Fallback Policy</Label>
              <Select value={fallbackPolicy} onValueChange={(v) => setFallbackPolicy(v as 'lenient' | 'strict')}>
                <SelectTrigger className="bg-input border-border text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lenient">Lenient — fall back to polling if realtime fails (recommended)</SelectItem>
                  <SelectItem value="strict">Strict — fail closed, disable realtime path on failure</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Default is <strong>lenient</strong>. Strict mode is for environments that require full realtime or nothing.
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" className="border-border text-foreground hover:bg-muted" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <><RefreshCw className="h-3 w-3 me-1 animate-spin" />Saving…</> : 'Save Configuration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-foreground text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ─── Audit dialog ───────────────────────────────────────────────────
function RealtimeAuditDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['admin-realtime-audit'],
    queryFn: realtimeAdminApi.audit,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="admin-scope max-w-xl max-h-[80vh] overflow-y-auto bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="h-4 w-4" /> Realtime Provider Audit</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="text-xs text-muted-foreground py-4 text-center">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-xs text-muted-foreground py-4 text-center">No audit entries yet.</div>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="p-2 rounded-md border border-border text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px] h-4 border-border text-foreground">{e.action}</Badge>
                    {e.prev_vendor && e.vendor && e.prev_vendor !== e.vendor && (
                      <span className="text-muted-foreground">
                        <span className="text-red-400 line-through">{e.prev_vendor}</span> →{' '}
                        <span className="text-foreground">{e.vendor}</span>
                      </span>
                    )}
                    {e.result && (
                      <Badge className={
                        e.result === 'success'
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] h-4'
                          : 'bg-red-500/15 text-red-400 border-red-500/30 text-[9px] h-4'
                      }>{e.result}</Badge>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                {e.error_message && <div className="text-red-400 text-[10px]">{e.error_message}</div>}
                {e.config_diff && Object.keys(e.config_diff).length > 0 && (
                  <pre className="text-[10px] text-muted-foreground overflow-x-auto bg-muted/20 p-1 rounded">
                    {JSON.stringify(e.config_diff, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
