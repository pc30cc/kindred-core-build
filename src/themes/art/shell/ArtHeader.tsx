import { Link } from 'react-router-dom';
import { Search, Settings2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertsMenu } from '@/components/layout/AlertsMenu';
import { UserMenu } from '@/components/layout/UserMenu';
import { ArtPrimaryNav } from './ArtPrimaryNav';
import { ArtWorkspaceSwitcher } from './ArtWorkspaceSwitcher';
import { ArtLanguageMenu, ArtThemeToggle } from './ArtPreferences';
import type { ArtNav } from './useArtNav';
import { artIconButton } from './styles';
import { commandPaletteShortcut, openCommandPalette } from './commandPalette';

function Divider() {
  return <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-foreground/10" />;
}

/**
 * The Art panel's top bar: the workspace, the primary navigation as pills,
 * then search, preferences, alerts, settings and the account. On phones it
 * keeps only the workspace, search, alerts and the account; the rest is in
 * the drawer behind the bottom bar's "Menu".
 */
export function ArtHeader({ nav, compact, wide = false }: { nav: ArtNav; compact: boolean; wide?: boolean }) {
  const { t } = useTranslation();
  const searchLabel = t('common.quickSearch') || 'Quick search';

  // A round icon at every width: the bar's row is the page column's width
  // (theme.css; the window's on an edge-to-edge app), and the room is worth
  // more to the navigation pills. The shortcut is in the tooltip.
  const searchIcon = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-shell="search" aria-label={searchLabel} aria-keyshortcuts="Meta+K Control+K" onClick={openCommandPalette} className={artIconButton}>
          <Search />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        <span>{searchLabel}</span>
        {!compact && (
          <kbd dir="ltr" className="rounded-full bg-background/15 px-1.5 py-px font-sans text-[10.5px] font-medium opacity-80">
            {commandPaletteShortcut()}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );

  // AlertsMenu and UserMenu are the classic components; the wrappers let
  // theme.css fit them to this bar.
  const account = (
    <div data-shell="account" className="flex shrink-0 items-center">
      <UserMenu />
    </div>
  );
  const alerts = (
    <div data-shell="header-alerts" className="flex shrink-0 items-center">
      <AlertsMenu />
    </div>
  );

  if (compact) {
    return (
      <TooltipProvider delayDuration={250}>
        <header data-shell="header" className="relative z-30 flex h-14 shrink-0 items-center gap-0.5 ps-2 pe-2">
          <ArtWorkspaceSwitcher isWorkspaceAdmin={nav.isWorkspaceAdmin} className="me-auto" />
          {searchIcon}
          {alerts}
          {account}
        </header>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={250}>
      <header data-shell="header" data-row={wide ? 'wide' : 'page'} className="relative z-30 flex h-16 shrink-0 items-center gap-2 px-3 lg:px-5">
        <ArtWorkspaceSwitcher isWorkspaceAdmin={nav.isWorkspaceAdmin} className="max-w-[13rem] xl:max-w-[16rem]" />
        <Divider />
        <ArtPrimaryNav items={nav.primary} tools={nav.utility} superAdmin={nav.superAdmin} ready={nav.ready} />

        <div className="flex shrink-0 items-center gap-0.5">
          {searchIcon}
          <ArtLanguageMenu />
          <ArtThemeToggle />
          {alerts}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to={nav.settings.to}
                aria-label={t('nav.workspaceSettings') || 'Settings'}
                aria-current={nav.settings.active ? 'page' : undefined}
                className={cn(artIconButton, nav.settings.active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
              >
                <Settings2 />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('nav.workspaceSettings') || 'Settings'}</TooltipContent>
          </Tooltip>
          <Divider />
          {account}
        </div>
      </header>
    </TooltipProvider>
  );
}
