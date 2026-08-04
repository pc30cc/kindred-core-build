/**
 * Operational alerts drawer.
 *
 * Shows only actionable platform conditions (plan, quota, billing, account
 * verification) — conversation activity stays in the Inbox tabs so the two
 * surfaces never duplicate each other.
 *
 * Opens as a side sheet: from the left in RTL, from the right in LTR, matching
 * the side the bell sits on in the top bar.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  AlertTriangle,
  CircleAlert,
  Info,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Check,
  CheckCheck,
  Lock,
  X,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceAlerts, useDismissWorkspaceAlerts } from '@/hooks/useWorkspaceAlerts';
import type { AlertSeverity, WorkspaceAlert } from '@/lib/workspace-alerts-api';
import { cn } from '@/lib/utils';

const SEVERITY_STYLE: Record<AlertSeverity, { icon: typeof Info; wrap: string; rail: string }> = {
  critical: {
    icon: CircleAlert,
    wrap: 'bg-destructive/10 text-destructive border-destructive/25',
    rail: 'bg-destructive',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'bg-amber-500/10 text-amber-600 border-amber-500/25 dark:text-amber-400',
    rail: 'bg-amber-500',
  },
  info: {
    icon: Info,
    wrap: 'bg-primary/10 text-primary border-primary/25',
    rail: 'bg-primary',
  },
};

export function AlertsMenu() {
  const { t: tRaw, dir } = useI18n();
  const t = tRaw as unknown as (key: string, params?: Record<string, string>) => string;
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const { workspace } = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useWorkspaceAlerts(workspace?.id);
  const dismiss = useDismissWorkspaceAlerts(workspace?.id);

  const alerts = useMemo(() => (Array.isArray(data?.alerts) ? data!.alerts : []), [data]);
  const total = alerts.length;
  const hasCritical = alerts.some((a) => a.severity === 'critical');
  const dismissableCount = alerts.filter((a) => a.dismissible).length;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  const describe = (a: WorkspaceAlert) => {
    const params: Record<string, string> = { ...(a.params || {}) };
    if (params.limit) params.limit = t(`alerts.limit.${params.limit}`);
    return {
      title: t(`alerts.kind.${a.kind}.title`, params),
      desc: t(`alerts.kind.${a.kind}.desc`, params),
    };
  };

  const go = (a: WorkspaceAlert) => {
    if (!a.action) return;
    setOpen(false);
    navigate(wsPath(a.action));
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
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
                    'absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white shadow',
                    hasCritical ? 'bg-destructive' : 'bg-amber-500',
                  )}
                >
                  {total > 9 ? '9+' : total}
                </span>
              )}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('nav.viewAlerts')}</TooltipContent>
      </Tooltip>

      <SheetContent
        side={dir === 'rtl' ? 'left' : 'right'}
        dir={dir}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md [&>button.absolute]:hidden"
      >
        {/* Header */}
        <div className="border-b border-border/60 bg-gradient-to-b from-muted/50 to-background px-5 py-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-2xl border',
                hasCritical
                  ? 'border-destructive/25 bg-destructive/10 text-destructive'
                  : 'border-border/60 bg-muted/50 text-muted-foreground',
              )}
            >
              <Bell className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold leading-tight">{t('alerts.title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {total > 0 ? t('alerts.subtitle', { count: String(total) }) : t('alerts.empty.title')}
              </p>
            </div>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('common.close')}
                className="h-10 w-10 shrink-0 rounded-2xl border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </Button>
            </SheetClose>
          </div>

          {dismissableCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate({ all: true })}
              className="mt-3 h-8 w-full gap-1.5 rounded-xl text-xs"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {t('alerts.markAllRead')}
            </Button>
          )}
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="space-y-2 p-5" dir={dir}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted/60" />
            ))}
          </div>
        ) : total === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-8 w-8" />
            </span>
            <p className="text-sm font-medium">{t('alerts.empty.title')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('alerts.empty.desc')}</p>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <ul className="space-y-2.5 p-4">
              {alerts.map((a) => {
                const style = SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.info;
                const Icon = style.icon;
                const { title, desc } = describe(a);
                return (
                  <li
                    key={a.id}
                    className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card/60 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <span className={cn('absolute inset-y-0 start-0 w-1', style.rail)} />
                    <div className="flex items-start gap-3 p-3.5 ps-4">
                      <span
                        className={cn(
                          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                          style.wrap,
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug">{title}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>

                        <div className="mt-2.5 flex items-center gap-2">
                          {a.action && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => go(a)}
                              className="h-7 gap-1 rounded-lg px-2.5 text-xs"
                            >
                              {t('alerts.review')}
                              <Chevron className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {a.dismissible ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={dismiss.isPending}
                              onClick={() => dismiss.mutate({ alertId: a.id })}
                              className="h-7 gap-1 rounded-lg px-2.5 text-xs text-muted-foreground"
                            >
                              <Check className="h-3.5 w-3.5" />
                              {t('alerts.markRead')}
                            </Button>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Lock className="h-3 w-3" />
                              {t('alerts.notDismissible')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        {/* Footer */}
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-center text-xs"
            onClick={() => {
              setOpen(false);
              navigate(wsPath('/settings/notifications'));
            }}
          >
            {t('alerts.settings')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
