import { NavLink, Outlet, useParams, Link } from 'react-router-dom';
import {
  LayoutDashboard, Headphones, Phone, PhoneCall, Code2,
  Settings as SettingsIcon, Headset, Circle, AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCapabilities, useCallCenterOverview } from '@/hooks/useCallCenter';
import { Button } from '@/components/ui/button';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { callCenterApi } from '@/lib/call-center-api';
import { useAuth } from '@/features/auth/AuthContext';
import { useTranslation } from '@/i18n';

const ALL_TABS = [
  { to: '', icon: LayoutDashboard, label: 'Overview', end: true },
  { to: 'queue', icon: Headphones, label: 'Live Desk' },
  { to: 'calls', icon: Phone, label: 'Calls' },
  { to: 'callbacks', icon: PhoneCall, label: 'Callbacks', requiresCallback: true },
  { to: 'install', icon: Code2, label: 'Install Widget' },
  { to: 'settings', icon: SettingsIcon, label: 'Settings' },
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
  const tabs = ALL_TABS.filter((t) => !t.requiresCallback || callbackOn);

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

  let pill: React.ReactNode = <StatusPill tone="muted">Loading…</StatusPill>;
  if (caps) {
    if (!caps.platform_enabled) pill = <StatusPill tone="danger">Platform disabled</StatusPill>;
    else if (!caps.workspace_enabled) pill = <StatusPill tone="warn">Workspace disabled</StatusPill>;
    else if (overview && !overview.provider?.ready) pill = <StatusPill tone="warn">Provider missing</StatusPill>;
    else pill = <StatusPill tone="ok">Ready</StatusPill>;
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
                <h1 className="text-xl font-semibold leading-tight">{t('nav.callCenter') || 'Call Center'}</h1>
                {pill}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Standalone voice & video module — independent of chat.
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
              {isAvailable ? 'Available' : myStatus === 'away' ? 'Away' : 'Set Available'}
            </Button>
            <Button asChild size="sm" variant="outline"><Link to={`${base}/install`}>Install</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to={`${base}/settings`}><SettingsIcon className="h-4 w-4" /></Link></Button>
          </div>
        </div>
        <nav className="flex gap-1 px-4 overflow-x-auto">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              end={t.end as any}
              to={t.to ? `${base}/${t.to}` : base}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap',
                  isActive
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )
              }
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}