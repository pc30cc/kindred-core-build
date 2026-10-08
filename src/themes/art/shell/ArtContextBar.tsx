import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ArtNav, ArtQueueItem } from './useArtNav';
import { artCount } from './styles';
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
 * One view of the inbox, in the header's pill language: 36px, the current
 * one on a clay tint. The needs-human count is the same clay circle as on the
 * header's Inbox pill and the phone's tab bar; other counts stay quiet.
 */
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
        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
        item.active ? 'bg-primary/10 text-primary' : 'text-foreground/70 hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
      <span>{item.label}</span>
      {count > 0 && (
        <span
          className={cn(
            artCount,
            item.tone === 'urgent'
              ? 'bg-primary text-primary-foreground'
              : item.active
                ? 'bg-primary/15 text-primary'
                : 'bg-foreground/[0.08] text-foreground/70',
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
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<HTMLElement>(null);
  const slotFilled = useHasChildren(slotRef);
  const queues = nav.queues;
  const visible = queues.length > 0 || slotFilled;
  // Fade the edge that hides more: the whole bar on a phone, the views on a desktop.
  useScrollFade(barRef, visible && compact);
  useScrollFade(viewsRef, visible && !compact && queues.length > 0);

  return (
    <div
      ref={barRef}
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
          ref={viewsRef}
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
