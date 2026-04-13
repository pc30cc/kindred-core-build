import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations } from '@/hooks/useConversations';
import { useOnlineVisitors } from '@/hooks/useVisitors';
import { useWidgetSettings } from '@/hooks/useWidgetSettings';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { MessageSquare, Eye, Activity, Zap, ArrowRight } from 'lucide-react';

export default function OverviewPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const { data: conversations } = useConversations(workspace?.id, 'open');
  const { data: visitors } = useOnlineVisitors(workspace?.id);
  const { data: widget } = useWidgetSettings(workspace?.id);

  const openCount = conversations?.length ?? 0;
  const onlineCount = visitors?.filter(v => v.status === 'online').length ?? 0;
  const widgetEnabled = widget?.enabled ?? false;

  const stats = [
    { icon: MessageSquare, label: t('dashboard.unreadConversations'), value: String(openCount), link: '/app/inbox' },
    { icon: Eye, label: t('dashboard.onlineVisitors'), value: String(onlineCount), link: '/app/visitors' },
    { icon: Activity, label: t('dashboard.recentActivity'), value: '—', link: '#' },
    { icon: Zap, label: t('dashboard.widgetStatus'), value: widgetEnabled ? t('widget.enabled') : t('widget.disabled'), link: '/app/widget' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <h1 className="text-2xl font-bold text-foreground">
        {t('dashboard.welcomeBack')}{workspace ? ` — ${workspace.name}` : ''}
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Link key={i} to={s.link} className="block">
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
                <s.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-foreground">{s.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.recentActivity')}</CardTitle>
          </CardHeader>
          <CardContent>
            {openCount > 0 ? (
              <div className="space-y-2">
                {conversations?.slice(0, 5).map(c => (
                  <div key={c.id} className="flex items-center justify-between py-1 text-sm">
                    <span className="truncate">{c.contacts?.name || c.subject || `#${c.id.slice(0, 8)}`}</span>
                    <span className="text-xs text-muted-foreground">{c.status}</span>
                  </div>
                ))}
                <Button variant="link" size="sm" asChild className="px-0">
                  <Link to="/app/inbox">{t('common.viewAll')} <ArrowRight className="h-3 w-3 ms-1" /></Link>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('dashboard.noActivity')}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.quickInstall')}</CardTitle>
          </CardHeader>
          <CardContent>
            {widgetEnabled ? (
              <p className="text-sm text-success">{t('widget.enabled')} ✓</p>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground mb-3">{t('widget.installInstructions')}</p>
                <Button size="sm" asChild>
                  <Link to="/app/widget">{t('widget.title')} <ArrowRight className="h-3 w-3 ms-1" /></Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
