import { useActiveWorkspace } from '@/hooks/useWorkspace';
import {
  useCallCenterOverview, useCallCenterSettings, useCallCenterQueue,
  useCallCenterCalls, useCallCenterCallbacks,
} from '@/hooks/useCallCenter';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  AlertCircle, CheckCircle2, Circle, Phone, PhoneCall, Clock,
  PhoneIncoming, PhoneMissed, Users, Server, Globe,
  ArrowRight, ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/utils';

function StatCard({ icon: Icon, label, value, tone = 'default' }: { icon: any; label: string; value: React.ReactNode; tone?: 'default' | 'warn' | 'danger' | 'ok' }) {
  const map: Record<string, string> = {
    default: 'bg-card',
    warn: 'bg-amber-500/5 border-amber-500/30',
    danger: 'bg-destructive/5 border-destructive/30',
    ok: 'bg-emerald-500/5 border-emerald-500/30',
  };
  return (
    <Card className={cn('p-4 flex items-start gap-3', map[tone])}>
      <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold leading-tight mt-0.5">{value}</div>
      </div>
    </Card>
  );
}

function ChecklistItem({ status, label, action }: { status: 'ok' | 'warn' | 'missing'; label: string; action?: { to: string; label: string } }) {
  const Icon = status === 'ok' ? CheckCircle2 : status === 'warn' ? AlertCircle : Circle;
  const color = status === 'ok' ? 'text-emerald-500' : status === 'warn' ? 'text-amber-500' : 'text-destructive';
  return (
    <div className="flex items-center gap-3 py-2 px-1">
      <Icon className={cn('h-4 w-4 shrink-0', color)} />
      <span className="text-sm flex-1">{label}</span>
      {status !== 'ok' && action && (
        <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
          <Link to={action.to}>{action.label} <ArrowRight className="h-3 w-3 ms-1" /></Link>
        </Button>
      )}
    </div>
  );
}

export default function CallCenterOverviewPage() {
  const { workspace } = useActiveWorkspace();
  const { data: overview } = useCallCenterOverview(workspace?.id);
  const { data: settings } = useCallCenterSettings(workspace?.id);
  const { data: queueData } = useCallCenterQueue(workspace?.id);
  const { data: callsData } = useCallCenterCalls(workspace?.id);
  const { data: callbacksData } = useCallCenterCallbacks(workspace?.id);

  const platformOk = !!settings?.platform?.call_center_enabled;
  const wsEnabled = !!settings?.settings?.enabled;
  const providerReady = !!overview?.provider?.ready;
  const allowedDomains = settings?.settings?.allowed_domains || [];
  const hasDomains = allowedDomains.length > 0;
  const hasPublicKey = !!settings?.settings?.public_key;
  const voiceVideo = !!(settings?.settings?.voice_enabled || settings?.settings?.video_enabled);

  let statusTone: 'ok' | 'warn' | 'danger' = 'ok';
  let statusText = 'Ready';
  let cta: { to: string; label: string } = { to: 'queue', label: 'Open Live Desk' };
  if (!platformOk) { statusTone = 'danger'; statusText = 'Disabled by platform'; cta = { to: 'settings', label: 'View Settings' }; }
  else if (!wsEnabled) { statusTone = 'warn'; statusText = 'Disabled for workspace'; cta = { to: 'settings', label: 'Enable in Settings' }; }
  else if (!providerReady) { statusTone = 'warn'; statusText = 'Calls service not ready'; cta = { to: 'settings', label: 'View Settings' }; }
  else if (!hasDomains) { statusTone = 'warn'; statusText = 'No allowed domains'; cta = { to: 'install', label: 'Add domain' }; }

  const recentQueue = (queueData?.queue || []).slice(0, 5);
  const recentMissed = (callsData?.calls || []).filter((c) => c.state === 'missed').slice(0, 3);
  const recentCallbacks = (callbacksData?.callbacks || []).slice(0, 3);

  return (
    <div className="space-y-6">
      {/* Hero status */}
      <Card className={cn('p-5 border-2',
        statusTone === 'ok' && 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 to-transparent',
        statusTone === 'warn' && 'border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent',
        statusTone === 'danger' && 'border-destructive/30 bg-gradient-to-br from-destructive/5 to-transparent',
      )}>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Call Center status</div>
            <div className="text-2xl font-semibold mt-1 flex items-center gap-2">
              {statusTone === 'ok' ? <CheckCircle2 className="h-6 w-6 text-emerald-500" /> :
                statusTone === 'danger' ? <AlertCircle className="h-6 w-6 text-destructive" /> :
                <AlertCircle className="h-6 w-6 text-amber-500" />}
              {statusText}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Calls service</div>
                <div className="font-medium">{providerReady ? 'Ready' : 'Not ready'}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Allowed domains</div>
                <div className="font-medium">{allowedDomains.length}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Public key</div>
                <div className="font-medium">{hasPublicKey ? 'configured' : '—'}</div>
              </div>
            </div>
          </div>
          <Button asChild size="lg"><Link to={cta.to}>{cta.label} <ArrowRight className="h-4 w-4 ms-1" /></Link></Button>
        </div>
      </Card>

      {/* Live ops */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Live operations</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={Clock} label="Waiting" value={overview?.waiting_calls ?? 0} tone={(overview?.waiting_calls ?? 0) > 0 ? 'warn' : 'default'} />
          <StatCard icon={PhoneIncoming} label="Active" value={overview?.active_calls ?? 0} tone={(overview?.active_calls ?? 0) > 0 ? 'ok' : 'default'} />
          <StatCard icon={PhoneMissed} label="Missed today" value={overview?.missed_today ?? 0} tone={(overview?.missed_today ?? 0) > 0 ? 'danger' : 'default'} />
          <StatCard icon={Phone} label="Total today" value={overview?.today_calls ?? 0} />
          <StatCard icon={PhoneCall} label="Callbacks" value={overview?.callbacks_pending ?? 0} />
          <StatCard icon={Server} label="Calls service" value={providerReady ? 'Ready' : 'Down'} tone={providerReady ? 'ok' : 'warn'} />
        </div>
      </div>

      {/* Activity preview + checklist */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Recent activity</h3>
            <Button asChild size="sm" variant="ghost"><Link to="queue">View all</Link></Button>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Waiting</div>
            {recentQueue.length === 0 ? (
              <p className="text-sm text-muted-foreground">No calls in queue.</p>
            ) : (
              <ul className="divide-y">
                {recentQueue.map((q) => (
                  <li key={q.id} className="py-2 flex items-center gap-2 text-sm">
                    {q.channel === 'video' ? <PhoneIncoming className="h-3.5 w-3.5 text-primary" /> : <Phone className="h-3.5 w-3.5 text-primary" />}
                    <span className="flex-1 truncate">{q.call_session?.visitor_name || q.call_session?.visitor_email || 'Anonymous'}</span>
                    <span className="text-xs text-muted-foreground">{new Date(q.created_at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {recentMissed.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Missed today</div>
              <ul className="divide-y">
                {recentMissed.map((c) => (
                  <li key={c.id} className="py-2 flex items-center gap-2 text-sm">
                    <PhoneMissed className="h-3.5 w-3.5 text-destructive" />
                    <span className="flex-1 truncate">{c.visitor_name || c.visitor_email || 'Anonymous'}</span>
                    <span className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recentCallbacks.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Recent callbacks</div>
              <ul className="divide-y">
                {recentCallbacks.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`callbacks?focus=${c.id}`}
                      className="py-2 flex items-center gap-2 text-sm hover:bg-muted/40 rounded px-2 -mx-2 transition"
                    >
                      <PhoneCall className="h-3.5 w-3.5 text-primary" />
                      <span className="flex-1 truncate">{(c.metadata as any)?.name || c.contact_phone || c.contact_email || 'Anonymous'}</span>
                      <span className="text-xs text-muted-foreground">{c.status}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <ListChecks className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">Setup checklist</h3>
          </div>
          <div className="divide-y">
            <ChecklistItem status={platformOk ? 'ok' : 'missing'} label="Platform enabled" />
            <ChecklistItem status={wsEnabled ? 'ok' : 'warn'} label="Workspace enabled" action={{ to: 'settings', label: 'Enable' }} />
            <ChecklistItem status={voiceVideo ? 'ok' : 'warn'} label="Voice or video enabled" action={{ to: 'settings', label: 'Configure' }} />
            <ChecklistItem status={providerReady ? 'ok' : 'missing'} label="Calls service ready" />
            <ChecklistItem status={hasDomains ? 'ok' : 'missing'} label="Allowed domain added" action={{ to: 'install', label: 'Add' }} />
            <ChecklistItem status={hasPublicKey ? 'ok' : 'warn'} label="Public key generated" />
          </div>
        </Card>
      </div>
    </div>
  );
}