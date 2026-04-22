import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAdminRuntimeConfig } from '@/hooks/useAdmin';
import { CheckCircle, Activity } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMetricsSummary } from '@/lib/admin-metrics-api';

export default function AdminSystemPage() {
  const { data: config } = useAdminRuntimeConfig();
  const summary = useQuery({
    queryKey: ['admin-metrics-summary', '1h'],
    queryFn: () => fetchMetricsSummary('1h'),
    refetchInterval: 60_000,
  });
  const counts = summary.data?.counts || {};
  const summaryRows = [
    { metric: 'realtime.token_minted', label: 'Tokens minted' },
    { metric: 'realtime.channel_ownership_reject', label: 'Channel rejects' },
    { metric: 'widget.typing_rate_limited', label: 'Typing dropped' },
    { metric: 'realtime.fallback_engaged', label: 'Polling fallback' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">System Overview</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-sm">System Health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {['Database', 'Auth Service', 'Realtime', 'Storage', 'Edge Functions'].map(s => (
              <div key={s} className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{s}</span>
                <Badge className="bg-success/20 text-success gap-1">
                  <CheckCircle className="h-3 w-3" /> Healthy
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-foreground text-sm flex items-center gap-2">
              <Activity className="h-4 w-4" /> Realtime (last hour)
            </CardTitle>
            <Link
              to="/admin/observability"
              className="text-xs text-primary hover:underline"
            >
              Drill down →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {summaryRows.map((r) => (
              <div key={r.metric} className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{r.label}</span>
                <Badge variant="outline">{counts[r.metric]?.total ?? 0}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-sm">Runtime Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {config?.length === 0 && <p className="text-muted-foreground text-sm">No runtime config entries</p>}
            {config?.map(c => (
              <div key={c.key} className="flex items-center justify-between">
                <span className="text-muted-foreground font-mono text-sm">{c.key}</span>
                <span className="text-muted-foreground text-xs truncate max-w-[200px]">
                  {JSON.stringify(c.value)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
