/**
 * Phase 8A — Voice/Video Control Plane admin panel.
 *
 * UX rules:
 *   - Provider selection (primary/secondary), fallback policy.
 *   - RTC + TURN endpoint config (no hardcoded hosts — admin enters them).
 *     The TURN shared secret is write-only (the page sees only whether one
 *     is stored and its fingerprint), and the relay countries decide who is
 *     handed the TURN URLs: everyone else keeps LiveKit's own relay.
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
  type RtcEndpointsPatch,
  type RtcTurnPatch,
} from '@/lib/admin-calls-api';
import { Loader2, Phone, Video, Save, AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { AgoraExternalProviderPanel } from './AgoraExternalProviderPanel';
import { RolePermissionsPanel } from './RolePermissionsPanel';
import { useTranslation, type TranslationKey } from '@/i18n';

/** Self-hosted family — first-class providers, default-eligible. */
const SELF_HOSTED_PROVIDERS: CallProviderId[] = ['livekit', 'jitsi', 'janus'];
/** External / cloud-backed adapters — opt-in only. */
const EXTERNAL_PROVIDERS: CallProviderId[] = ['agora_cloud'];
/** Full select list — self-hosted first, then external, then disabled. */
const PROVIDERS: CallProviderId[] = [...SELF_HOSTED_PROVIDERS, ...EXTERNAL_PROVIDERS, 'disabled'];

function providerLabel(p: CallProviderId): string {
  return p;
}

/**
 * The relay credentials' lifetime as the server applies it
 * (server/services/calls/rtcResolver.ts): 6 h when the row has none,
 * 10 min to 24 h otherwise. Mirrored here so the form refuses a value the
 * server would refuse before sending it.
 */
const TURN_TTL_DEFAULT_SECONDS = 6 * 3600;
const TURN_TTL_MIN_SECONDS = 600;
const TURN_TTL_MAX_SECONDS = 24 * 3600;
const MAX_RELAY_COUNTRIES = 60;
/** A country code, not copy: the same in every language. */
const RELAY_COUNTRIES_PLACEHOLDER = 'IR';

/**
 * Splits a typed list on new lines, spaces, commas and semicolons. The
 * Persian comma counts too: the owner types on a Persian keyboard, and «IR، TR»
 * must not read as one code "IR،".
 */
function splitList(text: string): string[] {
  return text
    .split(/[\s,،;؛]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(list: string[]): string[] {
  return list.filter((item, i) => list.indexOf(item) === i);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Codes as the server keeps them (upper case, each once) and what is not a code. */
function parseRelayCountries(text: string): { codes: string[]; invalid: string[] } {
  const items = unique(splitList(text).map((s) => s.toUpperCase()));
  return {
    codes: items.filter((s) => /^[A-Z]{2}$/.test(s) || s === '*'),
    invalid: items.filter((s) => !/^[A-Z]{2}$/.test(s) && s !== '*'),
  };
}

/** Hours as the field shows them: 21600 → "6", 1800 → "0.5". */
function hoursText(seconds: number): string {
  return String(Math.round(seconds / 36) / 100);
}

/**
 * Persian and Arabic digits to ASCII, so «۶» typed on a Persian keyboard
 * reads as 6, and a decimal comma (Persian «٫», Turkish ",") as a point.
 */
function asciiDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[٫,]/g, '.');
}

/** What a toast shows for a failure: the server's own text when there is one. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a shared secret is stored. Older backends send only static_secret_present. */
function secretStored(turn: CallNetworkBundle['turn'] | undefined): boolean {
  return !!(turn?.shared_secret_present ?? turn?.static_secret_present);
}

/** The network form as typed: lists stay raw text until Save, so Enter and commas just work. */
interface NetworkForm {
  rtc_url: string;
  ws_url: string;
  recording_url: string;
  ice_policy: 'all' | 'relay';
  turnUrls: string;
  username: string;
  credential: string;
  /** Typed secret; '' means "keep the stored one". Never pre-filled. */
  secret: string;
  /** The admin pressed Remove: the save sends '' for the secret. */
  secretCleared: boolean;
  countries: string;
  ttlHours: string;
}

function formFrom(network: CallNetworkBundle): NetworkForm {
  return {
    rtc_url: network.rtc_url ?? '',
    ws_url: network.ws_url ?? '',
    recording_url: network.recording_url ?? '',
    ice_policy: network.ice_policy,
    turnUrls: (network.turn?.urls ?? []).join('\n'),
    username: network.turn?.username ?? '',
    credential: network.turn?.credential ?? '',
    secret: '',
    secretCleared: false,
    countries: (network.turn?.countries ?? []).join(', '),
    ttlHours: hoursText(network.turn?.credential_ttl_seconds ?? TURN_TTL_DEFAULT_SECONDS),
  };
}

type FormProblem = { key: TranslationKey; params?: Record<string, string | number> };

/**
 * The save to send: only the fields the admin changed. The server merges a
 * save onto the stored row, so a field left out keeps its value, and its
 * audit line names only what really changed. Sending the whole form back
 * would also write keys the row never had (an empty country list, the
 * default lifetime) and blank the signalling URL whenever its field was
 * cleared by accident.
 */
function buildPatch(saved: CallNetworkBundle, form: NetworkForm): { patch: RtcEndpointsPatch } | { problem: FormProblem } {
  const patch: RtcEndpointsPatch = {};
  const optionalUrl = (value: string) => value.trim() || null;

  const rtcUrl = optionalUrl(form.rtc_url);
  if (rtcUrl !== (saved.rtc_url ?? null)) patch.rtc_url = rtcUrl;

  // An empty WebSocket URL is never sent: apps would then connect straight
  // to the RTC URL, which is what the signalling URL (behind Cloudflare) is
  // there to avoid on networks that cut a direct WebSocket.
  const wsUrl = form.ws_url.trim();
  if (!wsUrl && saved.ws_url) return { problem: { key: 'admin.voiceVideo.control.wsUrlEmpty', params: { url: saved.ws_url } } };
  if (wsUrl && wsUrl !== saved.ws_url) patch.ws_url = wsUrl;

  const recordingUrl = optionalUrl(form.recording_url);
  if (recordingUrl !== (saved.recording_url ?? null)) patch.recording_url = recordingUrl;
  if (form.ice_policy !== saved.ice_policy) patch.ice_policy = form.ice_policy;

  const savedTurn = saved.turn;
  const turn: RtcTurnPatch = {};

  const urls = unique(splitList(form.turnUrls));
  if (!sameList(urls, savedTurn?.urls ?? [])) turn.urls = urls;

  const username = form.username.trim() || null;
  if (username !== (savedTurn?.username ?? null)) turn.username = username;
  // A password goes as typed: spaces may be part of it.
  const credential = form.credential === '' ? null : form.credential;
  if (credential !== (savedTurn?.credential ?? null)) turn.credential = credential;

  if (form.secretCleared) {
    turn.shared_secret = '';
  } else if (form.secret.trim()) {
    // Trimmed: coturn reads its secret from a config line, where spaces at
    // either end are not part of it, and a pasted secret often carries a
    // trailing newline that would make every credential fail.
    turn.shared_secret = form.secret.trim();
  }

  const { codes, invalid } = parseRelayCountries(form.countries);
  if (invalid.length > 0) {
    return { problem: { key: 'admin.voiceVideo.control.turnCountriesInvalid', params: { codes: invalid.join(', ') } } };
  }
  if (codes.length > MAX_RELAY_COUNTRIES) return { problem: { key: 'admin.voiceVideo.control.turnCountriesTooMany' } };
  if (!sameList(codes, savedTurn?.countries ?? [])) turn.countries = codes;

  // Compared as typed, so a stored lifetime the field shows rounded
  // (1000 s as 0.28 h) is not rewritten by a save that never touched it.
  const ttlText = asciiDigits(form.ttlHours.trim());
  if (ttlText !== hoursText(savedTurn?.credential_ttl_seconds ?? TURN_TTL_DEFAULT_SECONDS)) {
    const seconds = ttlText ? Math.round(Number(ttlText) * 3600) : TURN_TTL_DEFAULT_SECONDS;
    if (!Number.isFinite(seconds) || seconds < TURN_TTL_MIN_SECONDS || seconds > TURN_TTL_MAX_SECONDS) {
      return { problem: { key: 'admin.voiceVideo.control.turnTtlInvalid' } };
    }
    if (seconds !== (savedTurn?.credential_ttl_seconds ?? TURN_TTL_DEFAULT_SECONDS)) turn.credential_ttl_seconds = seconds;
  }

  if (Object.keys(turn).length > 0) patch.turn = turn;
  return { patch };
}

export function CallControlPlanePanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cp, setCp] = useState<CallControlPlane | null>(null);
  /** The network settings as stored (the last load); the form is compared against it. */
  const [network, setNetwork] = useState<CallNetworkBundle | null>(null);
  const [form, setForm] = useState<NetworkForm | null>(null);
  const [netProblem, setNetProblem] = useState<FormProblem | null>(null);
  const [readiness, setReadiness] = useState<Record<string, boolean>>({});

  function editForm(patch: Partial<NetworkForm>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setNetProblem(null);
  }

  async function load() {
    setLoading(true);
    try {
      const r = await fetchCallControlPlane();
      setCp(r.control_plane);
      setNetwork(r.network);
      setForm(formFrom(r.network));
      setNetProblem(null);
      setReadiness(r.readiness ?? {});
    } catch (e: unknown) {
      toast({ title: t('admin.voiceVideo.control.loadFailed'), description: errorText(e), variant: 'destructive' });
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
      toast({ title: t('admin.voiceVideo.control.saved') });
    } catch (e: unknown) {
      toast({ title: t('admin.voiceVideo.control.saveFailed'), description: errorText(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function saveNet() {
    if (!network || !form) return;
    const built = buildPatch(network, form);
    if ('problem' in built) {
      setNetProblem(built.problem);
      toast({
        title: t('admin.voiceVideo.control.saveFailed'),
        description: t(built.problem.key, built.problem.params),
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      // Sent even when nothing changed: the save also encrypts a secret an
      // older row still holds in plain text.
      await updateRtcEndpoints(built.patch);
      toast({ title: t('admin.voiceVideo.control.networkSaved') });
      await load();
    } catch (e: unknown) {
      toast({ title: t('admin.voiceVideo.control.saveFailed'), description: errorText(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !cp || !network || !form) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const wsUrlMissing = !form.ws_url.trim() && !!network.ws_url;
  const hasSecret = secretStored(network.turn);
  const fingerprint = network.turn?.shared_secret_fingerprint ?? null;
  // Stored but no fingerprint: the server cannot decrypt it, so it mints
  // nothing. A backend older than the fingerprint sends none at all
  // (undefined), which says nothing about the secret.
  const secretUnreadable = hasSecret && network.turn?.shared_secret_fingerprint === null;
  const savedCountries = network.turn?.countries ?? [];
  const relayState = !network.turn?.urls?.length
    ? t('admin.voiceVideo.control.relayStateOff')
    : savedCountries.length === 0 || savedCountries.includes('*')
      ? t('admin.voiceVideo.control.relayStateEveryone')
      : t('admin.voiceVideo.control.relayStateCountries', { countries: savedCountries.join(', ') });

  return (
    <div className="space-y-6">
      {/* Master toggle + provider selection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5" /> {t('admin.voiceVideo.control.title')}
              </CardTitle>
              <CardDescription>{t('admin.voiceVideo.control.description')}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="cp-enabled" className="text-sm">
                {t('admin.voiceVideo.enabled')}
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
              <Label>{t('admin.voiceVideo.control.primaryProvider')}</Label>
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
              <Label>{t('admin.voiceVideo.control.secondaryProvider')}</Label>
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
              <Label>{t('admin.voiceVideo.control.fallbackPolicy')}</Label>
              <Select
                value={cp.fallback_policy}
                onValueChange={(v) => saveCp({ fallback_policy: v as 'lenient' | 'strict' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lenient">{t('admin.voiceVideo.control.lenient')}</SelectItem>
                  <SelectItem value="strict">{t('admin.voiceVideo.control.strict')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.maxParticipants')}</Label>
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
                  ? t('admin.voiceVideo.control.ready')
                  : t('admin.voiceVideo.control.notConfigured')}
              </Badge>
            ))}
            {EXTERNAL_PROVIDERS.map((p) => (
              <Badge key={p} variant="outline" className="gap-1">
                {p} ({t('admin.voiceVideo.control.external')}):{' '}
                {readiness[p]
                  ? t('admin.voiceVideo.control.ready')
                  : t('admin.voiceVideo.control.notConfigured')}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* RTC / TURN endpoints */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" /> {t('admin.voiceVideo.control.endpoints')}
          </CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.endpointsHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="net-rtc-url">{t('admin.voiceVideo.control.rtcBaseUrl')}</Label>
              <Input
                id="net-rtc-url"
                value={form.rtc_url}
                onChange={(e) => editForm({ rtc_url: e.target.value })}
                placeholder="wss://your-livekit.example"
              />
            </div>
            <div>
              <Label htmlFor="net-ws-url">{t('admin.voiceVideo.control.websocketUrl')}</Label>
              <Input
                id="net-ws-url"
                value={form.ws_url}
                onChange={(e) => editForm({ ws_url: e.target.value })}
                placeholder={t('admin.voiceVideo.control.defaultsRtc')}
              />
              {wsUrlMissing && (
                <div
                  role="alert"
                  data-testid="ws-url-missing"
                  className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
                  <div className="space-y-2">
                    <p>{t('admin.voiceVideo.control.wsUrlEmpty', { url: network.ws_url ?? '' })}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => editForm({ ws_url: network.ws_url ?? '' })}
                    >
                      {t('admin.voiceVideo.control.wsUrlRestore')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="net-recording-url">{t('admin.voiceVideo.control.recordingUrl')}</Label>
              <Input
                id="net-recording-url"
                value={form.recording_url}
                onChange={(e) => editForm({ recording_url: e.target.value })}
                placeholder="https://egress.example"
              />
            </div>
            <div>
              <Label>{t('admin.voiceVideo.overview.icePolicy')}</Label>
              <Select
                value={form.ice_policy}
                onValueChange={(v) => editForm({ ice_policy: v as 'all' | 'relay' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('admin.voiceVideo.control.all')}</SelectItem>
                  <SelectItem value="relay">{t('admin.voiceVideo.control.relayOnly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            {/* What callers get today, from the stored settings, not the form. */}
            <p data-testid="relay-state" className="text-xs text-muted-foreground">
              {relayState}
            </p>

            <div className="space-y-1">
              <Label htmlFor="net-turn-urls">{t('admin.voiceVideo.control.turnUrls')}</Label>
              {/* Raw text while typing, parsed on Save: parsing on every
                  keystroke dropped the empty line Enter makes, so a second
                  address could not be typed. */}
              <textarea
                id="net-turn-urls"
                dir="ltr"
                className="w-full min-h-[80px] rounded-md border bg-background p-2 text-sm"
                value={form.turnUrls}
                onChange={(e) => editForm({ turnUrls: e.target.value })}
                placeholder={'turn:turn.example:3478\nturns:turn.example:5349?transport=tcp'}
              />
              <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.control.turnUrlsHint')}</p>
            </div>

            {/* The relay's shared secret: write-only. The page learns only
                whether one is stored and its fingerprint, never the value. */}
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="net-turn-secret" className="flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" /> {t('admin.voiceVideo.control.turnSecret')}
                </Label>
                <Badge
                  data-testid="turn-secret-state"
                  variant={!hasSecret ? 'secondary' : secretUnreadable ? 'destructive' : 'default'}
                  className="font-normal"
                >
                  {!hasSecret
                    ? t('admin.voiceVideo.control.turnSecretNotSet')
                    : fingerprint
                      ? t('admin.voiceVideo.control.turnSecretSet', { fingerprint })
                      : secretUnreadable
                        ? t('admin.voiceVideo.control.turnSecretUnreadable')
                        : t('admin.voiceVideo.set')}
                </Badge>
              </div>
              <div className="flex gap-2">
                <Input
                  id="net-turn-secret"
                  type="password"
                  autoComplete="new-password"
                  dir="ltr"
                  value={form.secret}
                  disabled={form.secretCleared}
                  onChange={(e) => editForm({ secret: e.target.value })}
                  placeholder={
                    hasSecret
                      ? t('admin.voiceVideo.control.turnSecretPlaceholderReplace')
                      : t('admin.voiceVideo.control.turnSecretPlaceholderNew')
                  }
                />
                {hasSecret && !form.secretCleared && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => editForm({ secret: '', secretCleared: true })}
                  >
                    {t('admin.voiceVideo.control.turnSecretClear')}
                  </Button>
                )}
              </div>
              {form.secretCleared && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
                  <span>{t('admin.voiceVideo.control.turnSecretClearPending')}</span>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => editForm({ secretCleared: false })}
                  >
                    {t('admin.voiceVideo.control.turnSecretKeep')}
                  </Button>
                </div>
              )}
              {secretUnreadable && (
                <p className="text-xs text-destructive">{t('admin.voiceVideo.control.turnSecretUnreadableHint')}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.control.turnSecretHint')}</p>
              {fingerprint && (
                <p className="text-xs text-muted-foreground">
                  {t('admin.voiceVideo.control.turnSecretFingerprintHint')}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="net-turn-countries">{t('admin.voiceVideo.control.turnCountries')}</Label>
                <Input
                  id="net-turn-countries"
                  dir="ltr"
                  value={form.countries}
                  onChange={(e) => editForm({ countries: e.target.value })}
                  placeholder={RELAY_COUNTRIES_PLACEHOLDER}
                />
                <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.control.turnCountriesHint')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="net-turn-ttl">{t('admin.voiceVideo.control.turnTtl')}</Label>
                {/* Text, not a number field: a number field reads «۶» from a
                    Persian keyboard as empty, and the save would then keep
                    the old value without a word. */}
                <Input
                  id="net-turn-ttl"
                  inputMode="decimal"
                  dir="ltr"
                  value={form.ttlHours}
                  onChange={(e) => editForm({ ttlHours: e.target.value })}
                  placeholder={hoursText(TURN_TTL_DEFAULT_SECONDS)}
                />
                <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.control.turnTtlHint')}</p>
              </div>
            </div>

            {/* A static pair, for a TURN server that has fixed credentials
                rather than a shared secret. */}
            <div className="space-y-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="net-turn-username">{t('admin.voiceVideo.control.turnUsername')}</Label>
                  <Input
                    id="net-turn-username"
                    dir="ltr"
                    value={form.username}
                    onChange={(e) => editForm({ username: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="net-turn-credential">{t('admin.voiceVideo.control.turnCredential')}</Label>
                  <Input
                    id="net-turn-credential"
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    value={form.credential}
                    onChange={(e) => editForm({ credential: e.target.value })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('admin.voiceVideo.control.staticPairHint')}</p>
            </div>
          </div>

          {netProblem && !wsUrlMissing && (
            <p role="alert" data-testid="network-problem" className="text-sm text-destructive">
              {t(netProblem.key, netProblem.params)}
            </p>
          )}

          <div className="flex justify-end">
            <Button onClick={saveNet} disabled={saving || wsUrlMissing}>
              <Save className="h-4 w-4 me-2" /> {t('admin.voiceVideo.control.saveEndpoints')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recording / retention */}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.voiceVideo.control.recordingTitle')}</CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.recordingDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('admin.voiceVideo.control.recordingDefault')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.voiceVideo.control.recordingDefaultHint')}
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
              <Label>{t('admin.voiceVideo.control.recordingType')}</Label>
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
                  <SelectItem value="composite">{t('admin.voiceVideo.control.composite')}</SelectItem>
                  <SelectItem value="individual">{t('admin.voiceVideo.control.individual')}</SelectItem>
                  <SelectItem value="audio_only">{t('admin.voiceVideo.control.audioOnly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('admin.voiceVideo.control.retentionDays')}</Label>
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
              <Label>{t('admin.voiceVideo.control.requireVerification')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('admin.voiceVideo.control.requireVerificationHint')}
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
            <Phone className="h-5 w-5" /> {t('admin.voiceVideo.control.channelGates')}
          </CardTitle>
          <CardDescription>{t('admin.voiceVideo.control.channelGatesHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {(
            [
              [
                'voice_calls_enabled_global',
                t('admin.voiceVideo.control.voiceCalls'),
                t('admin.voiceVideo.control.voiceCallsHint'),
              ],
              [
                'video_calls_enabled_global',
                t('admin.voiceVideo.control.videoCalls'),
                t('admin.voiceVideo.control.videoCallsHint'),
              ],
              [
                'call_queue_enabled_global',
                t('admin.voiceVideo.control.callQueue'),
                t('admin.voiceVideo.control.callQueueHint'),
              ],
              [
                'call_recording_enabled_global',
                t('admin.voiceVideo.control.recording'),
                t('admin.voiceVideo.control.recordingHint'),
              ],
              [
                'visitor_initiated_audio_enabled_global',
                t('admin.voiceVideo.control.visitorAudio'),
                t('admin.voiceVideo.control.visitorAudioHint'),
              ],
              [
                'visitor_initiated_video_enabled_global',
                t('admin.voiceVideo.control.visitorVideo'),
                t('admin.voiceVideo.control.visitorVideoHint'),
              ],
            ] as Array<[keyof typeof cp, string, string]>
          ).map(([key, label, hint]) => (
            <div key={key as string} className="flex items-start justify-between gap-3 py-2">
              <div className="flex-1 min-w-0">
                <Label className="text-sm">{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <Switch checked={!!cp[key]} disabled={saving} onCheckedChange={(v) => saveCp({ [key]: v } as Partial<CallControlPlane>)} />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Phase 8C — Platform-default role permissions. */}
      <RolePermissionsPanel />
    </div>
  );
}
