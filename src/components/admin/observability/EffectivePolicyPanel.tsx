/**
 * Phase 6C — Admin-visible snapshot of what handshake clients are receiving.
 * Read-only. Polls the operator handshake every 15s.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useEffectivePolicy } from '@/hooks/useEffectivePolicy';
import { Activity, Lock } from 'lucide-react';
import { useTranslation } from '@/i18n';

function bool(v: boolean, on = 'on', off = 'off') {
  return v ? (
    <Badge className="bg-warning/15 text-warning">{on}</Badge>
  ) : (
    <Badge variant="outline">{off}</Badge>
  );
}

export default function EffectivePolicyPanel() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const policy = useEffectivePolicy(workspace?.id);
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" /> {t('admin.system.policy.title' as any)}
        </CardTitle>
        <CardDescription>
          {t('admin.system.policy.description' as any)} <span className="font-mono">failover_epoch</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.system.policy.provider' as any)}</p>
            <p className="font-mono text-sm text-foreground">{policy.effective_provider}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.system.policy.epoch' as any)}</p>
            <p className="font-mono text-xs text-foreground">{policy.failover_epoch}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.system.policy.version' as any)}</p>
            <p className="font-mono text-xs text-foreground">{policy.policy_version}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.system.policy.backoff' as any)}</p>
            <p className="font-mono text-sm text-foreground">
              ×{policy.reconnect_backoff_multiplier}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('admin.system.policy.forcePolling' as any)}:</span>
          {bool(policy.force_polling, t('admin.system.policy.forced' as any), t('admin.system.policy.auto' as any))}
          <span className="text-xs text-muted-foreground ms-3">{t('admin.system.policy.typing' as any)}:</span>
          {bool(policy.typing_suppressed, t('admin.system.policy.suppressed' as any), t('admin.system.policy.allowed' as any))}
          <span className="text-xs text-muted-foreground ms-3">{t('admin.system.policy.degradedLabel' as any)}:</span>
          {bool(policy.degraded_mode, t('admin.common.yes' as any), t('admin.common.no' as any))}
          {policy.provider_locked && (
            <Badge variant="outline" className="ml-3 gap-1">
              <Lock className="h-3 w-3" /> {t('admin.system.policy.locked' as any)}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
