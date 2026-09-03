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
import { RolePermissionsPanel } from './RolePermissionsPanel';
import { useTranslation } from '@/i18n';

/** Self-hosted family — first-class providers, default-eligible. */
const SELF_HOSTED_PROVIDERS: CallProviderId[] = ['livekit', 'jitsi', 'janus'];
/** External / cloud-backed adapters — opt-in only. */
const EXTERNAL_PROVIDERS: CallProviderId[] = ['agora_cloud'];
/** Full select list — self-hosted first, then external, then disabled. */
const PROVIDERS: CallProviderId[] = [...SELF_HOSTED_PROVIDERS, ...EXTERNAL_PROVIDERS, 'disabled'];

function providerLabel(p: CallProviderId): string {
  return p;
}

export function CallControlPlanePanel() {
  const { t } = useTranslation();
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
      setReadiness(r.readiness ?? {});
    } catch (e: any) {
      toast({ title: t('admin.voiceVideo.control.loadFailed' as any), description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveCp(patch: Partial<CallControlPlane>) {
    if (!cp) return;
    setSaving(true);
    try {
      const r = await updateCallControlPlane(patch);
      setCp(r.control_plane);
      setReadiness(r.readiness ?? {});
      toast({ title: t('admin.voiceVideo.control.saved' as any) });
    } catch (e: any) {
      toast({ title: t('admin.voiceVideo.control.saveFailed' as any), description: e.message, variant: 'destructive' });
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
      toast({ title: t('admin.voiceVideo.control.networkSaved' as any) });
      await load();
    } catch (e: any) {
      toast({ title: t('admin.voiceVideo.control.saveFailed' as any), description: e.message, variant: 'destructive' });
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
                <Video className="h-5 w-5" /> {t('admin.voiceVideo.control.title' as any)}
              </CardTitle>
              <CardDescription>{t('admin.voiceVideo.control.description' as any)}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="cp-enabled" className="text-sm">
                {t('admin.voiceVideo.enabled' as any)}
              </Label>
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
              <Label>{t('admin.voiceVideo.control.primaryProvider' as any)}</Label>
              <Select
                value={cp.primary_provider}
                onValueChange={(v) => saveCp({ primary_provider: v as CallProviderId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      <div className="flex items-center gap-2">
                        {providerLabel(p)}
                        {p !== 'disabled' &&
                          (readiness[p] ? (
                            <CheckCircle2 className="h-3 w-3 text-success" />
                          ) : (
                            <AlertTriangle className="h-3 w-3 text-warning" />
                          ))}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.secondaryProvider' as any)}</Label>
              <Select
                value={cp.secondary_provider}
                onValueChange={(v) => saveCp({ secondary_provider: v as CallProviderId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {providerLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.fallbackPolicy' as any)}</Label>
              <Select
                value={cp.fallback_policy}
                onValueChange={(v) => saveCp({ fallback_policy: v as 'lenient' | 'strict' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lenient">{t('admin.voiceVideo.control.lenient' as any)}</SelectItem>
                  <SelectItem value="strict">{t('admin.voiceVideo.control.strict' as any)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.maxParticipants' as any)}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                defaultValue={cp.max_participants}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!isNaN(n) && n !== cp.max_participants) saveCp({ max_participants: n });
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            {SELF_HOSTED_PROVIDERS.map((p) => (
              <Badge key={p} variant={readiness[p] ? 'default' : 'secondary'} className="gap-1">
                {p}:{' '}
                {readiness[p]
                  ? t('admin.voiceVideo.control.ready' as any)
                  : t('admin.voiceVideo.control.notConfigured' as any)}
              </Badge>
            ))}
            {EXTERNAL_PROVIDERS.map((p) => (
              <Badge key={p} variant="outline" className="gap-1">
                {p} ({t('admin.voiceVideo.control.external' as any)}):{' '}
                {readiness[p]
                  ? t('admin.voiceVideo.control.ready' as any)
                  : t('admin.voiceVideo.control.notConfigured' as any)}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* RTC / TURN endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" /> {t('admin.voiceVideo.control.endpoints' as any)}
          </CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.endpointsHint' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('admin.voiceVideo.control.rtcBaseUrl' as any)}</Label>
              <Input
                value={network.rtc_url ?? ''}
                onChange={(e) => setNetwork({ ...network, rtc_url: e.target.value })}
                placeholder="wss://your-livekit.example"
              />
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.websocketUrl' as any)}</Label>
              <Input
                value={network.ws_url ?? ''}
                onChange={(e) => setNetwork({ ...network, ws_url: e.target.value })}
                placeholder={t('admin.voiceVideo.control.defaultsRtc' as any)}
              />
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.recordingUrl' as any)}</Label>
              <Input
                value={network.recording_url ?? ''}
                onChange={(e) => setNetwork({ ...network, recording_url: e.target.value })}
                placeholder="https://egress.example"
              />
            </div>
            <div>
              <Label>{t('admin.voiceVideo.overview.icePolicy' as any)}</Label>
              <Select
                value={network.ice_policy}
                onValueChange={(v) => setNetwork({ ...network, ice_policy: v as 'all' | 'relay' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('admin.voiceVideo.control.all' as any)}</SelectItem>
                  <SelectItem value="relay">{t('admin.voiceVideo.control.relayOnly' as any)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>{t('admin.voiceVideo.control.turnUrls' as any)}</Label>
            <textarea
              className="w-full min-h-[80px] rounded-md border bg-background p-2 text-sm"
              value={(network.turn?.urls ?? []).join('\n')}
              onChange={(e) =>
                setNetwork({
                  ...network,
                  turn: {
                    ...(network.turn ?? {
                      urls: [],
                      username: null,
                      credential: null,
                      credential_type: 'password',
                      static_secret_present: false,
                    }),
                    urls: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                })
              }
              placeholder={'turn:turn.example:3478\nturns:turn.example:5349?transport=tcp'}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>{t('admin.voiceVideo.control.turnUsername' as any)}</Label>
                <Input
                  value={network.turn?.username ?? ''}
                  onChange={(e) =>
                    setNetwork({
                      ...network,
                      turn: {
                        ...(network.turn ?? {
                          urls: [],
                          username: null,
                          credential: null,
                          credential_type: 'password',
                          static_secret_present: false,
                        }),
                        username: e.target.value,
                      },
                    })
                  }
                />
              </div>
              <div>
                <Label>{t('admin.voiceVideo.control.turnCredential' as any)}</Label>
                <Input
                  type="password"
                  value={network.turn?.credential ?? ''}
                  onChange={(e) =>
                    setNetwork({
                      ...network,
                      turn: {
                        ...(network.turn ?? {
                          urls: [],
                          username: null,
                          credential: null,
                          credential_type: 'password',
                          static_secret_present: false,
                        }),
                        credential: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={saveNet} disabled={saving}>
              <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.control.saveEndpoints' as any)}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recording / retention */}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.voiceVideo.control.recordingTitle' as any)}</CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.recordingDescription' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('admin.voiceVideo.control.recordingDefault' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.voiceVideo.control.recordingDefaultHint' as any)}
              </p>
            </div>
            <Switch
              checked={cp.recording_default_enabled}
              onCheckedChange={(v) => saveCp({ recording_default_enabled: v })}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('admin.voiceVideo.control.recordingType' as any)}</Label>
              <Select
                value={cp.recording_default_type}
                onValueChange={(v) =>
                  saveCp({ recording_default_type: v as 'composite' | 'individual' | 'audio_only' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="composite">{t('admin.voiceVideo.control.composite' as any)}</SelectItem>
                  <SelectItem value="individual">{t('admin.voiceVideo.control.individual' as any)}</SelectItem>
                  <SelectItem value="audio_only">{t('admin.voiceVideo.control.audioOnly' as any)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.retentionDays' as any)}</Label>
              <Input
                type="number"
                min={0}
                max={3650}
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
              <Label>{t('admin.voiceVideo.control.requireVerification' as any)}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.voiceVideo.control.requireVerificationHint' as any)}
              </p>
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

      {/* Phase 8C — Global channel gates (hard upper bounds). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" /> {t('admin.voiceVideo.control.channelGates' as any)}
          </CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.channelGatesHint' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {(
            [
              [
                'voice_calls_enabled_global',
                t('admin.voiceVideo.control.voiceCalls' as any),
                t('admin.voiceVideo.control.voiceCallsHint' as any),
              ],
              [
                'video_calls_enabled_global',
                t('admin.voiceVideo.control.videoCalls' as any),
                t('admin.voiceVideo.control.videoCallsHint' as any),
              ],
              [
                'call_queue_enabled_global',
                t('admin.voiceVideo.control.callQueue' as any),
                t('admin.voiceVideo.control.callQueueHint' as any),
              ],
              [
                'call_recording_enabled_global',
                t('admin.voiceVideo.control.recording' as any),
                t('admin.voiceVideo.control.recordingHint' as any),
              ],
              [
                'visitor_initiated_audio_enabled_global',
                t('admin.voiceVideo.control.visitorAudio' as any),
                t('admin.voiceVideo.control.visitorAudioHint' as any),
              ],
              [
                'visitor_initiated_video_enabled_global',
                t('admin.voiceVideo.control.visitorVideo' as any),
                t('admin.voiceVideo.control.visitorVideoHint' as any),
              ],
            ] as Array<[keyof typeof cp, string, string]>
          ).map(([key, label, hint]) => (
            <div key={key as string} className="flex items-start justify-between gap-3 py-2">
              <div className="flex-1 min-w-0">
                <Label className="text-sm">{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch checked={!!cp[key]} disabled={saving} onCheckedChange={(v) => saveCp({ [key]: v } as any)} />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Phase 8C — Platform-default role permissions. */}
      <RolePermissionsPanel />
    </div>
  );
}
