import { useTheme } from 'next-themes';
import { Check, ChevronDown, Languages, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { cn } from '@/lib/utils';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { artIconButton, artMenuContent, artMenuItem, artMenuLabel } from './styles';

/**
 * The panel language, offered only where the platform's region allows more
 * than one (as in the classic top bar). `icon`: a round header button;
 * `row`: a labelled row for the phone drawer.
 */
export function ArtLanguageMenu({
  variant = 'icon',
  tipSide = 'bottom',
  menuSide,
}: {
  variant?: 'icon' | 'row';
  /** Where the icon's tooltip opens (the sidebar's rail: towards the page). */
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  /** Where the menu opens (the sidebar's foot: upwards or towards the page). */
  menuSide?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const { t, locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  if (!canSwitchLanguage) return null;

  const label = t('artShell.language');
  const trigger =
    variant === 'icon' ? (
      <button type="button" aria-label={label} className={artIconButton}>
        <Languages />
      </button>
    ) : (
      <button
        type="button"
        className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted/70 pe-3 ps-3.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-start">{LOCALE_CONFIG[locale].nativeLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    );

  return (
    <DropdownMenu>
      {variant === 'icon' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side={tipSide}>{label}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent side={menuSide} align="end" sideOffset={10} className={cn(artMenuContent, 'w-48')}>
        <DropdownMenuLabel className={artMenuLabel}>{label}</DropdownMenuLabel>
        {allowedLocales.map((l) => (
          <DropdownMenuItem key={l} onSelect={() => setLocale(l as Locale)} className={artMenuItem}>
            <span className="flex-1">{LOCALE_CONFIG[l].nativeLabel}</span>
            {l === locale && <Check className="!text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Light / dark, per user (next-themes), as in the classic top bar. */
export function ArtThemeToggle({ tipSide = 'bottom' }: { tipSide?: 'top' | 'bottom' | 'left' | 'right' } = {}) {
  const { t } = useI18n();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const isDark = (resolvedTheme ?? theme) === 'dark';
  const label = isDark ? t('nav.lightMode') : t('nav.darkMode');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={() => setTheme(isDark ? 'light' : 'dark')} className={artIconButton}>
          {isDark ? <Sun /> : <Moon />}
        </button>
      </TooltipTrigger>
      <TooltipContent side={tipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
