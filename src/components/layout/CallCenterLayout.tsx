/**
 * Call Center — module chrome.
 *
 * One masthead and one tab rail for every call-center surface. Two things it
 * does that the previous frame did not:
 *
 *  1. Live numbers live in the masthead, not only on the dashboard. An
 *     operator working the call log still needs to see that three people are
 *     waiting, without leaving the page they are on.
 *  2. The tab rail is one segmented track with a single underline marking
 *     the active surface, instead of seven separately-coloured pills. The
 *     module stops looking like seven unrelated tools.
 *
 * Every colour is a semantic token, so the chrome follows the app theme
 * rather than pinning its own palette.
 */
import { NavLink, Outlet, useParams, Link } from 'react-router-dom';
import {
  LayoutDashboard, Headphones, Phone, PhoneCall, Code2,
  Settings as SettingsIcon, Headset, AlertTriangle, CheckCircle2, Mic,
  Inbox, Activity, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCapabilities, useCallCenterOverview } from '@/hooks/useCallCenter';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { callCenterApi } from '@/lib/call-center-api';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { usePlanAccess } from '@/hooks/useEntitlements';
import { LiveDot, StatusChip, type Tone } from '@/features/calls/callCenterUi';

type TabDef = {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  i18nKey: string;
  end?: boolean;
  requiresCallback?: boolean;
  requiresRecording?: boolean;
  /** Plan feature the tab needs (the route refuses without it too). */
  planFeature?: string;
};

const ALL_TABS: TabDef[] = [
  { to: '', icon: LayoutDashboard, i18nKey: 'overview', end: true },
  { to: 'queue', icon: Headphones, i18nKey: 'queue', planFeature: 'call_queue' },
  { to: 'calls', icon: Phone, i18nKey: 'calls' },
  { to: 'callbacks', icon: PhoneCall, i18nKey: 'callbacks', requiresCallback: true, planFeature: 'call_callbacks' },
  { to: 'recordings', icon: Mic, i18nKey: 'recordings', requiresRecording: true, planFeature: 'call_recording' },
  { to: 'install', icon: Code2, i18nKey: 'install' },
  { to: 'settings', icon: SettingsIcon, i18nKey: 'settings' },
];

/** Presence states an operator can set for themselves from the masthead. */
const PRESENCE: Array<{ value: string; tone: Tone; i18nKey: string }> = [
  { value: 'available', tone: 'success', i18nKey: 'available' },
  { value: 'away', tone: 'warning', i18nKey: 'away' },
];

function CallCenterShell() {
  const { slug } = useParams();
  const { workspace } = useActiveWorkspace();
  const { user } = useAuth();
  const { t } = useTranslation();
  const base = `/${slug}/call-center`;
  const { data: caps } = useCallCenterCapabilities(workspace?.id);
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const qc = useQueryClient();

  // Hide the Callbacks tab until capabilities are loaded — prevents the
  // tab from flashing on refresh when it has been disabled. Require BOTH
  // platform-level and workspace-level callback flags.
  const callbackOn =
    !!caps &&
    caps.platform_callback_enabled !== false &&
    caps.effective?.callback_enabled !== false;
  // Recordings tab is hidden entirely when the platform admin has turned off
  // call recording — operators should not see the surface at all in that case.
  const recordingOn =
    !!caps?.recording?.enabled_by_platform && !!caps?.recording?.enabled_by_plan;
  const plan = usePlanAccess(workspace?.id);
  const tabs = ALL_TABS.filter(
    (tab) =>
      (!tab.requiresCallback || callbackOn) &&
      (!tab.requiresRecording || recordingOn) &&
      (!tab.planFeature || plan.feature(tab.planFeature)),
  );

  const { data: agentStatus } = useQuery({
    queryKey: ['call-center', 'agent-status', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: () => callCenterApi.getAgentStatus(workspace!.id),
    refetchInterval: 15000,
  });
  const myStatus =
    (agentStatus?.agents || []).find((a: { user_id?: string }) => a.user_id === user?.id)?.status
    || 'offline';

  const setStatus = useMutation({
    mutationFn: (s: string) => callCenterApi.updateAgentStatus(workspace!.id, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'agent-status'] }),
  });

  // Readiness of the module itself, shown next to the title.
  let readiness: { tone: Tone; label: string; icon?: React.ComponentType<{ className?: string }> } = {
    tone: 'neutral', label: t('callCenter.layout.pill.loading'),
  };
  if (caps) {
    if (!caps.platform_enabled) {
      readiness = { tone: 'danger', label: t('callCenter.layout.pill.platformDisabled'), icon: AlertTriangle };
    } else if (!caps.workspace_enabled) {
      readiness = { tone: 'warning', label: t('callCenter.layout.pill.workspaceDisabled'), icon: AlertTriangle };
    } else if (overview && !overview.provider?.ready) {
      readiness = { tone: 'warning', label: t('callCenter.layout.pill.providerMissing'), icon: AlertTriangle };
    } else {
      readiness = { tone: 'success', label: t('callCenter.layout.pill.ready'), icon: CheckCircle2 };
    }
  }

  const isAvailable = myStatus === 'available';
  const presenceTone: Tone = isAvailable ? 'success' : myStatus === 'away' ? 'warning' : 'neutral';
  const presenceLabel = isAvailable
    ? t('callCenter.layout.presence.available')
    : myStatus === 'away'
      ? t('callCenter.layout.presence.away')
      : t('callCenter.layout.presence.setAvailable');

  const waiting = overview?.waiting_calls ?? 0;
  const active = overview?.active_calls ?? 0;

  return (
    <div className="flex h-full flex-col bg-background">
      <header
        className={cn(
          'relative shrink-0 overflow-hidden border-b border-border/60',
          // A single wash from the brand accent rather than a second palette.
          'bg-gradient-to-b from-primary/[0.07] via-background to-background',
        )}
      >
        {/* Ambient accent — kept faint so it frames the header without
            competing with the live numbers sitting on top of it. */}
        <div className="pointer-events-none absolute -top-24 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />

        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pb-3 pt-4">
          <div className="flex min-w-[220px] flex-1 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-[var(--shadow-glow)]">
              <Headset className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold leading-tight">
                {t('callCenter.layout.headerTitle')}
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t('callCenter.layout.headerSubtitle')}
              </p>
            </div>
          </div>

          {/* Live counters — visible from every tab, not just the dashboard. */}
          <div className="flex items-center gap-1.5">
            <StatusChip tone={waiting > 0 ? 'warning' : 'neutral'} icon={Inbox}>
              <span className="tabular-nums font-semibold">{waiting}</span>
              <span className="opacity-70">{t('callCenter.queue.chips.waiting')}</span>
            </StatusChip>
            <StatusChip tone={active > 0 ? 'success' : 'neutral'} icon={Activity} pulse={active > 0}>
              <span className="tabular-nums font-semibold">{active}</span>
              <span className="opacity-70">{t('callCenter.queue.chips.active')}</span>
            </StatusChip>
            <StatusChip tone={readiness.tone} icon={readiness.icon} className="hidden sm:inline-flex">
              {readiness.label}
            </StatusChip>
          </div>

          <div className="ms-auto flex items-center gap-1.5">
            {/* Presence is a menu rather than a toggle: an operator should be
                able to read their current state without inferring it from a
                button that names the state they are NOT in. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  disabled={setStatus.isPending || !caps?.workspace_call_center_visible}
                >
                  <LiveDot tone={presenceTone} pulse={isAvailable} />
                  {presenceLabel}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                {PRESENCE.map((p) => (
                  <DropdownMenuItem
                    key={p.value}
                    onClick={() => setStatus.mutate(p.value)}
                    className="gap-2"
                  >
                    <LiveDot tone={p.tone} />
                    {t(`callCenter.layout.presence.${p.i18nKey}` as never)}
                    {myStatus === p.value && <CheckCircle2 className="ms-auto h-3.5 w-3.5 text-success" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button asChild size="sm" variant="ghost">
              <Link to={`${base}/install`}>{t('callCenter.layout.install')}</Link>
            </Button>
            <Button asChild size="icon" variant="ghost" className="h-8 w-8">
              <Link to={`${base}/settings`} aria-label={t('callCenter.layout.tabs.settings')}>
                <SettingsIcon className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>

        {/* Tab rail — a single segmented track, so the tabs read as one
            control instead of seven separately-coloured buttons. */}
        <nav className="relative flex gap-1 overflow-x-auto px-4 pb-2">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              end={tab.end}
              to={tab.to ? `${base}/${tab.to}` : base}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2',
                  'text-sm transition-colors',
                  isActive
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <tab.icon className={cn('h-4 w-4 transition-colors', isActive && 'text-primary')} />
                  <span>{t(`callCenter.layout.tabs.${tab.i18nKey}` as never)}</span>
                  {/* Underline marks the active tab; no filled pill, so the
                      rail stays quiet while still being unambiguous. */}
                  <span
                    className={cn(
                      'absolute inset-x-2 -bottom-2 h-0.5 rounded-full transition-all',
                      isActive ? 'bg-primary opacity-100' : 'bg-transparent opacity-0',
                    )}
                  />
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1 overflow-y-auto p-5">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The Call Center route. Nothing of it mounts — not even the masthead with
 * its live counters — unless the plan includes `call_center` and the same
 * visibility switch the sidebar uses says this member may see it (off for
 * operators while the workspace has the call center switched off).
 */
export function CallCenterLayout() {
  return (
    <PlanLockedOverlay moduleKey="call_center">
      <CallCenterVisibility>
        <CallCenterShell />
      </CallCenterVisibility>
    </PlanLockedOverlay>
  );
}

function CallCenterVisibility({ children }: { children: React.ReactNode }) {
  const { workspace } = useActiveWorkspace();
  const { t, dir } = useTranslation();
  const { data: caps, isError } = useCallCenterCapabilities(workspace?.id);
  if (!caps && !isError) {
    return (
      <div className="p-8 space-y-4" dir={dir}>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (caps?.workspace_call_center_visible === true) return <>{children}</>;
  return (
    <div className="flex items-start justify-center p-8" dir={dir}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Headset className="h-7 w-7 text-muted-foreground" />
        </div>
        <h2 className="mb-2 text-lg font-semibold">{t('callCenter.layout.unavailableTitle')}</h2>
        <p className="text-sm text-muted-foreground">
          {caps && !caps.platform_enabled
            ? t('callCenter.layout.unavailablePlatform')
            : t('callCenter.layout.unavailableWorkspace')}
        </p>
      </div>
    </div>
  );
}
