import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Inbox, Search, Menu as MenuIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useInboxCounts } from '@/hooks/useConversations';
import { cn } from '@/lib/utils';

/**
 * Fixed bottom tab bar — the primary navigation surface on mobile web/PWA
 * (desktop keeps the permanent AppSidebar rail; see AppLayout.tsx). Only
 * four universal, always-available destinations: everything else (AI
 * Agent, Contacts, SEO, Settings, workspace switcher, Super Admin, ...) is
 * one tap away behind "Menu", which opens the full AppSidebar as a Sheet
 * drawer (`variant="drawer"`) — the same entitlement-gated nav content as
 * desktop, so nothing needs to be duplicated or kept in sync here.
 */
export function MobileBottomNav({ onMenuClick }: { onMenuClick: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const wsPath = useWorkspacePath();
  const { workspace } = useActiveWorkspace();
  const { data: inboxCounts } = useInboxCounts(workspace?.id);

  const isActive = (subPath: string) => {
    const fullPath = wsPath(subPath);
    if (subPath === '') return location.pathname === fullPath;
    return location.pathname.includes(subPath);
  };

  const needsHuman = inboxCounts?.needs_human ?? 0;

  const tabs: { key: string; icon: React.ElementType; onClick?: () => void; to?: string; active: boolean; badge?: number }[] = [
    { key: 'dashboard', icon: LayoutDashboard, to: wsPath(''), active: isActive('') },
    { key: 'inbox', icon: Inbox, to: wsPath('/inbox'), active: isActive('/inbox'), badge: needsHuman },
    {
      key: 'search',
      icon: Search,
      active: false,
      onClick: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })),
    },
    { key: 'menu', icon: MenuIcon, active: false, onClick: onMenuClick },
  ];

  return (
    <nav
      // A normal flex-column child (like AppTopBar), NOT `fixed` — this way
      // <main>'s flex-1 sizing naturally leaves room for it, which composes
      // correctly with full-bleed pages (Inbox, Settings, ...) that manage
      // their own internal height/scroll, instead of every page having to
      // remember to pad its content by this bar's height.
      className="z-40 flex h-[60px] shrink-0 items-stretch border-t border-border/60 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {tabs.map((tab) => {
        const content = (
          <>
            <span className="relative flex h-6 w-6 items-center justify-center">
              <tab.icon className={cn('h-5 w-5', tab.active ? 'text-primary' : 'text-muted-foreground')} />
              {!!tab.badge && tab.badge > 0 && (
                <span className="absolute -end-1.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground">
                  {tab.badge > 99 ? '99+' : tab.badge}
                </span>
              )}
            </span>
            <span className={cn('text-[10px] font-medium', tab.active ? 'text-primary' : 'text-muted-foreground')}>
              {t(`nav.${tab.key}` as any)}
            </span>
          </>
        );
        const className = 'flex flex-1 flex-col items-center justify-center gap-0.5';
        return tab.to ? (
          <Link key={tab.key} to={tab.to} className={className}>{content}</Link>
        ) : (
          <button key={tab.key} type="button" onClick={tab.onClick} className={className}>{content}</button>
        );
      })}
    </nav>
  );
}
