import { NavLink, Outlet, useParams, Link } from 'react-router-dom';
import {
  LayoutDashboard, Headphones, Phone, PhoneCall, Code2,
  Settings as SettingsIcon, Headset, Circle, AlertTriangle,
  CheckCircle2, Mic,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCapabilities, useCallCenterOverview } from '@/hooks/useCallCenter';
import { Button } from '@/components/ui/button';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { callCenterApi } from '@/lib/call-center-api';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { AI_ACCENT, type AiAccent } from '@/components/ai-agent/AiPageHeader';

type TabDef = {
  to: string;
  icon: any;
  i18nKey: string;
  end?: boolean;
  requiresCallback?: boolean;
  requiresRecording?: boolean;
  accent: AiAccent;
};

const ALL_TABS: TabDef[] = [
  { to: '', icon: LayoutDashboard, i18nKey: 'overview', end: true, accent: 'indigo' },
  { to: 'queue', icon: Headphones, i18nKey: 'queue', accent: 'emerald' },
  { to: 'calls', icon: Phone, i18nKey: 'calls', accent: 'sky' },
  { to: 'callbacks', icon: PhoneCall, i18nKey: 'callbacks', requiresCallback: true, accent: 'amber' },
  { to: 'recordings', icon: Mic, i18nKey: 'recordings', requiresRecording: true, accent: 'rose' },
  { to: 'install', icon: Code2, i18nKey: 'install', accent: 'cyan' },
  { to: 'settings', icon: SettingsIcon, i18nKey: 'settings', accent: 'violet' },
];

function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted'; children: React.ReactNode }) {
  const map: Record<string, string> = {
    ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    danger: 'bg-destructive/10 text-destructive border-destructive/30',
    muted: 'bg-muted text-muted-foreground border-border',
  };
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'danger' ? AlertTriangle : tone === 'warn' ? AlertTriangle : Circle;
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium', map[tone])}>
      <Icon className="h-3 w-3" />{children}
    </span>
  );
}

export function CallCenterLayout() {
  const { slug } = useParams();
  const { workspace } = useActiveWorkspace();
  const { user } = useAuth();
  const { t } = useTranslation();
  const base = `/app/w/${slug}/call-center`;
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
  const tabs = ALL_TABS.filter(
    (tab) =>
      (!tab.requiresCallback || callbackOn) &&
      (!tab.requiresRecording || recordingOn),
  );

  const { data: agentStatus } = useQuery({
    queryKey: ['call-center', 'agent-status', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: () => callCenterApi.getAgentStatus(workspace!.id),
    refetchInterval: 15000,
  });
  const myStatus = (agentStatus?.agents || []).find((a: any) => a.user_id === user?.id)?.status || 'offline';

  const setStatus = useMutation({
    mutationFn: (s: string) => callCenterApi.updateAgentStatus(workspace!.id, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'agent-status'] }),
  });

  let pill: React.ReactNode = <StatusPill tone="muted">{t('callCenter.layout.pill.loading')}</StatusPill>;
  if (caps) {
    if (!caps.platform_enabled) pill = <StatusPill tone="danger">{t('callCenter.layout.pill.platformDisabled')}</StatusPill>;
    else if (!caps.workspace_enabled) pill = <StatusPill tone="warn">{t('callCenter.layout.pill.workspaceDisabled')}</StatusPill>;
    else if (overview && !overview.provider?.ready) pill = <StatusPill tone="warn">{t('callCenter.layout.pill.providerMissing')}</StatusPill>;
    else pill = <StatusPill tone="ok">{t('callCenter.layout.pill.ready')}</StatusPill>;
  }

  const isAvailable = myStatus === 'available';

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-b border-border bg-gradient-to-r from-primary/5 via-background to-background">
        <div className="px-6 pt-5 pb-4 flex items-start gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1 min-w-[240px]">
            <div className="h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center ring-1 ring-primary/20">
              <Headset className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold leading-tight">{t('callCenter.layout.headerTitle')}</h1>
                {pill}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('callCenter.layout.headerSubtitle')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 ms-auto">
            <Button
              size="sm"
              variant={isAvailable ? 'default' : 'outline'}
              onClick={() => setStatus.mutate(isAvailable ? 'away' : 'available')}
              disabled={setStatus.isPending || !caps?.workspace_call_center_visible}
            >
              <span className={cn('h-2 w-2 rounded-full me-2', isAvailable ? 'bg-emerald-400' : 'bg-amber-400')} />
              {isAvailable
                ? t('callCenter.layout.presence.available')
                : myStatus === 'away'
                  ? t('callCenter.layout.presence.away')
                  : t('callCenter.layout.presence.setAvailable')}
            </Button>
            <Button asChild size="sm" variant="outline"><Link to={`${base}/install`}>{t('callCenter.layout.install')}</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to={`${base}/settings`}><SettingsIcon className="h-4 w-4" /></Link></Button>
          </div>
        </div>
        <nav className="flex gap-1 px-4 overflow-x-auto">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              end={tab.end as any}
              to={tab.to ? `${base}/${tab.to}` : base}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap',
                  isActive
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )
              }
            >
              <tab.icon className="h-4 w-4" />
              {t(`callCenter.layout.tabs.${tab.i18nKey}` as any)}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        <PlanLockedOverlay moduleKey="call_center">
          <Outlet />
        </PlanLockedOverlay>
      </main>
    </div>
  );
}