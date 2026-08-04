import { useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useTheme } from 'next-themes';
import { Moon, Sun, Bell, LifeBuoy, Settings2, Sparkles, Search } from 'lucide-react';
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
import { useWorkspacePlan } from '@/hooks/usePlans';
import { UserAccountMenu } from '@/components/layout/UserAccountMenu';

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
  const { data: planData } = useWorkspacePlan(workspace?.id);

  const planLocalized = (planData?.plan?.localized || {}) as Record<string, { name?: string }>;
  const planName =
    planLocalized[locale]?.name?.trim() ||
    planLocalized['en']?.name?.trim() ||
    planData?.plan?.name ||
    '';
  const trialEnd =
    (planData?.subscription as any)?.trial_ends_at ||
    (planData?.subscription as any)?.current_period_end ||
    null;
  const trialDaysLeft = useMemo(() => {
    if (!trialEnd || (planData?.subscription as any)?.status !== 'trialing') return null;
    const diff = new Date(trialEnd).getTime() - Date.now();
    return diff > 0 ? Math.ceil(diff / 86_400_000) : 0;
  }, [trialEnd, planData]);

  const pageTitle = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('w');
    const segment = idx >= 0 ? parts[idx + 2] : parts[1];
    const key = segment ? SEGMENT_KEYS[segment] : undefined;
    return key ? t(key) : '';
  }, [pathname, t]);

  const userName =
    (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';
  const avatarUrl = (user?.metadata?.avatar_url as string) || undefined;
  const isDark = theme === 'dark';

  return (
    <TooltipProvider delayDuration={200}>
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/55">
        {/* Accent hairline */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

        {/* Context */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/25 via-primary/10 to-transparent text-primary shadow-sm ring-1 ring-primary/20">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight text-foreground">
              {pageTitle || workspace?.name || ''}
            </p>
            {workspace?.name && pageTitle ? (
              <p className="truncate text-[11px] text-muted-foreground">{workspace.name}</p>
            ) : null}
          </div>
        </div>

        <div className="flex-1" />

        {/* Plan / trial badge */}
        {planName ? (
          <Link
            to={wsPath('/billing')}
            className="hidden items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary shadow-sm transition-colors hover:bg-primary/10 lg:flex"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="max-w-[120px] truncate">{planName}</span>
            {trialDaysLeft !== null && (
              <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold">
                {trialDaysLeft} {t('common.days') || ''}
              </span>
            )}
          </Link>
        ) : null}

        {/* Global quick search — opens the Cmd/Ctrl+K palette */}
        <button
          type="button"
          onClick={() =>
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
            )
          }
          className="hidden w-[240px] items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground shadow-sm transition-all hover:border-primary/40 hover:bg-muted hover:text-foreground md:flex lg:w-[300px]"
        >
          <Search className="h-3.5 w-3.5" />
          <span>{t('common.quickSearch') || 'Quick search'}</span>
          <kbd className="ms-auto rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-sans text-[10px]">
            ⌘K
          </kbd>
        </button>

        {/* Utilities */}
        <div className="flex items-center gap-1.5">
          {canSwitchLanguage && (
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-9 w-[108px] rounded-xl border-border/60 bg-muted/40 text-xs">
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
                className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
                className="relative h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <Link to={wsPath('/settings/notifications')} aria-label="alerts">
                  <Bell className="h-4 w-4" />
                  <span className="absolute end-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" />
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
                className="h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
                className="hidden h-9 w-9 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:inline-flex"
              >
                <Link to={wsPath('/knowledge-base')} aria-label="help">
                  <LifeBuoy className="h-4 w-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.getHelp') || 'Help'}</TooltipContent>
          </Tooltip>

          <span className="mx-1 hidden h-5 w-px bg-border/70 sm:block" />

          <UserAccountMenu />
        </div>
      </header>
    </TooltipProvider>
  );
}