/**
 * Operational alerts bell.
 *
 * Shows only actionable platform conditions (plan, quota, billing, account
 * verification) — conversation activity stays in the Inbox tabs so the two
 * surfaces never duplicate each other.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, CircleAlert, Info, ShieldCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceAlerts } from '@/hooks/useWorkspaceAlerts';
import type { AlertSeverity, WorkspaceAlert } from '@/lib/workspace-alerts-api';
import { cn } from '@/lib/utils';

const SEVERITY_STYLE: Record<AlertSeverity, { icon: typeof Info; wrap: string; dot: string }> = {
  critical: {
    icon: CircleAlert,
    wrap: 'bg-destructive/10 text-destructive border-destructive/25',
    dot: 'bg-destructive',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'bg-amber-500/10 text-amber-600 border-amber-500/25 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  info: {
    icon: Info,
    wrap: 'bg-primary/10 text-primary border-primary/25',
    dot: 'bg-primary',
  },
};

export function AlertsMenu() {
  const { t: tRaw, dir } = useI18n();
  const t = tRaw as unknown as (key: string, params?: Record<string, string>) => string;
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useWorkspaceAlerts(workspace?.id);

  const alerts = useMemo(() => (Array.isArray(data?.alerts) ? data!.alerts : []), [data]);
  const total = alerts.length;
  const hasCritical = alerts.some((a) => a.severity === 'critical');
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const describe = (a: WorkspaceAlert) => {
    const params: Record<string, string> = { ...(a.params || {}) };
    if (params.limit) params.limit = t(`alerts.limit.${params.limit}`);
    return {
      title: t(`alerts.kind.${a.kind}.title`, params),
      desc: t(`alerts.kind.${a.kind}.desc`, params),
    };
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('nav.viewAlerts')}
              className="relative h-10 w-10 rounded-2xl [&_svg]:size-7 border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
            >
              <Bell />
              {total > 0 && (
                <span
                  className={cn(
                    'absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold text-primary-foreground ring-2 ring-background',
                    hasCritical ? 'bg-destructive' : 'bg-amber-500',
                  )}
                >
                  {total > 9 ? '9+' : total}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('nav.viewAlerts')}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        dir={dir}
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-4 py-3">
          <div className="text-sm font-semibold">{t('alerts.title')}</div>
          <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
            {total}
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4" dir={dir}>
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </div>
        ) : total === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-6 w-6" />
            </span>
            <p className="text-sm font-medium">{t('alerts.empty.title')}</p>
            <p className="text-xs text-muted-foreground">{t('alerts.empty.desc')}</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[22rem]">
            <ul className="divide-y divide-border/50">
              {alerts.map((a) => {
                const style = SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.info;
                const Icon = style.icon;
                const { title, desc } = describe(a);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      disabled={!a.action}
                      onClick={() => a.action && navigate(wsPath(a.action))}
                      className="flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                          style.wrap,
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{title}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {desc}
                        </span>
                      </span>
                      {a.action && (
                        <Chevron className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-center text-xs"
            onClick={() => navigate(wsPath('/settings/notifications'))}
          >
            {t('alerts.settings')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}