import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useOnlineVisitors } from '@/hooks/useVisitors';
import { Badge } from '@/components/ui/badge';
import { Eye, Globe, Monitor, Clock, MapPin, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function VisitorsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { data: visitors, isLoading } = useOnlineVisitors(workspace?.id);

  const statusColors: Record<string, string> = {
    online: 'bg-success/15 text-success border border-success/20',
    idle: 'bg-warning/15 text-warning border border-warning/20',
    offline: 'bg-muted text-muted-foreground',
  };
  const statusDots: Record<string, string> = {
    online: 'bg-success',
    idle: 'bg-warning',
    offline: 'bg-muted-foreground',
  };

  const onlineCount = visitors?.filter(v => v.status === 'online').length ?? 0;
  const idleCount = visitors?.filter(v => v.status === 'idle').length ?? 0;
  const totalCount = visitors?.length ?? 0;

  const statCards = [
    { label: t('visitors.online'), value: onlineCount, icon: Eye, color: 'text-success', bg: 'bg-success/10', pulse: true },
    { label: t('visitors.idle'), value: idleCount, icon: Clock, color: 'text-warning', bg: 'bg-warning/10' },
    { label: 'Total', value: totalCount, icon: Users, color: 'text-info', bg: 'bg-info/10' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="page-header">{t('visitors.title')}</h1>
        <p className="page-subtitle">Track real-time visitors on your website</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-3 gap-3">
        {statCards.map((stat) => (
          <div key={stat.label} className="stat-card">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${stat.bg}`}>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
              </div>
              {stat.pulse && <div className="h-2 w-2 rounded-full bg-success animate-pulse" />}
            </div>
            <div className="text-2xl font-bold text-foreground">{stat.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Visitor List */}
      <div className="card-elevated">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Active Sessions
          </h2>
          <span className="text-xs text-muted-foreground">{totalCount} visitors</span>
        </div>

        {isLoading ? (
          <div className="p-8 space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse flex items-center gap-3 px-5 py-3">
                <div className="w-8 h-8 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-muted rounded w-40" />
                  <div className="h-2.5 bg-muted rounded w-28" />
                </div>
              </div>
            ))}
          </div>
        ) : !visitors?.length ? (
          <div className="py-16 text-center">
            <Eye className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">{t('visitors.noVisitors')}</p>
            <p className="text-xs text-muted-foreground">Visitors will appear here when they browse your site</p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {visitors.map(v => (
              <div key={v.id} className="px-5 py-3.5 hover:bg-muted/30 transition-colors flex items-center gap-4">
                {/* Status indicator */}
                <div className="relative">
                  <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className={cn('absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card', statusDots[v.status])} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-foreground truncate">
                      {v.visitor_sessions?.browser || 'Unknown'} — {v.visitor_sessions?.device || 'Desktop'}
                    </span>
                    <Badge className={cn('text-[10px] px-1.5 py-0', statusColors[v.status])}>
                      {t(`visitors.${v.status}` as any)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {v.current_page && (
                      <span className="flex items-center gap-1 truncate max-w-[200px]">
                        <Globe className="w-3 h-3 shrink-0" />
                        {v.current_page || v.visitor_sessions?.current_page}
                      </span>
                    )}
                    {v.visitor_sessions?.referrer && (
                      <span className="flex items-center gap-1 truncate max-w-[150px]">
                        <MapPin className="w-3 h-3 shrink-0" />
                        {v.visitor_sessions.referrer}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
