import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckCircle, AlertTriangle, XCircle, HelpCircle, Clock } from 'lucide-react';
import type { ProviderHealth } from '@/providers';

const config: Record<ProviderHealth, { icon: typeof CheckCircle; label: string; colors: string }> = {
  healthy: { icon: CheckCircle, label: 'Healthy', colors: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  degraded: { icon: AlertTriangle, label: 'Degraded', colors: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  down: { icon: XCircle, label: 'Down', colors: 'bg-destructive/15 text-destructive border-destructive/30' },
  unknown: { icon: HelpCircle, label: 'Unknown', colors: 'bg-muted text-muted-foreground border-border' },
};

interface Props {
  health: ProviderHealth;
  checkedAt?: number;
  compact?: boolean;
}

export function ProviderHealthBadge({ health, checkedAt, compact }: Props) {
  const { icon: Icon, label, colors } = config[health];

  const badge = (
    <Badge variant="outline" className={`gap-1 text-[10px] ${colors}`}>
      <Icon className="h-3 w-3" />
      {!compact && label}
    </Badge>
  );

  if (!checkedAt) return badge;

  const ago = Math.round((Date.now() - checkedAt) / 1000);
  const timeStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="text-xs flex items-center gap-1">
        <Clock className="h-3 w-3" />
        Last checked: {timeStr}
      </TooltipContent>
    </Tooltip>
  );
}

/** Inline dot indicator for compact health display */
export function ProviderHealthDot({ health }: { health: ProviderHealth }) {
  const dotColors: Record<ProviderHealth, string> = {
    healthy: 'bg-emerald-400',
    degraded: 'bg-amber-400',
    down: 'bg-destructive',
    unknown: 'bg-muted-foreground',
  };
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className={`inline-block h-2 w-2 rounded-full ${dotColors[health]}`} />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs capitalize">{health}</TooltipContent>
    </Tooltip>
  );
}
