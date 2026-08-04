import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useI18n } from '@/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Locale } from '@/i18n/config';
import { LOCALE_CONFIG } from '@/i18n/config';
import { usePlatformRegion } from '@/hooks/usePlatformRegion';
import {
  Inbox, Users, Eye, BookOpen, MessageSquare,
  Bot, Settings, Rocket, Search, Package,
  LogOut, Shield, ChevronDown, UserPlus, Plus,
  Zap, ShieldAlert, ExternalLink, Bell, EyeOff,
  Clock, UserCog, Building2, HelpCircle, Sparkles,
  AlertCircle, Check, Ban, Lock,
  PhoneCall,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/features/auth/AuthContext';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useProfile } from '@/hooks/useProfile';
import { useMemo, useState, useRef, useEffect } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { CreateWorkspaceDialog } from '@/features/workspace/CreateWorkspaceDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchAvailability, updateAvailability } from '@/lib/availability-api';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { useBranding } from '@/hooks/useBranding';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useInboxCounts } from '@/hooks/useConversations';
import { useCallCenterCapabilities } from '@/hooks/useCallCenter';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';

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
  // Fail-CLOSED: hide unless capabilities explicitly say visible.
  const callCenterVisible =
    !callCenterCapsError && !!callCenterCaps?.workspace_call_center_visible;
  // Automated inbox is shown only when EVERY layer that gates AI replies is
  // on. Platform kill-switch alone is not enough — workspace must also have
  // the AI Agent surface enabled and auto-answer capability available.
  // Fail-CLOSED on error.
  const automatedInboxVisible =
    !aiAgentCapsError &&
    !!aiAgentCaps &&
    aiAgentCaps.ai_agent_enabled === true &&
    aiAgentCaps.customer_ai_agent_visible === true &&
    aiAgentCaps.auto_answer_enabled === true;

  // Primary domain for the active workspace (display under the workspace name).
  const { data: wsPrimaryDomain } = useQuery({
    queryKey: ['workspace-primary-domain', workspace?.id],
    enabled: !!workspace,
    queryFn: async () => {
      const { data } = await supabase
        .from('workspace_domains')
        .select('domain, is_primary')
        .eq('workspace_id', workspace!.id)
        .order('is_primary', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.domain ?? null;
    },
    staleTime: 60_000,
  });
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem('sidebar_collapsed') === '1',
  );
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem('sidebar_collapsed', v ? '0' : '1');
      return !v;
    });
  };
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const brandLetter = useMemo(() => (platformName || 'A').charAt(0), [platformName]);

  // Availability — used for the "invisible mode" quick toggle in the user menu
  const queryClient = useQueryClient();
  const { data: availability } = useQuery({
    queryKey: ['availability', 'me'],
    queryFn: fetchAvailability,
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

  const mainNav = [
    ...(aiAgentVisible
      ? [{ key: 'aiAgent', path: '/ai-agent', icon: Sparkles, locked: !aiAssistantPlanEnabled } as const]
      : []),
    ...(callCenterVisible
      ? [{ key: 'callCenter', path: '/call-center', icon: PhoneCall, locked: false } as const]
      : []),
    { key: 'visitors', path: '/visitors', icon: Eye, locked: false },
    { key: 'contacts', path: '/contacts', icon: Users, locked: false },
    { key: 'knowledgeBase', path: '/knowledge-base', icon: BookOpen, locked: false },
    { key: 'team', path: '/team', icon: UserCog, locked: false },
  ] as const;

  const bottomNav = [
    { key: 'search', path: '#', icon: Search },
    { key: 'widget', path: '/widget', icon: Package },
    { key: 'settings', path: '/settings/general', icon: Settings },
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
        'flex h-screen flex-col border-e border-sidebar-border bg-sidebar transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-[220px]',
      )}
      style={{ backgroundImage: 'var(--gradient-sidebar)' }}
    >
      {/* Collapse toggle */}
      <button
        onClick={toggleCollapsed}
        aria-label="toggle sidebar"
        className="mx-3 mt-3 flex h-7 w-7 items-center justify-center self-end rounded-lg text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>

      {/* Workspace header with dropdown */}
      <div className="relative px-3 pt-1 pb-2" ref={wsMenuRef}>
        <button
          onClick={() => (collapsed ? toggleCollapsed() : setWsMenuOpen(!wsMenuOpen))}
          className="flex items-center gap-2.5 w-full rounded-lg px-2 py-2 hover:bg-sidebar-accent/50 transition-colors"
        >
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-primary/20 shadow-sm">
            {workspaceIconUrl ? (
              <img src={workspaceIconUrl} alt="" className="h-full w-full object-cover" />
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
              <ChevronDown className={cn('h-3.5 w-3.5 text-sidebar-muted-foreground shrink-0 transition-transform', wsMenuOpen && 'rotate-180')} />
            </>
          )}
        </button>

        {/* Dropdown menu */}
        {wsMenuOpen && !collapsed && (
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
              <button
                onClick={() => { setWsMenuOpen(false); setCreateWsOpen(true); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors"
              >
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Plus className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="text-start">
                  <p className="text-[13px] font-medium">Create a new workspace</p>
                </div>
              </button>

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
        <Link
          to={wsPath('')}
          title={t('wizard.getStarted')}
          className={cn(
            'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-semibold transition-all',
            isActive('')
              ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm'
              : 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/70',
            collapsed && 'justify-center px-0'
          )}
        >
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 shrink-0" />
            {!collapsed && <span>{t('wizard.getStarted')}</span>}
          </div>
          {!collapsed && (
            <span className="bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">10</span>
          )}
        </Link>
      </div>

      {/* Inbox section */}
      <div className="px-3 mt-2">
        <Link
          to={wsPath('/inbox')}
          title={t('nav.inbox')}
          className={cn(
            'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
            isActive('/inbox')
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/50',
            collapsed && 'justify-center px-0'
          )}
        >
          <Inbox className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && <span>{t('nav.inbox')}</span>}
        </Link>

        {isActive('/inbox') && !collapsed && (
          <div className="ms-5 mt-0.5 space-y-0.5 border-s border-sidebar-border ps-3">
            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-1.5 pb-1">Default Inboxes</p>
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
              <span>Main Inbox</span>
              {(inboxCounts?.needs_human ?? 0) > 0 && (
                <span
                  className="ms-auto bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center"
                  title="Conversations needing a human"
                >
                  {inboxCounts!.needs_human}
                </span>
              )}
            </Link>

            {automatedInboxVisible && (
              <>
                <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">AI Inboxes</p>
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
                  <span>Automated</span>
                  {(inboxCounts?.automated ?? 0) > 0 && (
                    <span className="ms-auto bg-secondary text-foreground/70 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                      {inboxCounts!.automated}
                    </span>
                  )}
                </Link>
              </>
            )}

            <p className="text-[11px] font-medium text-sidebar-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">Other Inboxes</p>
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
              <span>Spam</span>
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
          <Link
            key={item.key}
            to={wsPath(item.path)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            )}
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" />
            <span className="flex-1">{t(`nav.${item.key}` as any)}</span>
            {item.locked && (
              <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" aria-label="locked" />
            )}
          </Link>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="px-3 pb-2 space-y-0.5">
        {bottomNav.map(item => (
          <Link
            key={item.key}
            to={item.path === '#' ? '#' : wsPath(item.path)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all',
              isActive(item.path)
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
            )}
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" />
            <span>{t(`nav.${item.key}` as any)}</span>
          </Link>
        ))}

        {isAdmin && (
          <Link
            to="/admin"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-destructive hover:bg-destructive/10 transition-all"
          >
            <Shield className="h-[18px] w-[18px] shrink-0" />
            <span>Super Admin</span>
          </Link>
        )}
      </div>

      {/* User profile — click to open menu */}
      <div className="relative border-t border-sidebar-border px-3 py-3" ref={userMenuRef}>
        {/* User menu dropdown — opens upward */}
        {userMenuOpen && (
          <div className="absolute start-2 end-2 bottom-full mb-2 z-50 bg-popover border border-border rounded-xl shadow-2xl py-1 animate-fade-in max-h-[70vh] overflow-y-auto">
            {/* User info header */}
            <div className="px-4 py-3 border-b border-border flex items-center gap-3">
              <Avatar className="w-10 h-10 shrink-0">
                {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
                <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                  {userName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{userName}</p>
                <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
              </div>
            </div>

            {/* Verify email alert */}
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors">
              <AlertCircle className="h-4 w-4 text-warning shrink-0" />
              <span className="text-warning font-medium">{t('auth.verifyEmail')}</span>
            </button>

            <div className="border-t border-border my-1" />

            {/* Main actions */}
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.viewAlerts') || 'View alerts'}</span>
            </button>
            <button
              onClick={() => toggleInvisible.mutate()}
              disabled={toggleInvisible.isPending || !availability}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <EyeOff className={cn('h-4 w-4', invisible ? 'text-primary' : 'text-muted-foreground')} />
              <span className="flex-1 text-start">
                {invisible
                  ? 'Disable invisible mode'
                  : (t('nav.invisibleMode') || 'Enable invisible mode')}
              </span>
              {invisible && <Check className="h-4 w-4 text-primary shrink-0" />}
            </button>
            <RouterLink
              to={wsPath('/settings/availability')}
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.availability') || 'Availability settings'}</span>
            </RouterLink>

            <div className="border-t border-border my-1" />

            <RouterLink
              to={wsPath('/settings/profile')}
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <UserCog className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.manageAccount') || 'Manage account'}</span>
            </RouterLink>
            <RouterLink
              to={wsPath('/settings/general')}
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.workspaceSettings') || 'Workspace settings'}</span>
            </RouterLink>
            <RouterLink
              to={wsPath('/team')}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
              onClick={() => setUserMenuOpen(false)}
            >
              <UserPlus className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.inviteOperator') || 'Invite an operator'}</span>
            </RouterLink>

            <div className="border-t border-border my-1" />

            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-accent transition-colors">
              <HelpCircle className="h-4 w-4 text-primary" />
              <span className="text-primary font-medium">{t('nav.getHelp') || `Get help using ${platformName}`}</span>
            </button>
            <button className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span>{t('nav.whatsNew') || "What's new?"}</span>
            </button>

            <div className="border-t border-border my-1" />

            <button
              onClick={() => { setUserMenuOpen(false); signOut(); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              <span>{t('auth.logout')}</span>
            </button>
          </div>
        )}

        {/* Clickable user row */}
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="flex items-center gap-2.5 w-full rounded-lg px-1 py-1 hover:bg-sidebar-accent/50 transition-colors"
        >
          <div className="relative">
            <Avatar className="w-8 h-8 shrink-0">
              {userAvatarUrl ? <AvatarImage src={userAvatarUrl} alt={userName} /> : null}
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {userName.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar" />
          </div>
          <div className="min-w-0 flex-1 text-start">
            <p className="text-xs font-medium text-sidebar-foreground truncate">{userName}</p>
            <p className="text-[11px] text-sidebar-muted-foreground truncate">{userEmail}</p>
          </div>
        </button>

        {/* Language selector — hidden in single-language regions */}
        {canSwitchLanguage && (
        <div className="mt-2">
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="h-7 text-xs w-full border-sidebar-border">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedLocales.map(l => (
                <SelectItem key={l} value={l}>{LOCALE_CONFIG[l].nativeLabel}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        )}
      </div>
    </aside>
    <CreateWorkspaceDialog open={createWsOpen} onOpenChange={setCreateWsOpen} />
    </>
  );
}
