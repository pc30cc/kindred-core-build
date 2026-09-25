import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Inbox, Radar, Menu as MenuIcon } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useInboxCounts } from '@/hooks/useConversations';
import { useWorkspaceSections } from '@/hooks/useWorkspaceSections';
import { cn } from '@/lib/utils';

/**
 * Fixed bottom tab bar — the primary navigation surface on mobile web/PWA
 * (desktop keeps the permanent AppSidebar rail; see AppLayout.tsx). Only
 * a few destinations — Visitors only when the plan includes it, by the
 * sidebar's own rule: everything else (AI
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
  // Visitors is a plan section: the tab follows the sidebar's rule.
  const sections = useWorkspaceSections();

  const isActive = (subPath: string) => {
    const fullPath = wsPath(subPath);
    if (subPath === '') return location.pathname === fullPath;
    return location.pathname.includes(subPath);
  };

  const needsHuman = inboxCounts?.needs_human ?? 0;

  const tabs: { key: string; icon: React.ElementType; onClick?: () => void; to?: string; active: boolean; badge?: number }[] = [
    { key: 'dashboard', icon: LayoutDashboard, to: wsPath(''), active: isActive('') },
    { key: 'inbox', icon: Inbox, to: wsPath('/inbox'), active: isActive('/inbox'), badge: needsHuman },
    ...(sections.visible('visitors')
      ? [{ key: 'visitors', icon: Radar, to: wsPath('/visitors'), active: isActive('/visitors') }]
      : []),
    { key: 'menu', icon: MenuIcon, active: false, onClick: onMenuClick },
  ];

  return (
    <nav
      // `fixed` and pinned to the true visual viewport bottom — NOT a normal
      // flex-column child. Relying on flex sizing meant this bar's visibility
      // depended on every single page correctly respecting the shell's
      // height (h-dvh/flex-1) with no internal overflow of its own; any page
      // that didn't could push it below the fold. Being fixed makes it
      // immune to that entirely. AppLayout reserves the equivalent height
      // with a plain spacer div so page content still ends above it instead
      // of being covered by it.
      className="fixed inset-x-0 bottom-0 z-40 flex h-[60px] items-stretch border-t border-border/60 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80"
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
              {t(`nav.${tab.key}` as TranslationKey)}
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
