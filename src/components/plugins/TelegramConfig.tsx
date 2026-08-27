/**
 * Telegram configuration dialog.
 *
 * The bot token is WRITE-ONLY: it is submitted once and never returned by the
 * API, so this component never renders a stored value — only `hasToken`.
 *
 * Three distinct lifecycle actions are exposed, because they are NOT the same
 * operation and conflating them is how integrations silently break:
 *   connect     — submit a (new) token, verify it, register the webhook
 *   reconnect   — re-register the webhook with the STORED token (repairs drift)
 *   disconnect  — remove the provider webhook and the stored token, keep history
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { pluginsApi } from '@/lib/plugins-api';
import { formatDateTime } from '@/lib/date';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Loader2,
  PlugZap,
  RefreshCw,
  Sparkles,
  Stethoscope,
} from 'lucide-react';

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


export function TelegramConfig({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [botName, setBotName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['plugins', 'telegram', 'status', workspaceId],
    queryFn: () => pluginsApi.telegramStatus(workspaceId),
    enabled: open && !!workspaceId,
  });

  const integration = status?.integration ?? null;

  useEffect(() => {
    if (integration?.botName && !botName) setBotName(integration.botName);
  }, [integration?.botName]); // eslint-disable-line react-hooks/exhaustive-deps

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
        description: err?.code === 'duplicate_bot' ? undefined : err?.message,
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

  const applyProfile = useMutation({
    mutationFn: () =>
      pluginsApi.telegramProfile(workspaceId, {
        name: botName.trim() || undefined,
        short_description: shortDescription.trim() || undefined,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.brandingApplied') });
      refresh();
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.telegram.brandingFailed'), description: err?.message }),
  });

  const connected = integration?.status === 'connected';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader className="text-start">
          <DialogTitle>{t('plugins.telegram.name')}</DialogTitle>
          <DialogDescription>{t('plugins.telegram.description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {integration?.botUsername && (
              <div className="flex items-center gap-2 text-sm">
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
              {status?.hasToken && !token && (
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
                <div>
                  <p className="text-muted-foreground">{t('plugins.telegram.webhookRegistered')}</p>
                  <p>
                    {integration.webhookRegisteredAt
                      ? formatDateTime(integration.webhookRegisteredAt)
                      : t('plugins.telegram.never')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('plugins.telegram.webhookVerified')}</p>
                  <p>
                    {integration.webhookVerifiedAt
                      ? formatDateTime(integration.webhookVerifiedAt)
                      : t('plugins.telegram.never')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('plugins.telegram.lastInbound')}</p>
                  <p>
                    {integration.lastInboundAt
                      ? formatDateTime(integration.lastInboundAt)
                      : t('plugins.telegram.never')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('plugins.telegram.lastOutbound')}</p>
                  <p>
                    {integration.lastOutboundAt
                      ? formatDateTime(integration.lastOutboundAt)
                      : t('plugins.telegram.never')}
                  </p>
                </div>
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
                <pre dir="ltr" className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-[11px]">
                  {JSON.stringify(diagnostics, null, 2)}
                </pre>
              </div>
            )}

            {status?.hasToken && (
              <>
                <Separator />
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Sparkles className="h-4 w-4 text-muted-foreground" />
                    {t('plugins.telegram.brandingTitle')}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="telegram-bot-name">{t('plugins.telegram.brandingName')}</Label>
                    <Input
                      id="telegram-bot-name"
                      value={botName}
                      maxLength={64}
                      onChange={(e) => setBotName(e.target.value)}
                    />
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
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={applyProfile.isPending}
                    onClick={() => applyProfile.mutate()}
                  >
                    {applyProfile.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                    {t('plugins.telegram.applyBranding')}
                  </Button>
                </div>
              </>
            )}

            <Separator />

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {status?.installed && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={runDiagnostics.isPending || !status?.hasToken}
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

              {status?.hasToken && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={reconnect.isPending}
                  onClick={() => reconnect.mutate()}
                >
                  {reconnect.isPending ? (
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="me-2 h-4 w-4" />
                  )}
                  {t('plugins.action.repairWebhook')}
                </Button>
              )}

              {status?.hasToken && (
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
                {status?.hasToken ? t('plugins.action.replaceToken') : t('plugins.action.connect')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TelegramConfig;
