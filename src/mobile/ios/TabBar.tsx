/**
 * NATIVE TAB BAR.
 *
 * A UIKit tab bar, not a web nav: a translucent 49pt strip pinned above the
 * home indicator with a hairline on top, 25pt glyphs over 10pt labels, and the
 * tint carrying the selection rather than a moving pill.
 *
 * Two behaviours people expect and notice the absence of:
 *  • Tapping the ALREADY selected tab scrolls that screen back to the top.
 *    The screen listens for `ios:scroll-to-top`, so the bar does not need a
 *    reference to it.
 *  • A selection haptic fires on a real tab change and never on a re-tap of
 *    the same tab.
 *
 * The bar lifts with the keyboard inset so it is never overlapped, and hides
 * entirely on a pushed detail screen — where iOS replaces it with the back
 * button and the screen's own toolbar.
 */
import { NavLink, useLocation } from 'react-router-dom';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

export interface TabItem {
  to: string;
  /** A lucide icon, whose own props type `strokeWidth` as string | number. */
  icon: React.ComponentType<{ className?: string; strokeWidth?: string | number }>;
  label: string;
  badge: number;
}

/** Screens listen for this to return to the top on a re-tap. */
export const SCROLL_TO_TOP_EVENT = 'ios:scroll-to-top';

export function TabBar({ tabs }: { tabs: TabItem[] }) {
  const location = useLocation();

  return (
    <nav
      className="relative z-30 shrink-0 border-t border-border/60 bg-card/80 backdrop-blur-2xl"
      style={{
        paddingBottom: 'calc(env(safe-area-inset-bottom) + var(--kb-inset, 0px))',
      }}
    >
      <div className="flex h-[49px] items-stretch">
        {tabs.map((tab) => {
          const active = location.pathname.startsWith(tab.to);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              onClick={(event) => {
                if (active) {
                  // Re-tapping the current tab must not push a duplicate
                  // history entry; it scrolls that screen to the top instead.
                  event.preventDefault();
                  window.dispatchEvent(new CustomEvent(SCROLL_TO_TOP_EVENT));
                  return;
                }
                // The link itself navigates; this only marks the change.
                haptic('selection');
              }}
              className={cn(
                'flex flex-1 select-none flex-col items-center justify-center gap-[3px] pt-1.5 transition-opacity active:opacity-60',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <span className="relative">
                <tab.icon className="h-[25px] w-[25px]" strokeWidth={active ? 2.2 : 1.8} />
                {tab.badge > 0 && (
                  <span className="absolute -end-2 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-destructive px-[4px] text-[10px] font-bold leading-none text-destructive-foreground ring-2 ring-card">
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </span>
                )}
              </span>
              <span className={cn('text-[10px] leading-none', active ? 'font-semibold' : 'font-medium')}>
                {tab.label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
