import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminProfileCount, useAdminWorkspaceCount, useAdminFeatureFlags } from '@/hooks/useAdmin';
import { Users, Building2, Flag, Server } from 'lucide-react';

export default function AdminDashboardPage() {
  const { data: userCount } = useAdminProfileCount();
  const { data: wsCount } = useAdminWorkspaceCount();
  const { data: flags } = useAdminFeatureFlags();

  const stats = [
    { label: 'Total Users', value: userCount ?? '—', icon: Users },
    { label: 'Total Workspaces', value: wsCount ?? '—', icon: Building2 },
    { label: 'Feature Flags', value: flags?.length ?? '—', icon: Flag },
    { label: 'System Status', value: 'Healthy', icon: Server },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-admin-foreground">Platform Dashboard</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map(s => (
          <Card key={s.label} className="bg-admin-card border-admin-border">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-admin-muted-foreground">{s.label}</CardTitle>
              <s.icon className="h-4 w-4 text-admin-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-admin-foreground">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-admin-card border-admin-border">
        <CardHeader>
          <CardTitle className="text-admin-foreground">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="text-admin-muted-foreground text-sm space-y-2">
          <p>• Manage users and assign roles from <strong className="text-admin-foreground">Users</strong></p>
          <p>• View all workspaces from <strong className="text-admin-foreground">Workspaces</strong></p>
          <p>• Configure platform providers from <strong className="text-admin-foreground">Providers</strong></p>
          <p>• Toggle features globally from <strong className="text-admin-foreground">Feature Flags</strong></p>
          <p>• Monitor activity from <strong className="text-admin-foreground">Audit Logs</strong></p>
        </CardContent>
      </Card>
    </div>
  );
}
