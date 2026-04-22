import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert } from 'lucide-react';
import { useSystemDegraded } from '@/hooks/useSystemDegraded';

/**
 * Phase 5C.1 — Surface the mark_system_degraded auto-action.
 * Purely informational. Does NOT block any feature.
 */
export default function SystemDegradedBanner() {
  const { isDegraded, triggerRule, expiresAt } = useSystemDegraded();
  if (!isDegraded) return null;
  return (
    <Card className="bg-warning/10 border-warning/40">
      <CardContent className="py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldAlert className="h-4 w-4 text-warning shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-warning">System marked as degraded</p>
            <p className="text-xs text-muted-foreground">
              Triggered by {triggerRule || 'critical alert'} · informational only — no
              functionality is blocked.
            </p>
          </div>
        </div>
        {expiresAt && (
          <Badge variant="outline" className="whitespace-nowrap">
            until {new Date(expiresAt).toLocaleTimeString()}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}