import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Shield } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ArtNavItem } from './useArtNav';
import { artCount, artMenuContent, artMenuItem } from './styles';

// Space between two pills (the row's gap-1).
const GAP = 4;

const pill =
  'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50';
const pillState = (active: boolean) =>
  active ? 'bg-primary/10 text-primary' : 'text-foreground/70 hover:bg-muted hover:text-foreground';

function Count({ value, className }: { value?: number; className?: string }) {
  if (!value || value <= 0) return null;
  return <span className={cn(artCount, 'bg-primary text-primary-foreground', className)}>{value > 99 ? '99+' : value}</span>;
}

// Words only, as in Lart's bar: a third more destinations fit than with
// icons, and the menus and the phone drawer keep the icons.
function PillBody({ item }: { item: ArtNavItem }) {
  return (
    <>
      <span>{item.label}</span>
      <Count value={item.badge} />
    </>
  );
}

/**
 * How many pills fit in `available` pixels, always the first ones in their
 * fixed order: the same destination keeps the same place on every page. The
 * rest go under "More", which wears the name of the open page when that page
 * is one of them (or a tool), so room is kept for the widest name it may
 * wear. Worked out from the widths alone, never from the open page, so
 * moving between pages never reshuffles the bar. Returns null when every
 * pill fits and nothing else needs "More".
 *
 * `widths[i]`: pill i; `asMore[i]`: "More" wearing pill i's name;
 * `moreMin`: "More" itself, or wearing a tool's name (the widest).
 */
function fitPills(widths: number[], asMore: number[], moreMin: number, available: number, keepMore: boolean) {
  const total = widths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, widths.length - 1);
  if (!keepMore && total <= available) return null;
  let reserve = moreMin;
  // The room kept for "More" only grows, so this settles in a few rounds.
  for (;;) {
    const budget = available - reserve - GAP;
    let used = 0;
    let count = 0;
    while (count < widths.length) {
      const w = widths[count] + (count ? GAP : 0);
      if (used + w > budget) break;
      used += w;
      count++;
    }
    const next = Math.max(reserve, ...asMore.slice(count));
    if (next <= reserve) return count;
    reserve = next;
  }
}

/**
 * The header's primary navigation: pills for as many destinations as the
 * width allows (measured, so it works the same in Persian, English and
 * Turkish), everything else under "More" with the workspace tools and the
 * way to Super Admin.
 */
export function ArtPrimaryNav({
  items,
  tools,
  superAdmin,
  ready,
}: {
  items: ArtNavItem[];
  /** Always in "More": the widget, plugins, ... */
  tools: ArtNavItem[];
  superAdmin: boolean;
  /** False while the plan is unknown: gated pills are still to come. */
  ready: boolean;
}) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  // How many pills are in view, in their order; null = all of them.
  const [inView, setInView] = useState<number | null>(null);

  const keepMore = tools.length > 0 || superAdmin;
  // A page that only lives under "More" (the widget, plugins): the trigger
  // then wears its name, so the bar still says where the member is.
  const activeTool = tools.find((item) => item.active);
  // What the measurements depend on (not which page is open).
  const signature = [...items, ...tools].map((item) => `${item.key}:${item.label}:${item.badge ?? 0}`).join('|');

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const compute = () => {
      const width = (selector: string) =>
        Array.from(measure.querySelectorAll<HTMLElement>(selector)).map((node) => node.getBoundingClientRect().width);
      const widths = width('[data-measure="pill"]');
      const asMore = width('[data-measure="as-more"]');
      const moreMin = Math.max(0, ...width('[data-measure="more"]'));
      const next = fitPills(widths, asMore, moreMin, nav.clientWidth, keepMore);
      setInView((prev) => (prev === next ? prev : next));
    };
    compute();
    // The row's own width, and the pills' (their web font arrives late).
    const observer = new ResizeObserver(compute);
    observer.observe(nav);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [signature, keepMore]);

  const visible = inView === null ? items : items.slice(0, inView);
  const folded = inView === null ? [] : items.slice(inView);
  const activeInMore = activeTool ?? folded.find((item) => item.active);
  const moreLabel = t('artShell.more');

  // "More", or the name of the page in it that is open.
  const moreBody = (current: ArtNavItem | undefined) =>
    current ? (
      <span className="max-w-[11rem] truncate">
        <span className="sr-only">{moreLabel}: </span>
        {current.label}
      </span>
    ) : (
      <span>{moreLabel}</span>
    );

  const menuRow = (item: ArtNavItem) => (
    <DropdownMenuItem
      key={item.key}
      asChild
      className={cn(artMenuItem, item.active && 'bg-primary/[0.08] text-primary [&>svg]:text-primary')}
    >
      <Link to={item.to} aria-current={item.active ? 'page' : undefined}>
        <item.icon />
        <span className="flex-1">{item.label}</span>
        <Count value={item.badge} />
      </Link>
    </DropdownMenuItem>
  );

  return (
    <nav
      ref={navRef}
      aria-label={t('artShell.primaryNav')}
      data-shell="primary-nav"
      className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
    >
      {visible.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          data-nav-item
          data-active={item.active}
          aria-current={item.active ? 'page' : undefined}
          className={cn(pill, pillState(item.active))}
        >
          <PillBody item={item} />
        </Link>
      ))}

      {!ready && <Skeleton aria-hidden className="h-9 w-24 shrink-0 rounded-full" />}

      {(folded.length > 0 || keepMore) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-active={!!activeInMore}
              className={cn(
                pill,
                pillState(!!activeInMore),
                'gap-1',
                !activeInMore && 'data-[state=open]:bg-muted data-[state=open]:text-foreground',
              )}
            >
              {moreBody(activeInMore)}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={10} className={cn(artMenuContent, 'w-60')}>
            {folded.map(menuRow)}
            {folded.length > 0 && keepMore && <DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-foreground/[0.07]" />}
            {tools.map(menuRow)}
            {superAdmin && (
              <DropdownMenuItem asChild className={cn(artMenuItem, 'text-primary [&>svg]:text-primary')}>
                <Link to="/admin">
                  <Shield />
                  <span>{t('admin.nav.title')}</span>
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* The same pills, unseen, to measure what fits: each pill, "More"
          wearing each pill's name, and "More" itself or wearing a tool's. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute start-0 top-0 flex w-max gap-1">
        {items.map((item) => (
          <span key={item.key} data-measure="pill" className={pill}>
            <PillBody item={item} />
          </span>
        ))}
        {items.map((item) => (
          <span key={item.key} data-measure="as-more" className={cn(pill, 'gap-1')}>
            {moreBody(item)}
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        ))}
        {[undefined, ...tools].map((item) => (
          <span key={item?.key ?? ''} data-measure="more" className={cn(pill, 'gap-1')}>
            {moreBody(item)}
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        ))}
      </div>
    </nav>
  );
}
