import { Link, useLocation } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { Moon, Sun, Bell, LifeBuoy, Settings2, Search } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import { UserMenu } from '@/components/layout/UserMenu';

/**
 * Slim, sticky toolbar pinned to the top of the workspace shell.
 * Utilities are grouped into clearly separated clusters:
 * search | preferences | workspace shortcuts | account.
 */
export function AppTopBar() {
  const { t: tRaw, locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const t = tRaw as unknown as (key: string) => string;
  const { theme, setTheme } = useTheme();
  const wsPath = useWorkspacePath();
  const location = useLocation();
  const isInbox = /\/inbox(\/|$|\?)/.test(location.pathname);

  const isDark = theme === 'dark';

  return (
    <TooltipProvider delayDuration={200}>
      <header className="sticky top-0 z-30 flex h-[60px] shrink-0 items-center gap-4 border-b border-border/60 bg-background/70 px-5 backdrop-blur-xl supports-[backdrop-filter]:bg-background/55">
        {/* Accent hairline */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

        {/* Group 1 — Search (hidden on Inbox, where the toolbar hosts filter tabs) */}
        {!isInbox && (
        <button
          type="button"
          onClick={() =>
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
            )
          }
          className="hidden w-[280px] items-center gap-2.5 rounded-2xl border border-border/60 bg-muted/40 px-4 py-2 text-sm text-muted-foreground shadow-sm transition-all hover:border-primary/40 hover:bg-muted hover:text-foreground md:flex lg:w-[380px]"
        >
          <Search className="h-7 w-7" />
          <span>{t('common.quickSearch') || 'Quick search'}</span>
          <kbd className="ms-auto rounded-md border border-border/70 bg-background px-2 py-0.5 font-sans text-[11px]">
            ⌘K
          </kbd>
        </button>
        )}

        {/* Page-owned toolbar slot (e.g. Inbox filter tabs) */}
        <div
          id="topbar-page-slot"
          className="flex h-full min-w-0 flex-1 items-end overflow-x-auto overflow-y-visible scrollbar-hide"
        />

        {/* Group 2 — Preferences: language + theme */}
        <div className="flex items-center gap-2">
          {canSwitchLanguage && (
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
              <SelectTrigger className="h-10 w-[126px] rounded-2xl border-border/60 bg-muted/40 text-sm shadow-sm focus:ring-0">
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
                className="h-10 w-10 rounded-2xl [&_svg]:size-7 border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
                onClick={() => setTheme(isDark ? 'light' : 'dark')}
                aria-label={isDark ? t('nav.lightMode') : t('nav.darkMode')}
              >
                 {isDark ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isDark ? t('nav.lightMode') : t('nav.darkMode')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Group 3 — Workspace shortcuts */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="relative h-10 w-10 rounded-2xl [&_svg]:size-7 border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
              >
                <Link to={wsPath('/settings/notifications')} aria-label="alerts">
                   <Bell />
                  <span className="absolute end-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
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
                className="h-10 w-10 rounded-2xl [&_svg]:size-7 border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
              >
                <Link to={wsPath('/settings')} aria-label="settings">
                   <Settings2 />
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
                className="hidden h-10 w-10 rounded-2xl [&_svg]:size-7 border border-border/60 bg-muted/40 text-muted-foreground shadow-sm hover:border-primary/40 hover:bg-background hover:text-foreground sm:inline-flex"
              >
                <Link to={wsPath('/knowledge-base')} aria-label="help">
                   <LifeBuoy />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.getHelp') || 'Help'}</TooltipContent>
          </Tooltip>
        </div>

        {/* Group 4 — Account */}
        <UserMenu />
      </header>
    </TooltipProvider>
  );
}
