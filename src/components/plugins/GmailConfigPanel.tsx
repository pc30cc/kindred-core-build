/**
 * Gmail plugin connection panel — shown on the plugin detail page instead of
 * TelegramConfigPanel's paste-a-token flow, since Gmail connects via an
 * OAuth2 browser redirect (server/services/channels/gmail/oauth.ts).
 */
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Mail, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { toast } from '@/hooks/use-toast';
import {
  useGmailConnection,
  useStartGmailOAuth,
  useDisconnectGmail,
} from '@/hooks/useEmailInbox';

export function GmailConfigPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const { data, isLoading } = useGmailConnection(workspaceId);
  const startOAuth = useStartGmailOAuth(workspaceId);
  const disconnect = useDisconnectGmail(workspaceId);

  if (isLoading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  if (!data?.platformConfigured) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        {t('plugins.gmail.notConfigured' as any)}
      </Card>
    );
  }

  const connected = data.connection.connected;

  const handleConnect = async () => {
    try {
      const result = await startOAuth.mutateAsync();
      window.location.href = result.url;
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message });
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      toast({ title: t('plugins.gmail.disconnect' as any) });
    } catch (err: any) {
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message });
    }
  };

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
          <Mail className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{t('plugins.gmail.connectTitle' as any)}</h3>
            {connected && <Badge>{t('plugins.gmail.connected' as any)}</Badge>}
          </div>
          {connected ? (
            <p className="text-sm text-muted-foreground">
              {t('plugins.gmail.connectedAs' as any)} <span className="font-medium text-foreground">{data.connection.emailAddress}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('plugins.gmail.connectDescription' as any)}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {connected ? (
          <>
            <Button asChild size="sm" className="gap-1.5">
              <Link to={wsPath('/email')}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t('plugins.gmail.openInbox' as any)}
              </Link>
            </Button>
            <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={handleDisconnect}>
              {t('plugins.gmail.disconnect' as any)}
            </Button>
          </>
        ) : (
          <Button size="sm" className="gap-1.5" disabled={startOAuth.isPending} onClick={handleConnect}>
            <Mail className="h-3.5 w-3.5" />
            {t('plugins.gmail.connect' as any)}
          </Button>
        )}
      </div>
    </Card>
  );
}

export default GmailConfigPanel;
