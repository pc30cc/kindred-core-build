/**
 * Phase 8A — Voice/Video Control Plane admin panel.
 *
 * UX rules:
 *   - Provider selection (primary/secondary), fallback policy.
 *   - RTC + TURN endpoint config (no hardcoded hosts — admin enters them).
 *   - Recording defaults + retention.
 *   - Live readiness for each registered provider.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import {
  fetchCallControlPlane,
  updateCallControlPlane,
  updateRtcEndpoints,
  type CallControlPlane,
  type CallNetworkBundle,
  type CallProviderId,
} from '@/lib/admin-calls-api';
import { Loader2, Phone, Video, Save, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { AgoraExternalProviderPanel } from './AgoraExternalProviderPanel';

/** Self-hosted family — first-class providers, default-eligible. */
const SELF_HOSTED_PROVIDERS: CallProviderId[] = ['livekit', 'jitsi', 'janus'];
/** External / cloud-backed adapters — opt-in only. */
const EXTERNAL_PROVIDERS: CallProviderId[] = ['agora_cloud'];
/** Full select list — self-hosted first, then external, then disabled. */
const PROVIDERS: CallProviderId[] = [
  ...SELF_HOSTED_PROVIDERS,
  ...EXTERNAL_PROVIDERS,
  'disabled',
];

function providerLabel(p: CallProviderId): string {
  if (p === 'agora_cloud') return 'agora_cloud (external)';
  return p;
}

export function CallControlPlanePanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cp, setCp] = useState<CallControlPlane | null>(null);
  const [network, setNetwork] = useState<CallNetworkBundle | null>(null);
  const [readiness, setReadiness] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const r = await fetchCallControlPlane();
      setCp(r.control_plane);
      setNetwork(r.network);
      setReadiness(r.readiness);
    } catch (e: any) {
      toast({ title: 'Failed to load call settings', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveCp(patch: Partial<CallControlPlane>) {
    if (!cp) return;
    setSaving(true);
    try {
      const r = await updateCallControlPlane(patch);
      setCp(r.control_plane);
      setReadiness(r.readiness);
      toast({ title: 'Settings saved' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function saveNet() {
    if (!network) return;
    setSaving(true);
    try {
      await updateRtcEndpoints({
        rtc_url: network.rtc_url || null,
        ws_url: network.ws_url || null,
        recording_url: network.recording_url || null,
        ice_policy: network.ice_policy,
        region: network.region || null,
        turn: network.turn,
      });
      toast({ title: 'Network endpoints saved' });
      await load();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !cp || !network) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Master toggle + provider selection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5" /> Voice / Video calls
              </CardTitle>
              <CardDescription>
                Self-hosted call layer. Provider-driven, no cloud dependency.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="cp-enabled" className="text-sm">Enabled</Label>
              <Switch
                id="cp-enabled"
                checked={cp.enabled}
                onCheckedChange={(v) => saveCp({ enabled: v })}
                disabled={saving}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Primary provider</Label>
              <Select value={cp.primary_provider} onValueChange={(v) => saveCp({ primary_provider: v as CallProviderId })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      <div className="flex items-center gap-2">
                        {providerLabel(p)}
                        {p !== 'disabled' && (
                          readiness[p]
                            ? <CheckCircle2 className="h-3 w-3 text-success" />
                            : <AlertTriangle className="h-3 w-3 text-warning" />
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Secondary (fallback)</Label>
              <Select value={cp.secondary_provider} onValueChange={(v) => saveCp({ secondary_provider: v as CallProviderId })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>{providerLabel(p)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Fallback policy</Label>
              <Select value={cp.fallback_policy} onValueChange={(v) => saveCp({ fallback_policy: v as 'lenient' | 'strict' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lenient">Lenient (try secondary)</SelectItem>
                  <SelectItem value="strict">Strict (primary only)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Max participants</Label>
              <Input
                type="number" min={1} max={100}
                defaultValue={cp.max_participants}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!isNaN(n) && n !== cp.max_participants) saveCp({ max_participants: n });
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            {SELF_HOSTED_PROVIDERS.map(p => (
              <Badge key={p} variant={readiness[p] ? 'default' : 'secondary'} className="gap-1">
                {p}: {readiness[p] ? 'ready' : 'not configured'}
              </Badge>
            ))}
            {EXTERNAL_PROVIDERS.map(p => (
              <Badge key={p} variant="outline" className="gap-1">
                {p} (external): {readiness[p] ? 'ready' : 'not configured'}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* RTC / TURN endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Phone className="h-5 w-5" /> RTC & TURN endpoints</CardTitle>
          <CardDescription>
            All hostnames are admin-managed. The runtime never hardcodes a domain.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>RTC base URL (wss://)</Label>
              <Input
                value={network.rtc_url ?? ''}
                onChange={(e) => setNetwork({ ...network, rtc_url: e.target.value })}
                placeholder="wss://your-livekit.example"
              />
            </div>
            <div>
              <Label>WebSocket URL (optional override)</Label>
              <Input
                value={network.ws_url ?? ''}
                onChange={(e) => setNetwork({ ...network, ws_url: e.target.value })}
                placeholder="defaults to RTC URL"
              />
            </div>
            <div>
              <Label>Recording URL (optional)</Label>
              <Input
                value={network.recording_url ?? ''}
                onChange={(e) => setNetwork({ ...network, recording_url: e.target.value })}
                placeholder="https://egress.example"
              />
            </div>
            <div>
              <Label>ICE policy</Label>
              <Select value={network.ice_policy} onValueChange={(v) => setNetwork({ ...network, ice_policy: v as 'all' | 'relay' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="relay">Relay only (force TURN)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>TURN URLs (one per line)</Label>
            <textarea
              className="w-full min-h-[80px] rounded-md border bg-background p-2 text-sm"
              value={network.turn.urls.join('\n')}
              onChange={(e) => setNetwork({
                ...network,
                turn: { ...network.turn, urls: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) },
              })}
              placeholder={'turn:turn.example:3478\nturns:turn.example:5349?transport=tcp'}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>TURN username</Label>
                <Input
                  value={network.turn.username ?? ''}
                  onChange={(e) => setNetwork({ ...network, turn: { ...network.turn, username: e.target.value } })}
                />
              </div>
              <div>
                <Label>TURN credential</Label>
                <Input
                  type="password"
                  value={network.turn.credential ?? ''}
                  onChange={(e) => setNetwork({ ...network, turn: { ...network.turn, credential: e.target.value } })}
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={saveNet} disabled={saving}>
              <Save className="h-4 w-4 mr-2" /> Save endpoints
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recording / retention */}
      <Card>
        <CardHeader>
          <CardTitle>Recording & retention</CardTitle>
          <CardDescription>Workspace overrides can disable recording per workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Recording enabled by default</Label>
              <p className="text-xs text-muted-foreground">Applied when a call is created without an explicit choice.</p>
            </div>
            <Switch
              checked={cp.recording_default_enabled}
              onCheckedChange={(v) => saveCp({ recording_default_enabled: v })}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Recording type</Label>
              <Select
                value={cp.recording_default_type}
                onValueChange={(v) => saveCp({ recording_default_type: v as 'composite' | 'individual' | 'audio_only' })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="composite">Composite</SelectItem>
                  <SelectItem value="individual">Individual tracks</SelectItem>
                  <SelectItem value="audio_only">Audio only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Retention (days)</Label>
              <Input
                type="number" min={0} max={3650}
                defaultValue={cp.retention_default_days}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!isNaN(n) && n !== cp.retention_default_days) saveCp({ retention_default_days: n });
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Require visitor verification before calls</Label>
              <p className="text-xs text-muted-foreground">Visitors must complete contact verification before joining a call.</p>
            </div>
            <Switch
              checked={cp.verification_required_for_visitor_calls}
              onCheckedChange={(v) => saveCp({ verification_required_for_visitor_calls: v })}
              disabled={saving}
            />
          </div>
        </CardContent>
      </Card>

      {/*
        External / cloud-backed adapters live in their own section so they
        are visually separated from the self-hosted family. Disabled by
        default; never auto-selected by the resolver.
      */}
      <AgoraExternalProviderPanel />
    </div>
  );
}