import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert } from 'lucide-react';
import { useSystemDegraded } from '@/hooks/useSystemDegraded';
import { useTranslation } from '@/i18n';

/**
 * Phase 5C.1 — Surface the mark_system_degraded auto-action.
 * Purely informational. Does NOT block any feature.
 */
export default function SystemDegradedBanner() {
  const { t } = useTranslation();
  const { isDegraded, triggerRule, expiresAt } = useSystemDegraded();
  if (!isDegraded) return null;
  return (
    <Card className="bg-warning/10 border-warning/40">
      <CardContent className="py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert className="h-4 w-4 text-warning shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-warning">{t('admin.system.degraded.title' as any)}</p>
            <p className="text-xs text-muted-foreground">
              {t('admin.system.degraded.description' as any, { trigger: triggerRule || t('admin.system.degraded.criticalAlert' as any) })}
            </p>
          </div>
        </div>
        {expiresAt && (
          <Badge variant="outline" className="whitespace-nowrap">
            {t('admin.system.degraded.until' as any)} {new Date(expiresAt).toLocaleTimeString()}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
