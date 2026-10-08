import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ArtNav, ArtQueueItem } from './useArtNav';
import { artCount, artMenuContent, artMenuItem } from './styles';
import { useScrollFade } from './strips';

/** Whether `ref`'s element has children; pages portal into it at any time. */
function useHasChildren(ref: React.RefObject<HTMLElement>) {
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setFilled(el.childElementCount > 0);
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, [ref]);
  return filled;
}

/**
 * A view's count: the needs-human count is the same clay circle as on the
 * header's Inbox pill and the phone's tab bar; other counts stay quiet.
 */
function QueueCount({ item, active = item.active }: { item: ArtQueueItem; active?: boolean }) {
  const count = item.badge ?? 0;
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        artCount,
        item.tone === 'urgent'
          ? 'bg-primary text-primary-foreground'
          : active
            ? 'bg-primary/15 text-primary'
            : 'bg-foreground/[0.08] text-foreground/70',
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

const queuePill =
  'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50';
const queuePillState = (active: boolean) =>
  active ? 'bg-primary/10 text-primary' : 'text-foreground/70 hover:bg-muted hover:text-foreground';

/** One view of the inbox, in the header's pill language: 36px, the current one on a clay tint. */
function QueuePill({ item }: { item: ArtQueueItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      data-nav-item
      data-active={item.active}
      aria-current={item.active ? 'page' : undefined}
      className={cn(queuePill, queuePillState(item.active))}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
      <span>{item.label}</span>
      <QueueCount item={item} />
    </Link>
  );
}

/**
 * The inbox's views on a phone, where the page's own tabs already fill the
 * row: one pill that never scrolls away, "More" or the name of the open
 * view, carrying the needs-human count, with every view in its menu.
 */
function QueueMenu({ queues }: { queues: ArtQueueItem[] }) {
  const { t } = useTranslation();
  const current = queues.find((item) => item.active);
  const urgent = queues.find((item) => item.tone === 'urgent' && (item.badge ?? 0) > 0);
  // The needs-human count stays in sight whatever view is open: on the pill
  // itself, or as a clay dot beside the open view's own count.
  const urgentElsewhere = urgent && current && urgent.key !== current.key ? urgent : undefined;
  const moreLabel = t('artShell.more');
  const CurrentIcon = current?.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-shell="context-views"
          data-active={!!current}
          aria-label={[
            `${t('artShell.inboxViews')}: ${current?.label ?? moreLabel}`,
            ...(urgent && urgent !== current ? [`${urgent.label} ${urgent.badge}`] : []),
          ].join(' · ')}
          className={cn(queuePill, queuePillState(!!current), 'gap-1 px-3', !current && 'data-[state=open]:bg-muted data-[state=open]:text-foreground')}
        >
          {CurrentIcon && <CurrentIcon className="h-4 w-4 shrink-0" strokeWidth={2} />}
          <span className="max-w-[8.5rem] truncate">{current?.label ?? moreLabel}</span>
          {current ? <QueueCount item={current} /> : urgent && <QueueCount item={urgent} />}
          {urgentElsewhere && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className={cn(artMenuContent, 'w-60')}>
        {queues.map((item, i) => (
          <Fragment key={item.key}>
            {i > 0 && queues[i - 1].group !== item.group && <DropdownMenuSeparator className="-mx-1.5 my-1.5 bg-foreground/[0.07]" />}
            <DropdownMenuItem
              asChild
              className={cn(artMenuItem, item.active && 'bg-primary/[0.08] text-primary [&>svg]:text-primary')}
            >
              <Link to={item.to} aria-current={item.active ? 'page' : undefined}>
                <item.icon />
                <span className="flex-1">{item.label}</span>
                <QueueCount item={item} active={false} />
              </Link>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The bar under the header. On the inbox it carries the inbox's views (the
 * classic sidebar's inbox sub-items: status queues, the internal inbox and
 * one inbox per channel). It also holds #topbar-page-slot, where a page can
 * portal its own toolbar (InboxPage's ToolbarPortal does). Hidden while it has
 * nothing to show; the slot stays in the document either way.
 */
export function ArtContextBar({ nav, compact }: { nav: ArtNav; compact: boolean }) {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<HTMLElement>(null);
  const slotFilled = useHasChildren(slotRef);
  const queues = nav.queues;
  const visible = queues.length > 0 || slotFilled;
  // Fade the edge that hides more: the page's toolbar on a phone (the views
  // are one pill there), the views on a desktop.
  useScrollFade(slotRef, visible && compact);
  useScrollFade(viewsRef, visible && !compact && queues.length > 0);

  return (
    <div
      data-shell="context-bar"
      className={cn(
        visible ? 'flex' : 'hidden',
        'relative z-20 h-12 shrink-0 items-stretch gap-3 pe-3 lg:pe-5',
        compact && 'items-center gap-2',
        compact && !slotFilled && 'ps-3',
      )}
    >
      {/* The page's toolbar first: Inbox sizes its tabs to its list column.
          On a phone it scrolls sideways on its own, beside the views' pill. */}
      <div
        ref={slotRef}
        id="topbar-page-slot"
        className={cn(
          'relative z-10 flex min-w-0 items-stretch',
          compact ? cn('scrollbar-hide h-full overflow-x-auto overflow-y-hidden', slotFilled && 'flex-1') : 'shrink-0',
        )}
      />
      {queues.length > 0 && compact && (
        <>
          {slotFilled && <span aria-hidden className="h-4 w-px shrink-0 bg-foreground/10" />}
          <QueueMenu queues={queues} />
        </>
      )}
      {queues.length > 0 && !compact && (
        <nav
          ref={viewsRef}
          aria-label={t('artShell.inboxViews')}
          className={cn('scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto', !slotFilled && 'ps-3 lg:ps-5')}
        >
          {slotFilled && <span aria-hidden className="me-1.5 h-4 w-px shrink-0 bg-foreground/10" />}
          {queues.map((item, i) => (
            <Fragment key={item.key}>
              {i > 0 && queues[i - 1].group !== item.group && (
                <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-foreground/10" />
              )}
              <QueuePill item={item} />
            </Fragment>
          ))}
        </nav>
      )}
    </div>
  );
}
