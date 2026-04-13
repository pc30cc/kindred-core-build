import { Badge } from '@/components/ui/badge';
import { CheckCircle, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import type { ProviderHealth } from '@/providers';

const config: Record<ProviderHealth, { icon: typeof CheckCircle; colors: string }> = {
  healthy: { icon: CheckCircle, colors: 'bg-emerald-900/50 text-emerald-300 border-emerald-700' },
  degraded: { icon: AlertTriangle, colors: 'bg-amber-900/50 text-amber-300 border-amber-700' },
  down: { icon: XCircle, colors: 'bg-red-900/50 text-red-300 border-red-700' },
  unknown: { icon: HelpCircle, colors: 'bg-muted text-muted-foreground border-border' },
};

export function ProviderHealthBadge({ health }: { health: ProviderHealth }) {
  const { icon: Icon, colors } = config[health];
  return (
    <Badge variant="outline" className={`gap-1 ${colors}`}>
      <Icon className="h-3 w-3" />
      {health.charAt(0).toUpperCase() + health.slice(1)}
    </Badge>
  );
}
