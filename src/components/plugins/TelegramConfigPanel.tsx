/**
 * Telegram configuration — full-page panels (no dialog).
 *
 * The bot token is WRITE-ONLY: it is submitted once and never returned by the
 * API, so this component never renders a stored value — only `hasToken`.
 *
 * Rendered one `section` at a time so the parent page owns the tab strip:
 *   connection — token, webhook, health, diagnostics, lifecycle actions
 *   branding   — bot name / descriptions / photo, applied to Telegram on demand
 *   messages   — localized replies, slash-command labels, who answers first
 *
 * Three lifecycle actions stay distinct, because conflating them is how
 * integrations silently break:
 *   connect     — submit a (new) token, verify it, register the webhook
 *   reconnect   — re-register the webhook with the STORED token (repairs drift)
 *   disconnect  — remove the provider webhook and the stored token, keep history
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { pluginsApi } from '@/lib/plugins-api';
import { formatDateTime } from '@/lib/date';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Loader2,
  PlugZap,
  RefreshCw,
  Stethoscope,
} from 'lucide-react';

export type TelegramPanelSection = 'connection' | 'branding' | 'messages';

/** Locales the Telegram bot copy can ever be authored in. */
const TELEGRAM_LOCALES = ['en', 'fa', 'tr'] as const;

/** Maps machine reasons from the API to localized, actionable copy. */
function connectErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'duplicate_bot':
      return 'plugins.telegram.error.duplicateBot';
    case 'invalid_token':
    case 'get_me_failed':
      return 'plugins.telegram.error.invalidToken';
    case 'not_configured':
    case 'channels_not_configured':
      return 'plugins.telegram.error.notConfigured';
    case 'encryption_not_configured':
    case 'credential_store_failed':
      return 'plugins.telegram.error.encryptionNotConfigured';
    case 'webhook_rejected':
    case 'set_webhook_failed':
      return 'plugins.telegram.error.webhookRejected';
    case 'verification_failed':
    case 'get_webhook_info_failed':
    case 'webhook_url_mismatch':
    case 'webhook_provider_error':
      return 'plugins.telegram.error.verificationFailed';
    default:
      return 'plugins.telegram.connectFailed';
  }
}

const EMPTY_LOCALES = {
  en: { welcome: '', help: '', offline: '', handoff: '', fallback: '' },
  fa: { welcome: '', help: '', offline: '', handoff: '', fallback: '' },
  tr: { welcome: '', help: '', offline: '', handoff: '', fallback: '' },
};

export function TelegramConfigPanel({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section: TelegramPanelSection;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [botName, setBotName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [handlingMode, setHandlingMode] = useState<'human_only' | 'ai_first'>('human_only');
  const [locale, setLocale] = useState<'en' | 'fa' | 'tr'>('en');
  const [locales, setLocales] = useState(EMPTY_LOCALES);
  const [commands, setCommands] = useState({ start: '', help: '', human: '', new: '' });
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Only the languages this deployment actually speaks may be edited. On a
  // single-language platform we show that one language's fields with no picker.
  const { allowedLocales } = usePlatformRegion();
  const editableLocales = (() => {
    const scoped = TELEGRAM_LOCALES.filter((l) => (allowedLocales as string[]).includes(l));
    return scoped.length ? scoped : (['en'] as const as unknown as typeof TELEGRAM_LOCALES);
  })();

  useEffect(() => {
    if (!editableLocales.includes(locale)) setLocale(editableLocales[0]);
  }, [editableLocales.join(','), locale]); // eslint-disable-line react-hooks/exhaustive-deps


  const { data: status, isLoading } = useQuery({
    queryKey: ['plugins', 'telegram', 'status', workspaceId],
    queryFn: () => pluginsApi.telegramStatus(workspaceId),
    enabled: !!workspaceId,
  });

  const integration = status?.integration ?? null;

  useEffect(() => {
    if (!status?.settings || settingsLoaded) return;
    const s = status.settings;
    setPhotoUrl(s.profile.photoUrl);
    setHandlingMode(s.handlingMode);
    setLocales(s.locales);
    setCommands(s.commands);
    setBotName((prev) => prev || s.profile.name);
    setShortDescription((prev) => prev || s.profile.shortDescription);
    setDescription((prev) => prev || s.profile.description);
    setSettingsLoaded(true);
  }, [status?.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (integration?.botName) setBotName((prev) => prev || integration.botName!);
  }, [integration?.botName]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['plugins'] });

  const connect = useMutation({
    mutationFn: () => pluginsApi.telegramConnect(workspaceId, token.trim()),
    onSuccess: () => {
      setToken('');
      toast({ title: t('plugins.telegram.connectSuccess') });
      refresh();
    },
    onError: (err: any) =>
      toast({
        variant: 'destructive',
        title: t(connectErrorKey(err?.code) as never),
        description:
          err?.code === 'duplicate_bot'
            ? undefined
            : [err?.message, err?.code ? `(${err.code})` : null].filter(Boolean).join(' '),
      }),
  });

  const runDiagnostics = useMutation({
    mutationFn: () => pluginsApi.telegramDiagnostics(workspaceId),
    onSuccess: (data) => setDiagnostics(data),
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const reconnect = useMutation({
    mutationFn: () => pluginsApi.telegramReconnect(workspaceId),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.reconnected') });
      setDiagnostics(null);
      refresh();
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.telegram.reconnectFailed'), description: err?.message }),
  });

  const disconnect = useMutation({
    mutationFn: () => pluginsApi.telegramDisconnect(workspaceId),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.disconnected') });
      setDiagnostics(null);
      refresh();
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      pluginsApi.updateSettings(workspaceId, 'telegram', {
        profile: {
          name: botName.trim(),
          shortDescription: shortDescription.trim(),
          description: description.trim(),
          photoUrl: photoUrl.trim(),
        },
        locales,
        commands,
        handlingMode,
      }),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.settingsSaved') });
      refresh();
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const applyProfile = useMutation({
    mutationFn: () =>
      pluginsApi.telegramProfile(workspaceId, {
        name: botName.trim() || undefined,
        short_description: shortDescription.trim() || undefined,
        description: description.trim() || undefined,
        commands: Object.entries(commands).map(([command, desc]) => ({ command, description: desc })),
      }),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.brandingApplied') });
      refresh();
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.telegram.brandingFailed'), description: err?.message }),
  });

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  const connected = integration?.status === 'connected';
  const hasToken = !!status?.hasToken;

  if (section === 'connection') {
    return (
      <div className="space-y-4">
        <Card className="space-y-4 p-4">
          {integration?.botUsername && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {connected ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertCircle className="h-4 w-4 text-amber-500" />
              )}
              <span className="text-muted-foreground">{t('plugins.telegram.connectedAs')}</span>
              <Badge variant="secondary" dir="ltr">@{integration.botUsername}</Badge>
              <Badge variant={connected ? 'default' : 'outline'}>{integration.status}</Badge>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="telegram-token">{t('plugins.telegram.botToken')}</Label>
            <Input
              id="telegram-token"
              dir="ltr"
              autoComplete="off"
              placeholder="123456789:AA..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('plugins.telegram.botTokenHint')}</p>
            {hasToken && !token && (
              <p className="text-xs text-emerald-600">{t('plugins.telegram.tokenStored')}</p>
            )}
          </div>

          {integration?.webhookUrl && (
            <div className="space-y-1.5">
              <Label>{t('plugins.telegram.webhookUrl')}</Label>
              <div className="flex items-center gap-2">
                <Input dir="ltr" readOnly value={integration.webhookUrl} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard?.writeText(integration.webhookUrl!);
                    toast({ title: t('plugins.action.copied') });
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {integration && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-xs">
              {([
                ['plugins.telegram.webhookRegistered', integration.webhookRegisteredAt],
                ['plugins.telegram.webhookVerified', integration.webhookVerifiedAt],
                ['plugins.telegram.lastInbound', integration.lastInboundAt],
                ['plugins.telegram.lastOutbound', integration.lastOutboundAt],
              ] as const).map(([key, value]) => (
                <div key={key}>
                  <p className="text-muted-foreground">{t(key as never)}</p>
                  <p>{value ? formatDateTime(value) : t('plugins.telegram.never')}</p>
                </div>
              ))}
              {integration.lastErrorCode && (
                <div className="col-span-2 flex items-start gap-1.5 text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-all" dir="ltr">
                    {integration.lastErrorCode}
                    {integration.lastErrorAt ? ` · ${formatDateTime(integration.lastErrorAt)}` : ''}
                  </span>
                </div>
              )}
            </div>
          )}

          {diagnostics && (
            <div className="space-y-1.5">
              <Label>{t('plugins.telegram.diagnosticsTitle')}</Label>
              <pre dir="ltr" className="max-h-56 overflow-auto rounded-lg bg-muted p-3 text-[11px]">
                {JSON.stringify(diagnostics, null, 2)}
              </pre>
            </div>
          )}

          <Separator />

          <div className="flex flex-wrap items-center justify-end gap-2">
            {status?.installed && (
              <Button
                type="button"
                variant="outline"
                disabled={runDiagnostics.isPending || !hasToken}
                onClick={() => runDiagnostics.mutate()}
              >
                {runDiagnostics.isPending ? (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                ) : (
                  <Stethoscope className="me-2 h-4 w-4" />
                )}
                {t('plugins.action.runDiagnostics')}
              </Button>
            )}

            {hasToken && (
              <Button type="button" variant="outline" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
                {reconnect.isPending ? (
                  <Loader2 className="me-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="me-2 h-4 w-4" />
                )}
                {t('plugins.action.repairWebhook')}
              </Button>
            )}

            {hasToken && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={disconnect.isPending}
                onClick={() => {
                  if (window.confirm(t('plugins.telegram.confirmDisconnect'))) disconnect.mutate();
                }}
              >
                {disconnect.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('plugins.action.disconnect')}
              </Button>
            )}

            <Button
              type="button"
              disabled={connect.isPending || token.trim().length < 20}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <PlugZap className="me-2 h-4 w-4" />
              )}
              {hasToken ? t('plugins.action.replaceToken') : t('plugins.action.connect')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!hasToken) {
    return (
      <Card className="p-10 text-center text-sm text-muted-foreground">
        {t('plugins.telegram.connectFirst')}
      </Card>
    );
  }

  if (section === 'branding') {
    return (
      <Card className="space-y-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="telegram-bot-name">{t('plugins.telegram.brandingName')}</Label>
          <Input id="telegram-bot-name" value={botName} maxLength={64} onChange={(e) => setBotName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="telegram-bot-short">{t('plugins.telegram.brandingShort')}</Label>
          <Input
            id="telegram-bot-short"
            value={shortDescription}
            maxLength={120}
            onChange={(e) => setShortDescription(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="telegram-bot-desc">{t('plugins.telegram.brandingDescription')}</Label>
          <Textarea
            id="telegram-bot-desc"
            rows={3}
            value={description}
            maxLength={512}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="telegram-photo-url">{t('plugins.telegram.photoUrl')}</Label>
          <Input id="telegram-photo-url" dir="ltr" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('plugins.telegram.photoUrlHint')}</p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={applyProfile.isPending} onClick={() => applyProfile.mutate()}>
            {applyProfile.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('plugins.telegram.applyBranding')}
          </Button>
          <Button type="button" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
            {saveSettings.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('plugins.telegram.saveSettings')}
          </Button>
        </div>
      </Card>
    );
  }

  const aiAvailable = status?.aiAvailable !== false;
  const aiAgent = status?.aiAgent ?? null;
  const aiSilent =
    aiAvailable && handlingMode === 'ai_first' && aiAgent
      ? !aiAgent.platformAllowed || !aiAgent.agentEnabled
      : false;

  return (
    <Card className="space-y-4 p-4">
      {/* The AI mode only exists when the workspace plan carries the AI
          assistant — otherwise the choice is hidden, not merely disabled. */}
      {aiAvailable && (
        <>
          <div className="space-y-2">
            <Label>{t('plugins.telegram.handlingMode')}</Label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={handlingMode === 'human_only' ? 'default' : 'outline'}
                onClick={() => setHandlingMode('human_only')}
              >
                {t('plugins.telegram.handlingModeHumanOnly')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={handlingMode === 'ai_first' ? 'default' : 'outline'}
                onClick={() => setHandlingMode('ai_first')}
              >
                {t('plugins.telegram.handlingModeAiFirst')}
              </Button>
            </div>
            {aiSilent && (
              <p className="flex items-start gap-1.5 text-xs text-amber-600">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('plugins.telegram.aiAgentInactive')}
              </p>
            )}
          </div>

          <Separator />
        </>
      )}

      {editableLocales.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {editableLocales.map((l) => (
            <Button key={l} type="button" size="sm" variant={locale === l ? 'default' : 'outline'} onClick={() => setLocale(l)}>
              {t(`plugins.telegram.locale.${l}` as never)}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="space-y-3" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
        {(['welcome', 'help', 'offline', 'handoff', 'fallback'] as const).map((key) => (
          <div key={key} className="space-y-1">
            <Label>{t(`plugins.telegram.message.${key}` as never)}</Label>
            <Textarea
              rows={2}
              value={locales[locale][key]}
              onChange={(e) =>
                setLocales((prev) => ({ ...prev, [locale]: { ...prev[locale], [key]: e.target.value } }))
              }
            />
          </div>
        ))}
      </div>

      <Separator />

      <div className="space-y-2" dir={locale === 'fa' ? 'rtl' : 'ltr'}>
        <Label>{t('plugins.telegram.commandsTitle')}</Label>
        <p className="text-xs text-muted-foreground">{t('plugins.telegram.commandsHint')}</p>
        {(['start', 'help', 'human', 'new'] as const).map((key) => (
          <div key={key} className="flex items-center gap-2">
            <Badge variant="outline" dir="ltr">/{key}</Badge>
            <Input
              value={commandLocales[locale][key]}
              onChange={(e) =>
                setCommandLocales((prev) => ({ ...prev, [locale]: { ...prev[locale], [key]: e.target.value } }))
              }
            />
          </div>
        ))}
      </div>


      <div className="flex justify-end">
        <Button type="button" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
          {saveSettings.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {t('plugins.telegram.saveSettings')}
        </Button>
      </div>
    </Card>
  );
}

export default TelegramConfigPanel;
