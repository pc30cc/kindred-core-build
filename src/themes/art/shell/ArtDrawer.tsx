import { Link } from 'react-router-dom';
import { Search, Shield } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ArtWorkspaceSwitcher } from './ArtWorkspaceSwitcher';
import { ArtLanguageMenu, ArtThemeToggle } from './ArtPreferences';
import type { ArtNav, ArtNavItem } from './useArtNav';
import { artCount } from './styles';
import { openCommandPalette } from './commandPalette';

function Row({ item, onNavigate }: { item: ArtNavItem; onNavigate: () => void }) {
  const Icon = item.icon;
  const count = item.badge ?? 0;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      data-nav-item
      data-active={item.active}
      aria-current={item.active ? 'page' : undefined}
      className={cn(
        'flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors',
        item.active ? 'bg-primary/10 text-primary' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className={cn('h-[18px] w-[18px] shrink-0', !item.active && 'text-muted-foreground')} strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {count > 0 && <span className={cn(artCount, 'bg-primary text-primary-foreground')}>{count > 99 ? '99+' : count}</span>}
    </Link>
  );
}

/**
 * The phone's full menu, behind the bottom bar's "Menu": every destination
 * the header offers on a desktop, then the preferences. It slides in from
 * the reading start side and closes on every navigation.
 */
export function ArtDrawer({ nav, open, onOpenChange }: { nav: ArtNav; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, dir } = useTranslation();
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={dir === 'rtl' ? 'right' : 'left'}
        data-shell="drawer"
        className="flex w-[304px] flex-col gap-0 p-0 sm:max-w-[304px]"
      >
        <SheetTitle className="sr-only">{t('nav.menu')}</SheetTitle>
        <TooltipProvider delayDuration={250}>
          <div className="px-3 pb-2 pe-12 pt-3">
            <ArtWorkspaceSwitcher isWorkspaceAdmin={nav.isWorkspaceAdmin} className="max-w-full" />
          </div>

          <div className="px-4 pb-2">
            <button
              type="button"
              onClick={() => {
                close();
                openCommandPalette();
              }}
              className="flex h-11 w-full items-center gap-2.5 rounded-full bg-muted/70 px-4 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span>{t('common.quickSearch') || 'Quick search'}</span>
            </button>
          </div>

          <nav aria-label={t('artShell.primaryNav')} className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
            {nav.primary.map((item) => (
              <Row key={item.key} item={item} onNavigate={close} />
            ))}
            <div aria-hidden className="mx-3 my-2.5 h-px bg-foreground/[0.07]" />
            {[...nav.utility, nav.settings].map((item) => (
              <Row key={item.key} item={item} onNavigate={close} />
            ))}
            {nav.superAdmin && (
              <Link
                to="/admin"
                onClick={close}
                className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-primary transition-colors hover:bg-primary/[0.07]"
              >
                <Shield className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
                <span>Super Admin</span>
              </Link>
            )}
          </nav>

          <div className="flex items-center gap-2 border-t border-foreground/[0.07] px-4 py-3">
            <ArtLanguageMenu variant="row" />
            <ArtThemeToggle />
          </div>
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
