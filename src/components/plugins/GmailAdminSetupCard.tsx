/**
 * Super Admin — Gmail deployment setup status.
 *
 * Gmail has no in-app configuration form (unlike a bot token pasted per
 * workspace): it is entirely deployment-time environment variables shared
 * across the whole platform (server/services/channels/gmail/oauthConfig.ts).
 * This card is read-only — it tells an operator exactly which of those vars
 * is still missing, never a value, mirroring the secret-free contract of
 * GET /api/plugins/admin/gmail/env-status.
 */
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n';
import { adminPluginsApi } from '@/lib/plugins-api';

function EnvRow({ label, hint, ok }: { label: string; hint: string; ok: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-xs font-medium text-foreground">{label}</code>
          <Badge variant={ok ? 'default' : 'outline'} className="text-[10px]">
            {ok ? t('plugins.admin.gmailSetup.configured' as any) : t('plugins.admin.gmailSetup.missing' as any)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

export function GmailAdminSetupCard() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'plugins', 'gmail', 'env-status'],
    queryFn: () => adminPluginsApi.gmailEnvStatus(),
  });

  return (
    <Card className="space-y-1 p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('plugins.admin.gmailSetup.title' as any)}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('plugins.admin.gmailSetup.intro' as any)}</p>
      </div>

      {isLoading ? (
        <div className="space-y-2 pt-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          <div className="pt-2">
            <EnvRow
              label={t('plugins.admin.gmailSetup.googleOAuthClient.label' as any)}
              hint={t('plugins.admin.gmailSetup.googleOAuthClient.hint' as any)}
              ok={!!data?.googleOAuthClientConfigured}
            />
            <EnvRow
              label={t('plugins.admin.gmailSetup.gmailRedirectUri.label' as any)}
              hint={t('plugins.admin.gmailSetup.gmailRedirectUri.hint' as any)}
              ok={!!data?.gmailRedirectUriConfigured}
            />
            <EnvRow
              label={t('plugins.admin.gmailSetup.pubsubTopic.label' as any)}
              hint={t('plugins.admin.gmailSetup.pubsubTopic.hint' as any)}
              ok={!!data?.pubsubTopicConfigured}
            />
            <EnvRow
              label={t('plugins.admin.gmailSetup.pubsubPushAudience.label' as any)}
              hint={t('plugins.admin.gmailSetup.pubsubPushAudience.hint' as any)}
              ok={!!data?.pubsubPushAudienceConfigured}
            />
          </div>

          <div className="border-t border-border pt-3 text-xs">
            <p className={data?.fullyConfigured ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
              {data?.fullyConfigured
                ? t('plugins.admin.gmailSetup.allConfigured' as any)
                : t('plugins.admin.gmailSetup.someMissing' as any)}
            </p>
            <p className="mt-1 text-muted-foreground">{t('plugins.admin.gmailSetup.guideNote' as any)}</p>
          </div>
        </>
      )}
    </Card>
  );
}

export default GmailAdminSetupCard;
