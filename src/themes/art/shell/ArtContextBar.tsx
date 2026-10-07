import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ArtNav, ArtQueueItem } from './useArtNav';
import { artCount } from './styles';

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

function QueuePill({ item }: { item: ArtQueueItem }) {
  const Icon = item.icon;
  const count = item.badge ?? 0;
  return (
    <Link
      to={item.to}
      data-nav-item
      data-active={item.active}
      aria-current={item.active ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
        item.active
          ? 'bg-card text-foreground shadow-[0_1px_2px_0_hsl(var(--art-shadow)/0.08)] ring-1 ring-foreground/[0.08]'
          : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', item.active && 'text-primary')} strokeWidth={2.1} />
      <span>{item.label}</span>
      {count > 0 && (
        <span
          className={cn(
            artCount,
            item.tone === 'urgent' ? 'bg-destructive text-destructive-foreground' : 'bg-foreground/[0.08] text-foreground/70',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
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
  const slotFilled = useHasChildren(slotRef);
  const queues = nav.queues;
  const visible = queues.length > 0 || slotFilled;

  return (
    <div
      data-shell="context-bar"
      className={cn(
        visible ? 'flex' : 'hidden',
        'relative z-20 h-12 shrink-0 items-stretch gap-3 pe-3 lg:pe-5',
        // A phone scrolls the whole bar sideways; a desktop only the views.
        compact && 'scrollbar-hide overflow-x-auto overflow-y-hidden',
      )}
    >
      {/* The page's toolbar first: Inbox sizes its tabs to its list column. */}
      <div ref={slotRef} id="topbar-page-slot" className="relative z-10 flex min-w-0 shrink-0 items-stretch" />
      {queues.length > 0 && (
        <nav
          aria-label={t('artShell.inboxViews')}
          className={cn(
            'flex items-center gap-1',
            compact ? 'shrink-0' : 'scrollbar-hide min-w-0 flex-1 overflow-x-auto',
            !slotFilled && 'ps-3 lg:ps-5',
          )}
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
