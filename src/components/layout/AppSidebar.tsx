import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import {
  Inbox, Users, Eye, BookOpen, MessageSquare,
  Bot, Settings, Rocket, Search, Package, LayoutDashboard,
  LogOut, Shield, ChevronDown, UserPlus, Plus,
  Zap, ShieldAlert, ExternalLink, Bell, EyeOff,
  Clock, UserCog, Building2, HelpCircle, Sparkles,
  AlertCircle, Check, Ban, Lock,
  PhoneCall,
  PanelLeftClose, PanelLeftOpen,
  Plug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ImageWithSkeleton } from '@/components/common/ImageWithSkeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useProfile } from '@/hooks/useProfile';
import { useMemo, useState, useRef, useEffect } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { CreateWorkspaceDialog } from '@/features/workspace/CreateWorkspaceDialog';
import { useWorkspaceCapacity } from '@/features/workspace/useWorkspaceCapacity';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { toast } from '@/hooks/use-toast';
import { useBranding } from '@/hooks/useBranding';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useInboxCounts } from '@/hooks/useConversations';
import { useCallCenterCapabilities } from '@/hooks/useCallCenter';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AI_ACCENT, type AiAccent } from '@/components/ai-agent/AiPageHeader';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

/** Colorful icon chip shared by every sidebar entry. */
function NavChip({
  icon: Icon,
  accent,
  active,
  collapsed,
}: { icon: React.ElementType; accent: AiAccent; active: boolean; collapsed: boolean }) {
  const a = AI_ACCENT[accent];
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg transition-all duration-200',
        collapsed ? 'h-9 w-9' : 'h-7 w-7',
        active
          ? cn('bg-gradient-to-br text-white shadow-md', a.grad)
          : cn('ring-1 group-hover:scale-105', a.chip),
      )}
    >
      <Icon className={collapsed ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
    </span>
  );
}

function NavTip({ label, enabled, children }: { label: string; enabled: boolean; children: React.ReactElement }) {
  if (!enabled) return children;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="right" className="text-sm font-medium">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AppSidebar() {
  const { t, dir } = useTranslation();
  const { locale, setLocale } = useI18n();
  const { allowedLocales, canSwitchLanguage } = usePlatformRegion();
  const location = useLocation();
  const navigate = useNavigate();
  const { signOut, user } = useAuth();
  const { data: isAdmin } = useIsGlobalAdmin();
  const { platformName } = useBrandingContext();
  const { workspace, workspaces } = useActiveWorkspace();
  const { data: profile } = useProfile();
  const wsPath = useWorkspacePath();
  const { data: branding } = useBranding(workspace?.id);
  const { data: aiAgentCaps, isError: aiAgentCapsError } = useAiAgentCapabilities(workspace?.id || null);
  const { data: inboxCounts } = useInboxCounts(workspace?.id);
  const { data: callCenterCaps, isError: callCenterCapsError } = useCallCenterCapabilities(workspace?.id);
  const { data: entitlements } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const { data: wsRole } = useWorkspaceRole(workspace?.id);
  // Fail-CLOSED: hide unless capabilities explicitly say visible.
  const callCenterVisible =
    !callCenterCapsError && !!callCenterCaps?.workspace_call_center_visible;
  // Automated inbox requires the AI surface to be entitled at BOTH the
  // platform (super-admin kill-switch) and plan/workspace level. If either is
  // off, the queue is hidden entirely — even when AI-managed threads exist.
  // Fail-CLOSED on error.
  const aiSurfaceEntitled =
    !aiAgentCapsError &&
    !!aiAgentCaps &&
    aiAgentCaps.ai_agent_enabled === true &&
    aiAgentCaps.customer_ai_agent_visible === true;
  const automatedInboxVisible =
    aiSurfaceEntitled &&
    (aiAgentCaps!.auto_answer_enabled === true || (inboxCounts?.automated ?? 0) > 0);


  // Primary domain for the active workspace (display under the workspace name).
  // Backed by GET /api/workspaces/:workspaceId/primary-domain — direct
  // supabase.from('workspace_domains') relied on RLS scoped to auth.uid(),
  // which is NULL without a Supabase Auth session.
  const { data: wsPrimaryDomain } = useQuery({
    queryKey: ['workspace-primary-domain', workspace?.id],
    enabled: !!workspace,
    queryFn: async () => {
      const res = await fetch(`${RESOLVED_API_BASE}/api/workspaces/${workspace!.id}/primary-domain`, { credentials: 'include' });
      if (!res.ok) return null;
      const { domain } = await res.json();
      return domain as string | null;
    },
    staleTime: 60_000,
  });
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [wsLimitNotice, setWsLimitNotice] = useState(false);
  const { data: wsCapacity, isLoading: wsCapacityLoading } = useWorkspaceCapacity(wsMenuOpen);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem('sidebar_collapsed') === '1',
  );
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem('sidebar_collapsed', v ? '0' : '1');
      return !v;
    });
  };

  // The Inbox is a dense 3-pane workspace: collapse the nav rail automatically
  // while it is open, then restore the user's own preference on leaving.
  const onInbox =
    /\/inbox(\/|$)/.test(location.pathname) || /\/settings(\/|$)/.test(location.pathname);
  useEffect(() => {
    if (onInbox) setCollapsed(true);
    else setCollapsed(localStorage.getItem('sidebar_collapsed') === '1');
  }, [onInbox]);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const brandLetter = useMemo(() => (platformName || 'A').charAt(0), [platformName]);

  // Availability — used for the "invisible mode" quick toggle in the user menu
  const queryClient = useQueryClient();
  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: () => fetchAvailability(),
    enabled: !!user,
    staleTime: 30_000,
  });
  const invisible = !!availability?.prefs?.force_offline;
  const toggleInvisible = useMutation({
    mutationFn: () => updateAvailability({ force_offline: !invisible }),
    onSuccess: (res) => {
      queryClient.setQueryData(['availability', 'me'], res);
      queryClient.invalidateQueries({ queryKey: ['team-presence'] });
      toast({
        title: res.prefs.force_offline ? 'Invisible mode enabled' : 'Invisible mode disabled',
        description: res.prefs.force_offline
          ? 'You now appear offline to visitors.'
          : 'You are visible based on your availability schedule.',
      });
    },
    onError: (err: any) => {
      toast({
        title: 'Failed to update status',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    },
  });

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    if (wsMenuOpen || userMenuOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [wsMenuOpen, userMenuOpen]);

  const isActive = (subPath: string) => {
    const fullPath = wsPath(subPath);
    if (subPath === '') return location.pathname === fullPath;
    if (subPath === '/settings') return location.pathname.includes('/settings');
    if (subPath === '/inbox') return location.pathname.includes('/inbox');
    if (subPath === '/ai-agent') return location.pathname.includes('/ai-agent');
    return location.pathname.includes(subPath);
  };

  // Fail-CLOSED: hide on error or when caps explicitly say disabled.
  // While loading (no data yet, no error), hide to avoid flashing a link
  // that may immediately bounce out of the section.
  const aiAgentVisible =
    !aiAgentCapsError &&
    !!aiAgentCaps &&
    aiAgentCaps.ai_agent_enabled === true &&
    aiAgentCaps.customer_ai_agent_visible === true;
  // Phase 6-S5-R1 — plan-level module state, FAIL CLOSED.
  // A missing key or an unresolved lookup is NEVER treated as enabled.
  const moduleEnabled = (key: string): boolean => {
    const state = entitlements?.modules?.[key];
    return state != null && state.value === true;
  };
  // AI Agent: platform availability decides visibility, plan decides lock.
  const aiAssistantPlanEnabled =
    aiAgentCaps?.plan_ai_assistant_enabled === true || moduleEnabled('ai_assistant');
  // Phase 6-S5-R4 — Knowledge Base is a CORE workspace product. It is never
  // hidden and NEVER locked: not by plan, not by AI platform state, not while
  // entitlements are loading, not on entitlement lookup errors. It behaves
  // exactly like Inbox or Contacts.

  // Operators (agents/viewers) never see AI assistant, widget or plugins.
  const isWsAdmin = isWorkspaceAdmin(wsRole);

  // Plan visibility: a top-level menu whose MODULE is not in the plan is not
  // rendered at all (no locked placeholder). Entries stay visible while the
  // entitlement snapshot is still loading, so nothing flickers away; only an
  // explicit `false` from the resolved snapshot hides them.
  const moduleInPlan = (key: string): boolean => {
    if (!entitlements?.modules) return true; // not resolved yet — keep visible
    const state = entitlements.modules[key];
    return state == null || state.value === true;
  };

  const mainNav = [
    ...(aiAgentVisible && isWsAdmin && aiAssistantPlanEnabled
      ? [{ key: 'aiAgent', path: '/ai-agent', icon: Sparkles, accent: 'violet', locked: false } as const]
      : []),
    ...(callCenterVisible && moduleInPlan('call_center')
      ? [{ key: 'callCenter', path: '/call-center', icon: PhoneCall, accent: 'emerald', locked: false } as const]
      : []),
    ...(moduleInPlan('visitor_tracking')
      ? [{ key: 'visitors', path: '/visitors', icon: Eye, accent: 'sky', locked: false } as const]
      : []),
    ...(moduleInPlan('contacts')
      ? [{ key: 'contacts', path: '/contacts', icon: Users, accent: 'amber', locked: false } as const]
      : []),
    // Knowledge Base and Team are CORE products — never plan-gated.
    { key: 'knowledgeBase', path: '/knowledge-base', icon: BookOpen, accent: 'cyan', locked: false },
    { key: 'team', path: '/team', icon: UserCog, accent: 'rose', locked: false },
  ] as const;


  const bottomNav = [
    { key: 'search', path: '#', icon: Search, accent: 'sky' },
    ...(isWsAdmin ? [{ key: 'widget', path: '/widget', icon: Package, accent: 'violet' } as const] : []),
    ...(isWsAdmin ? [{ key: 'plugins', path: '/plugins', icon: Plug, accent: 'emerald' } as const] : []),
    { key: 'settings', path: isWsAdmin ? '/settings/general' : '/settings/profile', icon: Settings, accent: 'indigo' },
  ] as const;


  const userName = (user?.metadata?.full_name as string) || user?.email?.split('@')[0] || '';
  const userEmail = user?.email || '';
  const userAvatarUrl = (profile?.avatar_url as string | null | undefined) || '';
  const companyName = workspace?.name || profile?.company_name || platformName || 'Workspace';
  // Show the actual workspace domain (from workspace_domains), with sane fallbacks
  // so newly-created workspaces still display something meaningful.
  const workspaceDomain =
    wsPrimaryDomain || profile?.website_domain || workspace?.slug || '';
  const workspaceIconUrl = (branding?.logo_url as string | null | undefined) || '';
  const companyLetter = companyName.charAt(0).toUpperCase();

  return (
    <>
    <aside
      className={cn(
        'relative flex h-screen flex-col border-e border-sidebar-border bg-sidebar transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-[220px]',
      )}
      style={{ backgroundImage: 'var(--gradient-sidebar)' }}
    >
      {/* Collapse toggle — centered on the sidebar divider line */}
      <button
        onClick={toggleCollapsed}
        aria-label="toggle sidebar"
        className="absolute top-1/2 end-0 z-30 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-muted-foreground shadow-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground ltr:translate-x-1/2 rtl:-translate-x-1/2"
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      {/* Workspace header with dropdown */}
      <div className="relative px-3 pt-3 pb-2" ref={wsMenuRef}>
        <button
          onClick={() =>
            collapsed ? toggleCollapsed() : isWsAdmin && setWsMenuOpen(!wsMenuOpen)
          }
          disabled={!collapsed && !isWsAdmin}
          className={cn(
            'flex items-center gap-2.5 w-full rounded-lg px-2 py-2 transition-colors',
            !collapsed && !isWsAdmin
              ? 'cursor-default'
              : 'hover:bg-sidebar-accent/50',
          )}
        >
          <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-primary/20 shadow-sm">
            {workspaceIconUrl ? (
              <ImageWithSkeleton src={workspaceIconUrl} className="h-full w-full object-cover" />
            ) : (
              <Building2 className="h-[18px] w-[18px] text-primary-foreground" strokeWidth={2.25} />
            )}
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 text-start flex-1">
                <p className="text-sm font-semibold text-sidebar-foreground truncate">{companyName}</p>
                <p className="text-[11px] text-sidebar-muted-foreground truncate">{workspaceDomain}</p>
              </div>
              {isWsAdmin && (
                <ChevronDown className={cn('h-3.5 w-3.5 text-sidebar-muted-foreground shrink-0 transition-transform', wsMenuOpen && 'rotate-180')} />
              )}
            </>
          )}
        </button>

        {/* Dropdown menu */}
        {wsMenuOpen && !collapsed && isWsAdmin && (
          <div className="absolute start-3 end-3 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl py-2 animate-fade-in max-h-[60vh] overflow-y-auto">
            {/* Workspace list */}
            {workspaces.map(ws => {
              const isCurrentWs = workspace?.id === ws.id;
              return (
                <button
                  key={ws.id}
                  onClick={() => { navigate(`/app/w/${ws.slug}`); setWsMenuOpen(false); }}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 text-sm rounded-md transition-colors',
                    isCurrentWs ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent'
                  )}
                >
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 ring-1 ring-primary/20">
                    <Building2 className="h-4 w-4 text-primary-foreground" strokeWidth={2.25} />
                  </div>
                  <div className="min-w-0 flex-1 text-start">
                    <p className="text-[13px] font-medium truncate">{ws.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{ws.slug}</p>
                  </div>
                  {isCurrentWs && <Check className="h-4 w-4 text-primary shrink-0" />}
                </button>
              );
            })}

            <div className="border-t border-border mt-1.5 pt-1.5">
              {wsLimitNotice ? (
                <div className="mx-1 my-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 space-y-2">
                  <div className="flex items-start gap-2">
                    <Lock className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
                    <div className="text-start min-w-0">
                      <p className="text-[12px] font-semibold text-destructive">{t('workspaceCreate.limitTitle')}</p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                        {t('workspaceCreate.limitDesc')
                          .replace('{limit}', wsCapacity?.limit == null ? t('workspaceCreate.unlimited') : String(wsCapacity.limit))
                          .replace('{used}', String(wsCapacity?.used ?? 0))}
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      className="text-[11px] px-2 py-1 rounded-md hover:bg-accent text-muted-foreground"
                      onClick={() => setWsLimitNotice(false)}
                    >
                      {t('workspaceCreate.cancel')}
                    </button>
                    <button
                      className="text-[11px] px-2.5 py-1 rounded-md bg-primary text-primary-foreground hover:opacity-90"
                      onClick={() => { setWsLimitNotice(false); setWsMenuOpen(false); navigate(wsPath('/billing')); }}
                    >
                      {t('workspaceCreate.upgrade')}
                    </button>
                  </div>
                </div>
              ) : (
              <button
                disabled={wsCapacityLoading}
                onClick={() => {
                  if (wsCapacity && !wsCapacity.canCreate) { setWsLimitNotice(true); return; }
                  setWsMenuOpen(false);
                  setCreateWsOpen(true);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors"
              >
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Plus className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="text-start">
                  <p className="text-[13px] font-medium">{t('workspaceCreate.menuAction')}</p>
                  {wsCapacity?.limit != null && (
                    <p className="text-[11px] text-muted-foreground tabular-nums">{wsCapacity.used} / {wsCapacity.limit}</p>
                  )}
                </div>
              </button>
              )}

              <RouterLink
                to={wsPath('/team')}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors"
                onClick={() => setWsMenuOpen(false)}
              >
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <UserPlus className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="text-start">
                  <p className="text-[13px] font-medium">{t('nav.inviteOperator') || 'Invite an operator'}</p>
                </div>
              </RouterLink>
            </div>

            {workspaceDomain && (
              <div className="border-t border-border mt-1.5 pt-1.5">
                <a
                  href={`https://${workspaceDomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground rounded-md transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span className="text-[13px]">{workspaceDomain}</span>
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Get Started button */}
      <div className="px-3 mb-1">
        <NavTip label={t('nav.dashboard')} enabled={collapsed}>
        <Link
          to={wsPath('')}
          title={collapsed ? undefined : t('nav.dashboard')}
          className={cn(
            'flex items-center rounded-lg px-3 py-2 text-sm font-semibold transition-all',
            isActive('')
              ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm'
              : 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/70',
            collapsed && 'justify-center px-0'
          )}
        >
          <div className="group flex items-center gap-2.5">
            <NavChip icon={LayoutDashboard} accent="indigo" active={isActive('')} collapsed={collapsed} />
            {!collapsed && <span>{t('nav.dashboard')}</span>}
          </div>
        </Link>
        </NavTip>
      </div>

      {/* Inbox section */}
      <div className="px-3 mt-2">
        <NavTip label={t('nav.inbox')} enabled={collapsed}>
        <Link
          to={wsPath('/inbox')}
          title={collapsed ? undefined : t('nav.inbox')}
          className={cn(
            'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
            isActive('/inbox')
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
            collapsed && 'justify-center px-0'
          )}
        >
          <NavChip icon={Inbox} accent="emerald" active={isActive('/inbox')} collapsed={collapsed} />
          {!collapsed && <span>{t('nav.inbox')}</span>}
        </Link>
        </NavTip>

        {isActive('/inbox') && !collapsed && (
          <div className="ms-5 mt-0.5 space-y-0.5 border-s border-sidebar-border ps-3">
            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-1.5 pb-1">{t('inbox.defaultInboxes') || 'Default inboxes'}</p>
            <Link
              to={wsPath('/inbox')}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                location.pathname === wsPath('/inbox') && !location.search.includes('queue=')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span>{t('inbox.mainInbox') || 'Main inbox'}</span>
              {(inboxCounts?.needs_human ?? 0) > 0 && (
                <span
                  className="ms-auto bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center"
                  title={t('inbox.needsHuman') || 'Needs human'}
                >
                  {inboxCounts!.needs_human}
                </span>
              )}
            </Link>

            {automatedInboxVisible && (
              <>
                <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">{t('inbox.aiInboxes') || 'AI inboxes'}</p>
                <Link
                  to={wsPath('/inbox?queue=automated')}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                    location.pathname === wsPath('/inbox') && location.search.includes('queue=automated')
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                      : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                  )}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('inbox.automatedInbox') || 'Automated'}</span>
                  {(inboxCounts?.automated ?? 0) > 0 && (
                    <span className="ms-auto bg-secondary text-foreground/70 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                      {inboxCounts!.automated}
                    </span>
                  )}
                </Link>
              </>
            )}

            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">{t('inbox.otherInboxes') || 'Other inboxes'}</p>
            <Link
              to={wsPath('/inbox?queue=spam')}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors',
                location.pathname === wsPath('/inbox') && location.search.includes('queue=spam')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              )}
            >
              <Ban className="h-3.5 w-3.5 shrink-0" />
              <span>{t('inbox.spamInbox') || 'Spam'}</span>
              {(inboxCounts?.spam ?? 0) > 0 && (
                <span className="ms-auto bg-secondary text-foreground/70 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                  {inboxCounts!.spam}
                </span>
              )}
            </Link>
          </div>
        )}
      </div>

      {/* Main navigation */}
      <nav className="flex-1 overflow-y-auto pt-3 px-3 space-y-0.5">
        {mainNav.map(item => (
          <NavTip key={item.key} label={t(`nav.${item.key}` as any)} enabled={collapsed}>
          <Link
            to={wsPath(item.path)}
            title={collapsed ? undefined : t(`nav.${item.key}` as any)}
            className={cn(
              'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              collapsed && 'justify-center px-0'
            )}
          >
            <NavChip icon={item.icon} accent={item.accent} active={isActive(item.path)} collapsed={collapsed} />
            {!collapsed && <span className="flex-1">{t(`nav.${item.key}` as any)}</span>}
            {item.locked && !collapsed && (
              <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="locked" />
            )}
          </Link>
          </NavTip>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-2 space-y-0.5">
        {bottomNav.map(item => (
          <NavTip key={item.key} label={t(`nav.${item.key}` as any)} enabled={collapsed}>
          <Link
            to={item.path === '#' ? '#' : wsPath(item.path)}
            title={collapsed ? undefined : t(`nav.${item.key}` as any)}
            onClick={item.key === 'search' ? (e) => {
              e.preventDefault();
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
            } : undefined}
            className={cn(
              'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              collapsed && 'justify-center px-0'
            )}
          >
            <NavChip icon={item.icon} accent={item.accent} active={isActive(item.path)} collapsed={collapsed} />
            {!collapsed && <span>{t(`nav.${item.key}` as any)}</span>}
          </Link>
          </NavTip>
        ))}

        {isAdmin && (
          <NavTip label="Super Admin" enabled={collapsed}>
          <Link
            to="/admin"
            title={collapsed ? undefined : 'Super Admin'}
            className={cn(
              'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-sidebar-primary hover:bg-sidebar-accent transition-all',
              collapsed && 'justify-center px-0'
            )}
          >
            <NavChip icon={Shield} accent="rose" active={false} collapsed={collapsed} />
            {!collapsed && <span>Super Admin</span>}
          </Link>
          </NavTip>
        )}
      </div>

    </aside>
    <CreateWorkspaceDialog open={createWsOpen} onOpenChange={setCreateWsOpen} upgradeHref={wsPath('/billing')} />
    </>
  );
}
