import { useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { Moon, Sun, Bell, LifeBuoy, Settings2, Sparkles } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';

/** Maps the first workspace-scoped path segment to an existing nav.* i18n key. */
const SEGMENT_KEYS: Record<string, string> = {
  inbox: 'nav.inbox',
  visitors: 'nav.visitors',
  contacts: 'nav.contacts',
  'ai-agent': 'nav.aiAgent',
  'call-center': 'nav.callCenter',
  'knowledge-base': 'nav.knowledgeBase',
  reports: 'nav.reports',
  billing: 'nav.billing',
  settings: 'nav.settings',
};

/**
 * Slim, sticky toolbar pinned to the top of the workspace shell.
 * Purely presentational: page context on the lead side, quick utilities
 * (theme, language, alerts, help, account) on the trailing side.
 */
export function AppTopBar() {
  const { t: tRaw, locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const t = tRaw as unknown as (key: string) => string;
  const { user } = useAuth();
  const { workspace } = useActiveWorkspace();
  const { theme, setTheme } = useTheme();
  const { pathname } = useLocation();
  const wsPath = useWorkspacePath();

  const pageTitle = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('w');
    const segment = idx >= 0 ? parts[idx + 2] : parts[1];
    const key = segment ? SEGMENT_KEYS[segment] : undefined;
    return key ? t(key) : '';
  }, [pathname, t]);

  const userName =
    (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const avatarUrl = (user?.metadata?.avatar_url as string) || undefined;
  const isDark = theme === 'dark';

  return (
    <TooltipProvider delayDuration={200}>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        {/* Context */}
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/15">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-semibold text-foreground">
              {pageTitle || workspace?.name || ''}
            </p>
            {workspace?.name && pageTitle ? (
              <p className="truncate text-[11px] text-muted-foreground">{workspace.name}</p>
            ) : null}
          </div>
        </div>

        <div className="flex-1" />

        {/* Utilities */}
        <div className="flex items-center gap-1.5">
          {canSwitchLanguage && (
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-8 w-[104px] border-border/60 bg-muted/40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {allowedLocales.map((l) => (
                <SelectItem key={l} value={l} className="text-xs">
                  {LOCALE_CONFIG[l].nativeLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setTheme(isDark ? 'light' : 'dark')}
                aria-label="theme"
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.theme') || 'Theme'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
              >
                <Link to={wsPath('/settings/notifications')} aria-label="alerts">
                  <Bell className="h-4 w-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.viewAlerts') || 'Alerts'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
              >
                <Link to={wsPath('/settings')} aria-label="settings">
                  <Settings2 className="h-4 w-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('nav.workspaceSettings') || 'Settings'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="hidden h-8 w-8 text-muted-foreground hover:text-foreground sm:inline-flex"
              >
                <Link to={wsPath('/knowledge-base')} aria-label="help">
                  <LifeBuoy className="h-4 w-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.getHelp') || 'Help'}</TooltipContent>
          </Tooltip>

          <span className="mx-1 hidden h-5 w-px bg-border/70 sm:block" />

          <Link
            to={wsPath('/settings/profile')}
            className="flex items-center gap-2 rounded-full py-1 ps-1 pe-2.5 transition-colors hover:bg-muted/60"
          >
            <Avatar className="h-7 w-7">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={userName} /> : null}
              <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
                {userName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-[140px] truncate text-xs font-medium text-foreground md:block">
              {userName}
            </span>
          </Link>
        </div>
      </header>
    </TooltipProvider>
  );
}