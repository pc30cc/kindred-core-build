/**
 * Phase 6C — Admin-visible snapshot of what handshake clients are receiving.
 * Read-only. Polls the operator handshake every 15s.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useEffectivePolicy } from '@/hooks/useEffectivePolicy';
import { Activity, Lock } from 'lucide-react';

function bool(v: boolean, on = 'on', off = 'off') {
  return v ? (
    <Badge className="bg-warning/15 text-warning">{on}</Badge>
  ) : (
    <Badge variant="outline">{off}</Badge>
  );
}

export default function EffectivePolicyPanel() {
  const { workspace } = useWorkspace();
  const policy = useEffectivePolicy(workspace?.id);
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-foreground text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" /> Client effective policy
        </CardTitle>
        <CardDescription>
          Snapshot embedded in operator + widget handshakes. Clients reset transport on
          <span className="font-mono"> failover_epoch</span> change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Effective provider</p>
            <p className="font-mono text-sm text-foreground">{policy.effective_provider}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Failover epoch</p>
            <p className="font-mono text-xs text-foreground">{policy.failover_epoch}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Policy version</p>
            <p className="font-mono text-xs text-foreground">{policy.policy_version}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Backoff multiplier</p>
            <p className="font-mono text-sm text-foreground">
              ×{policy.reconnect_backoff_multiplier}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Force polling:</span>
          {bool(policy.force_polling, 'forced', 'auto')}
          <span className="text-xs text-muted-foreground ml-3">Typing suppressed:</span>
          {bool(policy.typing_suppressed, 'suppressed', 'allowed')}
          <span className="text-xs text-muted-foreground ml-3">Degraded:</span>
          {bool(policy.degraded_mode, 'yes', 'no')}
          {policy.provider_locked && (
            <Badge variant="outline" className="ml-3 gap-1">
              <Lock className="h-3 w-3" /> locked
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}