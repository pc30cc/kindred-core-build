import { Fragment, useEffect, useRef, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Shield, Sparkles } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertsMenu } from '@/components/layout/AlertsMenu';
import { UserMenu } from '@/components/layout/UserMenu';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { ArtWorkspaceSwitcher } from './ArtWorkspaceSwitcher';
import { ArtLanguageMenu, ArtThemeToggle } from './ArtPreferences';
import type { ArtNav, ArtNavItem, ArtQueueItem } from './useArtNav';
import { artCount, artIconButton } from './styles';
import { commandPaletteShortcut, openCommandPalette } from './commandPalette';

type Side = 'left' | 'right';

/**
 * The side menu's groups, by meaning. The dashboard heads the list without a
 * label; Team sits with Settings at the foot (`PINNED`). An entry useArtNav
 * offers but no group names joins the last group, so nothing is ever lost.
 */
const GROUPS: { label: TranslationKey | null; keys: string[] }[] = [
  { label: null, keys: ['dashboard'] },
  { label: 'artShell.sideConversations', keys: ['inbox', 'emailInbox', 'callCenter'] },
  { label: 'artShell.sideCustomers', keys: ['contacts', 'visitors'] },
  { label: 'artShell.sideAi', keys: ['aiAgent', 'knowledgeBase'] },
  { label: 'artShell.sideGrowth', keys: ['seo', 'webAnalytics'] },
];
const PINNED = ['team'];

const DAY_MS = 86_400_000;

/**
 * The plan notice's state, decided exactly as PlanStatusBanner decides it
 * (the backend's effective-entitlement snapshot): a running trial and its
 * days, the free plan, or nothing for a paying / unlimited workspace.
 */
function useArtPlanNotice(workspaceId: string | null | undefined) {
  const { data } = useWorkspaceEffectiveEntitlements(workspaceId || null);
  if (!data || data.billing === 'unlimited') return null;
  const sub = (data.subscription || null) as
    | { status?: string | null; trial_end?: string | null; free_fallback_at?: string | null; plan_id?: string | null }
    | null;
  const plan = (data.plan || null) as { is_free?: boolean | null; slug?: string | null } | null;
  const trialEndMs = sub?.trial_end ? new Date(sub.trial_end).getTime() : NaN;
  if (sub?.status === 'trialing' && Number.isFinite(trialEndMs) && trialEndMs > Date.now()) {
    return { kind: 'trial' as const, days: Math.max(1, Math.ceil((trialEndMs - Date.now()) / DAY_MS)) };
  }
  const isFree = Boolean(plan?.is_free) || plan?.slug === 'free' || !sub?.plan_id || !!sub?.free_fallback_at;
  return isFree ? { kind: 'free' as const } : null;
}

/** The plan card's line: the trial's days left ("last day" on the last), or the free plan. */
function planNoticeText(
  t: ReturnType<typeof useTranslation>['t'],
  notice: NonNullable<ReturnType<typeof useArtPlanNotice>>,
) {
  if (notice.kind !== 'trial') return t('artShell.planFree');
  return notice.days === 1 ? t('artShell.planTrialLastDay') : t('artShell.planTrial', { days: notice.days });
}

function countText(value: number) {
  return value > 99 ? '99+' : String(value);
}

/**
 * A rail icon's name beside it, only while the menu is a rail. A count sits
 * in its own small circle after the name, never joined to it by a dot (in
 * Persian a "·" beside "۲" reads as "۲۰").
 */
function Tip({
  label,
  count = 0,
  side,
  enabled,
  children,
}: {
  label: string;
  count?: number;
  side: Side;
  enabled: boolean;
  children: ReactElement;
}) {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={12} className="flex items-center gap-2 text-[0.8125rem] font-medium">
        <span>{label}</span>
        {count > 0 && <span className={cn(artCount, 'bg-primary text-primary-foreground')}>{countText(count)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One destination: icon and name, a pill as tall as `--side-row` (40px on a
 * tall screen, less on a laptop's: sidebar.css). `state`: the open page (a
 * clay pill), the open section while one of its views is the page (clay
 * icon, no pill), or neither. On the rail a count is a clay dot clear of
 * the icon; the number is in the tooltip.
 */
function SideItem({
  item,
  collapsed,
  tipSide,
  state,
  showCount = true,
}: {
  item: ArtNavItem;
  collapsed: boolean;
  tipSide: Side;
  state: 'page' | 'section' | 'idle';
  showCount?: boolean;
}) {
  const Icon = item.icon;
  const count = showCount ? (item.badge ?? 0) : 0;
  return (
    <Tip label={item.label} count={count} side={tipSide} enabled={collapsed}>
      <Link
        to={item.to}
        data-nav-item
        data-side-item
        data-state={state}
        data-active={state === 'page'}
        aria-current={state === 'page' ? 'page' : undefined}
        aria-label={collapsed ? (count > 0 ? `${item.label} (${countText(count)})` : item.label) : undefined}
        className={cn(
          'group relative flex h-[var(--side-row)] shrink-0 items-center gap-3 rounded-full text-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
          collapsed ? 'mx-auto w-11 justify-center' : 'pe-2.5 ps-3.5',
          state === 'page'
            ? 'bg-primary/10 text-[color:var(--art-ui-tint-text)]'
            : state === 'section'
              ? 'font-semibold text-foreground hover:bg-foreground/[0.045]'
              : 'text-foreground/75 hover:bg-foreground/[0.045] hover:text-foreground',
        )}
      >
        <Icon
          className={cn(
            'h-[18px] w-[18px] shrink-0 transition-colors',
            state === 'idle' ? 'text-muted-foreground group-hover:text-foreground' : 'text-primary',
          )}
          strokeWidth={2}
        />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {count > 0 &&
          (collapsed ? (
            <span
              aria-hidden
              data-side-dot
              className="pointer-events-none absolute end-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[hsl(var(--art-side))]"
            />
          ) : (
            <span data-side-count className={cn(artCount, 'bg-primary text-primary-foreground')}>
              {countText(count)}
            </span>
          ))}
      </Link>
    </Tip>
  );
}

/** A view's count: needs-human in clay, the rest quiet. */
function ViewCount({ item }: { item: ArtQueueItem }) {
  const count = item.badge ?? 0;
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        artCount,
        item.tone === 'urgent'
          ? 'bg-primary text-primary-foreground'
          : item.active
            ? 'bg-primary/15 text-[color:var(--art-ui-tint-text)]'
            : 'bg-foreground/[0.07] text-foreground/65',
      )}
    >
      {countText(count)}
    </span>
  );
}

/** The views of the inbox as one list, a hairline between its kinds. */
function viewsWithBreaks(views: ArtQueueItem[]) {
  return views.map((item, i) => ({ item, breakBefore: i > 0 && views[i - 1].group !== item.group }));
}

/**
 * Every view of the inbox under the inbox, while it is open: InboxPage's own
 * tabs (in progress, AI, colleagues), then the status queues, the internal
 * inbox and one inbox per channel. One choice among them, so one clay pill.
 */
function SideViews({ views, label }: { views: ArtQueueItem[]; label: string }) {
  return (
    <div role="group" aria-label={label} data-shell="side-views" className="relative mb-1 mt-px flex flex-col gap-px ps-8">
      <span aria-hidden className="absolute bottom-2 start-[1.4375rem] top-1 w-px rounded-full bg-foreground/10" />
      {viewsWithBreaks(views).map(({ item, breakBefore }) => {
        const Icon = item.icon;
        return (
          <Fragment key={item.key}>
            {breakBefore && <span aria-hidden className="mx-3 my-[3px] h-px shrink-0 bg-foreground/[0.08]" />}
            <Link
              to={item.to}
              data-nav-item
              data-side-view
              data-active={item.active}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'group flex h-[var(--side-sub)] shrink-0 items-center gap-2.5 rounded-full pe-2 ps-3 text-[0.8125rem] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                item.active ? 'bg-primary/10 text-[color:var(--art-ui-tint-text)]' : 'text-foreground/70 hover:bg-foreground/[0.045] hover:text-foreground',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  item.active ? 'text-primary' : item.tone === 'urgent' ? 'text-primary/80' : 'text-muted-foreground group-hover:text-foreground',
                )}
                strokeWidth={2}
              />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <ViewCount item={item} />
            </Link>
          </Fragment>
        );
      })}
    </div>
  );
}

/** A group's small heading; on the rail, a short hairline in its place. */
function GroupLabel({ text, collapsed }: { text: string; collapsed: boolean }) {
  if (collapsed) {
    return <span aria-hidden data-side-rule className="mx-auto block h-px w-6 shrink-0 bg-foreground/10" />;
  }
  return (
    <div data-side-label className="shrink-0 px-3.5 pb-0.5 text-[0.71875rem] font-semibold leading-[0.875rem] tracking-[0.01em] text-muted-foreground">
      {text}
    </div>
  );
}

/** Marks which ends of the list hide more (`data-fade`), for sidebar.css's masks. */
function useFadeY(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollHeight - el.clientHeight;
      const start = max > 8 && el.scrollTop > 1;
      const end = max > 8 && el.scrollTop < max - 1;
      const fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
      if (fade) el.setAttribute('data-fade', fade);
      else el.removeAttribute('data-fade');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutation = new MutationObserver(() => {
      resize.disconnect();
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
      update();
    });
    mutation.observe(el, { childList: true, subtree: true });
    for (const child of Array.from(el.children)) resize.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [ref]);
}

/**
 * Keeps the current entry in sight: after every navigation (and on folding),
 * the list scrolls just enough to show the item marked `aria-current`.
 */
function useRevealCurrent(ref: React.RefObject<HTMLElement>, key: string) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = ref.current;
      const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!list || !current) return;
      const pad = 28;
      const top = current.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      const bottom = top + current.offsetHeight;
      if (top - pad < list.scrollTop) list.scrollTop = Math.max(0, top - pad);
      else if (bottom + pad > list.scrollTop + list.clientHeight) list.scrollTop = bottom + pad - list.clientHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [ref, key]);
}

/**
 * The plan notice at the menu's foot, over the account: what the workspace
 * is on, and for the free plan a quiet link to upgrade (text, not a filled
 * button, so it never outshouts a page's own main action).
 */
function PlanCard({ notice }: { notice: NonNullable<ReturnType<typeof useArtPlanNotice>> }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  return (
    <div data-shell="side-plan" className="mb-1.5 flex h-8 items-center gap-2 rounded-xl pe-1 ps-3 text-[0.8125rem]">
      <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.2} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
        {planNoticeText(t, notice)}
      </span>
      {notice.kind === 'free' && (
        <Link
          to={wsPath('/billing')}
          data-shell="side-plan-link"
          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {t('artShell.planUpgrade')}
          <ArrowUpRight aria-hidden className="h-3.5 w-3.5 rtl:-scale-x-100" strokeWidth={2.2} />
        </Link>
      )}
    </div>
  );
}

/** The side menu's element id, for its fold button's `aria-controls`. */
const SIDE_MENU_ID = 'art-side-menu';

/**
 * The Art panel's side menu (ArtShell, when the Super Admin chose the
 * side-menu layout; desktops): an inset panel on the reading-start side, in
 * the colour scheme's paper. The workspace and search on top; the
 * destinations grouped by meaning, the inbox opening onto all of its views;
 * Team, Settings and Super Admin pinned under the list; the plan, the
 * account, preferences and alerts at the foot. It folds into a 72px rail of
 * icons with tooltips (the member's choice, kept per browser).
 */
export function ArtSidebar({
  nav,
  collapsed,
  onToggleCollapsed,
}: {
  nav: ArtNav;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t, dir } = useTranslation();
  const { pathname, search } = useLocation();
  const { workspace } = useActiveWorkspace();
  const notice = useArtPlanNotice(workspace?.id);
  const listRef = useRef<HTMLDivElement>(null);
  useFadeY(listRef);
  // Again once the plan-gated entries arrive (the current one may be one).
  useRevealCurrent(listRef, `${pathname}${search}:${collapsed}:${nav.ready}:${nav.primary.length}:${nav.utility.length}`);

  // Tooltips open towards the page: left of a right-hand rail, and so on.
  const tipSide: Side = dir === 'rtl' ? 'left' : 'right';
  const searchLabel = t('common.quickSearch') || 'Quick search';
  const toggleLabel = collapsed ? t('artShell.expandSidebar') : t('artShell.collapseSidebar');
  const ToggleIcon =
    dir === 'rtl' ? (collapsed ? PanelRightOpen : PanelRightClose) : collapsed ? PanelLeftOpen : PanelLeftClose;

  // On the inbox every view is listed under it (not on the rail: there the
  // views are a strip over the inbox, ArtSideViewsBar).
  const views = [...nav.inboxTabs, ...nav.queues];
  const viewsOpen = !collapsed && nav.onInbox && views.length > 0;
  const stateOf = (item: ArtNavItem) =>
    !item.active ? 'idle' : item.key === 'inbox' && viewsOpen && views.some((v) => v.active) ? 'section' : 'page';

  // Group the destinations; whatever no group names joins the last one.
  const byKey = new Map(nav.primary.map((item) => [item.key, item]));
  const named = new Set([...GROUPS.flatMap((g) => g.keys), ...PINNED]);
  const groups = GROUPS.map((g, i) => ({
    label: g.label,
    items: [
      ...g.keys.map((k) => byKey.get(k)).filter((x): x is ArtNavItem => !!x),
      ...(i === GROUPS.length - 1 ? nav.primary.filter((item) => !named.has(item.key)) : []),
    ],
  })).filter((g) => g.items.length > 0);
  const pinned = PINNED.map((k) => byKey.get(k)).filter((x): x is ArtNavItem => !!x);

  const toggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-shell="side-toggle"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          aria-controls={SIDE_MENU_ID}
          onClick={onToggleCollapsed}
          className={cn(artIconButton, 'h-9 w-9 [&_svg]:h-[18px] [&_svg]:w-[18px]', collapsed && 'h-8 w-8')}
        >
          <ToggleIcon />
        </button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? tipSide : 'bottom'} sideOffset={collapsed ? 12 : 6}>
        {toggleLabel}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <aside
      id={SIDE_MENU_ID}
      data-shell="side"
      data-collapsed={collapsed}
      aria-label={t('artShell.sideNav')}
      className={cn(
        'relative z-30 flex h-full shrink-0 flex-col py-3 ps-3 transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[84px]' : 'w-[276px]',
      )}
    >
      {/* No overflow clipping here: the account's menu opens out of the panel. */}
      <div data-shell="side-panel" className="flex min-h-0 flex-1 flex-col rounded-[1.375rem]">
        {/* The workspace (with the plan's dot on the rail), and the fold. */}
        <div className={cn('flex shrink-0 items-center gap-1 px-2 pt-2', collapsed && 'flex-col gap-0.5 px-0 pt-1.5')}>
          <div data-shell="side-workspace" className={cn('relative min-w-0', collapsed ? 'flex justify-center' : 'flex-1')}>
            <ArtWorkspaceSwitcher
              isWorkspaceAdmin={nav.isWorkspaceAdmin}
              className={cn(collapsed ? 'h-11 w-11 justify-center p-1' : 'h-10 w-full')}
            />
            {collapsed && notice && (
              <>
                <span
                  aria-hidden
                  data-shell="side-plan-dot"
                  className="pointer-events-none absolute end-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-[hsl(var(--art-side))]"
                />
                <span className="sr-only">
                  {planNoticeText(t, notice)}
                </span>
              </>
            )}
          </div>
          {toggle}
        </div>

        {/* Search: the command palette, as ⌘K. */}
        <div data-shell="side-search-row" className={cn('shrink-0', collapsed ? 'flex justify-center px-0 pt-1' : 'px-3 pt-1.5')}>
          <Tip label={searchLabel} side={tipSide} enabled={collapsed}>
            <button
              type="button"
              data-shell="side-search"
              aria-label={searchLabel}
              aria-keyshortcuts="Meta+K Control+K"
              onClick={openCommandPalette}
              className={cn(
                'flex h-[var(--side-search)] items-center gap-2.5 rounded-full text-sm text-muted-foreground transition-colors',
                'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                collapsed ? 'w-11 justify-center' : 'w-full pe-1.5 ps-3.5',
              )}
            >
              <Search className="h-4 w-4 shrink-0" strokeWidth={2.1} />
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate text-start">{searchLabel}</span>
                  <kbd dir="ltr" data-shell="side-kbd" className="shrink-0 rounded-full px-2 py-0.5 font-sans text-[0.6875rem] font-medium text-muted-foreground">
                    {commandPaletteShortcut()}
                  </kbd>
                </>
              )}
            </button>
          </Tip>
        </div>

        {/* The destinations: the groups scroll, Team / Settings stay put. */}
        <nav aria-label={t('artShell.primaryNav')} className="flex min-h-0 flex-1 flex-col">
          <div
            ref={listRef}
            data-shell="side-list"
            className={cn('scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-1 pt-1', collapsed ? 'px-0' : 'px-2.5')}
          >
            {groups.map((group, gi) => (
              <div key={group.label ?? 'top'} data-side-group className="flex flex-col">
                {group.label && gi > 0 && <GroupLabel text={t(group.label)} collapsed={collapsed} />}
                {group.items.map((item) => (
                  <Fragment key={item.key}>
                    <SideItem
                      item={item}
                      collapsed={collapsed}
                      tipSide={tipSide}
                      state={stateOf(item)}
                      showCount={!(item.key === 'inbox' && viewsOpen)}
                    />
                    {item.key === 'inbox' && viewsOpen && <SideViews views={views} label={t('artShell.inboxViews')} />}
                  </Fragment>
                ))}
              </div>
            ))}
            {!nav.ready && (
              <div className="flex flex-col gap-1">
                <Skeleton aria-hidden className={cn('h-[var(--side-row)] rounded-full', collapsed ? 'mx-auto w-11' : 'w-full')} />
                <Skeleton aria-hidden className={cn('h-[var(--side-row)] rounded-full opacity-70', collapsed ? 'mx-auto w-11' : 'w-full')} />
              </div>
            )}
            {nav.utility.length > 0 && (
              <div data-side-group className="flex flex-col">
                <GroupLabel text={t('artShell.sideTools')} collapsed={collapsed} />
                {nav.utility.map((item) => (
                  <SideItem key={item.key} item={item} collapsed={collapsed} tipSide={tipSide} state={stateOf(item)} />
                ))}
              </div>
            )}
          </div>

          <div
            role="group"
            aria-label={t('artShell.sideManage')}
            data-shell="side-pinned"
            className={cn('flex shrink-0 flex-col pt-1', collapsed ? 'mx-3.5' : 'mx-2.5')}
          >
            {[...pinned, nav.settings].map((item) => (
              <SideItem key={item.key} item={item} collapsed={collapsed} tipSide={tipSide} state={stateOf(item)} />
            ))}
            {nav.superAdmin && (
              <Tip label={t('admin.nav.title')} side={tipSide} enabled={collapsed}>
                <Link
                  to="/admin"
                  data-side-item
                  data-state="idle"
                  aria-label={collapsed ? t('admin.nav.title') : undefined}
                  className={cn(
                    'group flex h-[var(--side-row)] shrink-0 items-center gap-3 rounded-full text-sm font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.045] hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                    collapsed ? 'mx-auto w-11 justify-center' : 'pe-2.5 ps-3.5',
                  )}
                >
                  <Shield className="h-[18px] w-[18px] shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" strokeWidth={2} />
                  {!collapsed && <span className="min-w-0 flex-1 truncate">{t('admin.nav.title')}</span>}
                </Link>
              </Tip>
            )}
          </div>
        </nav>

        {/* The plan, then the account, preferences and alerts. */}
        <div data-shell="side-foot" className={cn('shrink-0 px-2 pb-2', collapsed ? 'px-0' : 'pt-1')}>
          {!collapsed && notice && <PlanCard notice={notice} />}
          {collapsed ? (
            <div data-shell="side-account-row" className="flex flex-col items-center pt-1">
              <div data-shell="side-prefs" className="flex flex-col items-center">
                <ArtLanguageMenu tipSide={tipSide} menuSide={tipSide} />
                <ArtThemeToggle tipSide={tipSide} />
              </div>
              <div data-shell="header-alerts" className="flex shrink-0 items-center">
                <AlertsMenu />
              </div>
              <div data-shell="account" className="flex shrink-0 items-center">
                <UserMenu />
              </div>
            </div>
          ) : (
            <div data-shell="side-account-row" className="flex items-center gap-0.5 pt-1.5">
              <div data-shell="account" className="flex min-w-0 flex-1 items-center">
                <UserMenu />
              </div>
              <div data-shell="side-prefs" className="flex shrink-0 items-center gap-0.5">
                <ArtLanguageMenu tipSide="top" menuSide="top" />
                <ArtThemeToggle tipSide="top" />
              </div>
              <div data-shell="header-alerts" className="flex shrink-0 items-center">
                <AlertsMenu />
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Over the inbox while the menu is a rail (the rail has no room for the
 * views): every view of the inbox as a strip of pills, as the top-menu
 * frame's context bar shows them. Nothing else: no page title, no plan.
 */
export function ArtSideViewsBar({ nav }: { nav: ArtNav }) {
  const { t } = useTranslation();
  const views = [...nav.inboxTabs, ...nav.queues];
  if (views.length === 0) return null;
  return (
    <nav
      aria-label={t('artShell.inboxViews')}
      data-shell="side-views-bar"
      className="scrollbar-hide relative z-20 flex h-[3.75rem] shrink-0 items-center gap-1 overflow-x-auto pt-1.5"
    >
      {viewsWithBreaks(views).map(({ item, breakBefore }) => {
        const Icon = item.icon;
        return (
          <Fragment key={item.key}>
            {breakBefore && <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-foreground/10" />}
            <Link
              to={item.to}
              data-nav-item
              data-side-view
              data-active={item.active}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                item.active ? 'bg-primary/10 text-[color:var(--art-ui-tint-text)]' : 'text-foreground/70 hover:bg-foreground/[0.045] hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
              <span>{item.label}</span>
              <ViewCount item={item} />
            </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}
