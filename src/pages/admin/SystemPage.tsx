import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAdminRuntimeConfig } from '@/hooks/useAdmin';
import { CheckCircle } from 'lucide-react';

export default function AdminSystemPage() {
  const { data: config } = useAdminRuntimeConfig();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-admin-foreground">System Overview</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-admin-card border-admin-border">
          <CardHeader>
            <CardTitle className="text-admin-foreground text-sm">System Health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {['Database', 'Auth Service', 'Realtime', 'Storage', 'Edge Functions'].map(s => (
              <div key={s} className="flex items-center justify-between">
                <span className="text-admin-muted-foreground text-sm">{s}</span>
                <Badge className="bg-success/20 text-success gap-1">
                  <CheckCircle className="h-3 w-3" /> Healthy
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-admin-card border-admin-border">
          <CardHeader>
            <CardTitle className="text-admin-foreground text-sm">Runtime Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {config?.length === 0 && <p className="text-admin-muted-foreground text-sm">No runtime config entries</p>}
            {config?.map(c => (
              <div key={c.key} className="flex items-center justify-between">
                <span className="text-admin-muted-foreground font-mono text-sm">{c.key}</span>
                <span className="text-admin-muted-foreground text-xs truncate max-w-[200px]">
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
