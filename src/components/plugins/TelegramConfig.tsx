/**
 * Telegram configuration dialog.
 *
 * The bot token is WRITE-ONLY: it is submitted once and never returned by the
 * API, so this component never renders a stored value — only `hasToken`.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { pluginsApi } from '@/lib/plugins-api';
import { formatDateTime } from '@/lib/date';
import { AlertCircle, CheckCircle2, Copy, Loader2, Stethoscope } from 'lucide-react';

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

  const { data: status, isLoading } = useQuery({
    queryKey: ['plugins', 'telegram', 'status', workspaceId],
    queryFn: () => pluginsApi.telegramStatus(workspaceId),
    enabled: open && !!workspaceId,
  });

  const connect = useMutation({
    mutationFn: () => pluginsApi.telegramConnect(workspaceId, token.trim()),
    onSuccess: () => {
      setToken('');
      toast({ title: t('plugins.telegram.connectSuccess') });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
    onError: (err: any) =>
      toast({
        variant: 'destructive',
        title: t('plugins.telegram.connectFailed'),
        description: err?.message,
      }),
  });

  const runDiagnostics = useMutation({
    mutationFn: () => pluginsApi.telegramDiagnostics(workspaceId),
    onSuccess: (data) => setDiagnostics(data),
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const integration = status?.integration ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
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
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-muted-foreground">{t('plugins.telegram.connectedAs')}</span>
                <Badge variant="secondary">@{integration.botUsername}</Badge>
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
                  <p>{integration.webhookRegisteredAt ? formatDateTime(integration.webhookRegisteredAt) : t('plugins.telegram.never')}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('plugins.telegram.lastInbound')}</p>
                  <p>{integration.lastInboundAt ? formatDateTime(integration.lastInboundAt) : t('plugins.telegram.never')}</p>
                </div>
                {integration.lastError && (
                  <div className="col-span-2 flex items-start gap-1.5 text-destructive">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">{integration.lastError}</span>
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

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {status?.installed && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={runDiagnostics.isPending}
                  onClick={() => runDiagnostics.mutate()}
                >
                  {runDiagnostics.isPending
                    ? <Loader2 className="me-2 h-4 w-4 animate-spin" />
                    : <Stethoscope className="me-2 h-4 w-4" />}
                  {t('plugins.action.runDiagnostics')}
                </Button>
              )}
              <Button
                type="button"
                disabled={connect.isPending || token.trim().length < 20}
                onClick={() => connect.mutate()}
              >
                {connect.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {status?.hasToken ? t('plugins.action.reconnect') : t('plugins.action.connect')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TelegramConfig;
