import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MessageSquare, Eye, Activity, Zap } from 'lucide-react';

export default function OverviewPage() {
  const { t } = useTranslation();

  const stats = [
    { icon: MessageSquare, label: t('dashboard.unreadConversations'), value: '0' },
    { icon: Eye, label: t('dashboard.onlineVisitors'), value: '0' },
    { icon: Activity, label: t('dashboard.recentActivity'), value: '—' },
    { icon: Zap, label: t('dashboard.widgetStatus'), value: t('widget.disabled') },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">{t('dashboard.welcomeBack')}</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
              <s.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-foreground">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.recentActivity')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t('dashboard.noActivity')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.quickInstall')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t('widget.installInstructions')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
