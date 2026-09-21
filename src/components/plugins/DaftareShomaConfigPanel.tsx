/**
 * DaftareShoma (WEBYAR Telephony) configuration panel.
 *
 * Reached from Plugins → DaftareShoma. Three sections: Connection (the seven
 * SIP fields), Status (four independent readiness flags), Actions (Save, Test
 * Connection, Disconnect).
 *
 * The SIP password is write-only: the server returns `hasSipPassword` and
 * never the value, so the field shows a masked placeholder and is only sent
 * when the operator types a new one. All strings go through useTranslation()
 * (plugins.daftareshoma.* in src/i18n/locales/{en,fa,tr}.ts).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { API_BASE } from '@/lib/apiBase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { CheckCircle2, ExternalLink, Loader2, PhoneCall, XCircle } from 'lucide-react';

interface TelephonySettings {
  sip_username: string;
  sip_extension: string;
  sip_domain_udp: string;
  sip_domain_tcp: string;
  sip_domain_webrtc: string;
  outgoing_line: string;
  transport: 'udp' | 'tcp' | 'tls';
}

interface TelephonyStatus {
  installed: boolean;
  provider: string;
  helpUrl: string;
  settings: TelephonySettings | null;
  hasSipPassword: boolean;
  cryptoReady?: boolean;
  gatewayConfigured?: boolean;
  readiness: {
    configured: boolean;
    gateway_healthy: boolean;
    sip_registered: boolean;
    livekit_sip_ready: boolean;
  };
  registration: {
    state: string;
    lastRegisteredAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
    lastInboundCallAt: string | null;
    domain: string | null;
    extension: string | null;
  } | null;
}

const EMPTY: TelephonySettings = {
  sip_username: '', sip_extension: '', sip_domain_udp: '', sip_domain_tcp: '',
  sip_domain_webrtc: '', outgoing_line: '', transport: 'udp',
};

const TEXT_FIELDS: Array<keyof Omit<TelephonySettings, 'transport'>> = [
  'sip_username', 'sip_extension', 'sip_domain_udp', 'sip_domain_tcp',
  'sip_domain_webrtc', 'outgoing_line',
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error || `Request failed (${res.status})`);
  return body as T;
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok
        ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
        : <XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />}
      <span className={ok ? '' : 'text-muted-foreground'}>{label}</span>
    </div>
  );
}

export function DaftareShomaConfigPanel({ workspaceId }: { workspaceId: string }) {
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TelephonySettings>(EMPTY);
  const [password, setPassword] = useState('');

  const statusKey = ['telephony-status', workspaceId];
  const { data, isLoading } = useQuery({
    queryKey: statusKey,
    queryFn: () => api<TelephonyStatus>(`/api/telephony/daftareshoma/status?workspace_id=${workspaceId}`),
    enabled: !!workspaceId,
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (data?.settings) setForm({ ...EMPTY, ...data.settings });
  }, [data?.settings]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: statusKey });

  // Server error codes are short machine strings; show the translated text
  // when we have one and fall back to the raw message otherwise.
  const describe = (raw: string) => {
    const translated = t(`plugins.daftareshoma.error.${raw}` as never);
    return translated === `plugins.daftareshoma.error.${raw}` ? raw : translated;
  };

  const fail = (err: unknown) => toast({
    title: t('plugins.daftareshoma.toast.failed'),
    description: describe(err instanceof Error ? err.message : String(err)),
    variant: 'destructive',
  });

  const saveMutation = useMutation({
    mutationFn: () => api<TelephonyStatus & { warning?: string | null }>('/api/telephony/daftareshoma/settings', {
      method: 'PUT',
      body: JSON.stringify({
        workspace_id: workspaceId,
        settings: form,
        // Blank means "keep the stored password" — never "erase it".
        ...(password.trim() ? { sip_password: password.trim() } : {}),
      }),
    }),
    onSuccess: (res) => {
      setPassword('');
      toast({
        title: t('plugins.daftareshoma.toast.saved'),
        description: res.warning ? describe(res.warning) : undefined,
      });
      invalidate();
    },
    onError: fail,
  });

  const testMutation = useMutation({
    mutationFn: () => api<{ result: { registration: string; gateway: string; error_code?: string | null } }>(
      '/api/telephony/daftareshoma/test',
      { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) },
    ),
    onSuccess: (res) => {
      const registered = res.result.registration === 'registered';
      toast({
        title: registered
          ? t('plugins.daftareshoma.toast.registered')
          : t('plugins.daftareshoma.toast.notRegistered'),
        description: res.result.error_code
          ? t(`plugins.daftareshoma.error.${res.result.error_code}` as never)
          : undefined,
        variant: registered ? undefined : 'destructive',
      });
      invalidate();
    },
    onError: fail,
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api('/api/telephony/daftareshoma/disconnect', {
      method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }),
    }),
    onSuccess: () => {
      toast({ title: t('plugins.daftareshoma.toast.disconnected') });
      invalidate();
    },
    onError: fail,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const readiness = data?.readiness;
  const registration = data?.registration;
  const state = registration?.state ?? 'not_configured';
  const fmt = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran',
    }).format(new Date(iso)) : '—';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="h-4 w-4" aria-hidden />
            {t('plugins.daftareshoma.connection.title')}
          </CardTitle>
          <CardDescription>{t('plugins.daftareshoma.connection.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <a
            href={data?.helpUrl || 'https://daftareshoma.com'}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t('plugins.daftareshoma.getNumber')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>

          <div className="grid gap-4 sm:grid-cols-2">
            {TEXT_FIELDS.map((field) => (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={`ds-${field}`}>{t(`plugins.daftareshoma.field.${field}` as never)}</Label>
                <Input
                  id={`ds-${field}`}
                  value={form[field]}
                  dir="ltr"
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                />
              </div>
            ))}

            <div className="space-y-1.5">
              <Label htmlFor="ds-transport">{t('plugins.daftareshoma.field.transport')}</Label>
              <Select
                value={form.transport}
                onValueChange={(v) => setForm((f) => ({ ...f, transport: v as TelephonySettings['transport'] }))}
              >
                <SelectTrigger id="ds-transport"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="udp">UDP</SelectItem>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="tls">TLS / WSS</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ds-password">{t('plugins.daftareshoma.field.sip_password')}</Label>
              <Input
                id="ds-password"
                type="password"
                dir="ltr"
                autoComplete="new-password"
                value={password}
                placeholder={data?.hasSipPassword ? '••••••••' : ''}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('plugins.daftareshoma.field.sip_password_hint')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
              {t('plugins.daftareshoma.action.save')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || !data?.hasSipPassword}
            >
              {testMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
              {t('plugins.daftareshoma.action.test')}
            </Button>
            <Button
              variant="outline"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {t('plugins.daftareshoma.action.disconnect')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('plugins.daftareshoma.status.title')}
            <Badge variant={state === 'registered' ? 'default' : state === 'failed' ? 'destructive' : 'secondary'}>
              {t(`plugins.daftareshoma.state.${state}` as never)}
            </Badge>
          </CardTitle>
          <CardDescription>{t('plugins.daftareshoma.status.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Flag ok={!!readiness?.configured} label={t('plugins.daftareshoma.flag.configured')} />
            <Flag ok={!!readiness?.gateway_healthy} label={t('plugins.daftareshoma.flag.gateway_healthy')} />
            <Flag ok={!!readiness?.sip_registered} label={t('plugins.daftareshoma.flag.sip_registered')} />
            <Flag ok={!!readiness?.livekit_sip_ready} label={t('plugins.daftareshoma.flag.livekit_sip_ready')} />
          </div>

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t('plugins.daftareshoma.status.extension')}</dt>
              <dd dir="ltr">{registration?.extension || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('plugins.daftareshoma.status.domain')}</dt>
              <dd dir="ltr">{registration?.domain || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('plugins.daftareshoma.status.lastRegistered')}</dt>
              <dd>{fmt(registration?.lastRegisteredAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('plugins.daftareshoma.status.lastInbound')}</dt>
              <dd>{fmt(registration?.lastInboundCallAt)}</dd>
            </div>
          </dl>

          {registration?.lastErrorCode && (
            <p className="text-sm text-destructive">
              {t(`plugins.daftareshoma.error.${registration.lastErrorCode}` as never)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
