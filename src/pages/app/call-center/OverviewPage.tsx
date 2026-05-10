import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterOverview, useCallCenterSettings } from '@/hooks/useCallCenter';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

export default function CallCenterOverviewPage() {
  const { workspace } = useActiveWorkspace();
  const { data: overview, isLoading } = useCallCenterOverview(workspace?.id);
  const { data: settings } = useCallCenterSettings(workspace?.id);
  const platformDisabled = settings?.platform && !settings.platform.call_center_enabled;
  const wsDisabled = settings?.settings && !settings.settings.enabled;
  const providerNotReady = overview && overview.provider && !overview.provider.ready;

  return (
    <div className="space-y-6">
      {platformDisabled && (
        <Card className="p-4 border-destructive/50 bg-destructive/5 flex gap-3 items-start">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          <div>
            <p className="font-medium">Call Center is disabled by the platform</p>
            <p className="text-sm text-muted-foreground">Contact your administrator.</p>
          </div>
        </Card>
      )}
      {!platformDisabled && wsDisabled && (
        <Card className="p-4 border-warning/50 bg-warning/5 flex gap-3 items-start">
          <AlertCircle className="h-5 w-5 text-warning shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Call Center is available on your plan but disabled for this workspace.</p>
            <p className="text-sm text-muted-foreground">Enable it in Settings to start receiving calls.</p>
          </div>
          <Button asChild size="sm" variant="outline"><Link to="settings">Open Settings</Link></Button>
        </Card>
      )}
      {!platformDisabled && providerNotReady && (
        <Card className="p-4 border-warning/50 bg-warning/5 flex gap-3 items-start">
          <AlertCircle className="h-5 w-5 text-warning shrink-0" />
          <div>
            <p className="font-medium">No call provider configured</p>
            <p className="text-sm text-muted-foreground">Configure a call provider in admin to accept calls.</p>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Today calls" value={isLoading ? '—' : overview?.today_calls ?? 0} />
        <Stat label="Waiting" value={overview?.waiting_calls ?? 0} />
        <Stat label="Active" value={overview?.active_calls ?? 0} />
        <Stat label="Missed today" value={overview?.missed_today ?? 0} />
        <Stat label="Callbacks pending" value={overview?.callbacks_pending ?? 0} />
      </div>
      <Card className="p-4 flex items-center gap-3">
        {overview?.provider?.ready ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <AlertCircle className="h-5 w-5 text-warning" />
        )}
        <div>
          <div className="text-sm font-medium">Provider: {overview?.provider?.provider || '—'}</div>
          <div className="text-xs text-muted-foreground">
            {overview?.provider?.ready ? 'Ready' : (overview?.provider?.error || 'Not configured')}
          </div>
        </div>
      </Card>
    </div>
  );
}
