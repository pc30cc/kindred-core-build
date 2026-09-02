import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminProfileCount, useAdminWorkspaceCount, useAdminFeatureFlags } from '@/hooks/useAdmin';
import { Users, Building2, Flag, Server } from 'lucide-react';
import { useTranslation } from '@/i18n';

export default function AdminDashboardPage() {
  const { t } = useTranslation();
  const { data: userCount } = useAdminProfileCount();
  const { data: wsCount } = useAdminWorkspaceCount();
  const { data: flags } = useAdminFeatureFlags();

  const stats = [
    { label: t('admin.dashboard.totalUsers' as any), value: userCount ?? '—', icon: Users },
    { label: t('admin.dashboard.totalWorkspaces' as any), value: wsCount ?? '—', icon: Building2 },
    { label: t('admin.dashboard.featureFlags' as any), value: flags?.length ?? '—', icon: Flag },
    { label: t('admin.dashboard.systemStatus' as any), value: t('admin.common.healthy' as any), icon: Server },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('admin.dashboard.title' as any)}</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map(s => (
          <Card key={s.label} className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
              <s.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground">{t('admin.dashboard.quickActions' as any)}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm space-y-2">
          {(['users', 'workspaces', 'providers', 'flags', 'audit'] as const).map(key => <p key={key}>• {t(`admin.dashboard.actions.${key}` as any)}</p>)}
        </CardContent>
      </Card>
    </div>
  );
}
