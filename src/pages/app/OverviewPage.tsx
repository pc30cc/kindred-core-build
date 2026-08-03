import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useConversations } from '@/hooks/useConversations';
import { useOnlineVisitors } from '@/hooks/useVisitors';
import { useKBArticles } from '@/hooks/useKnowledgeBase';
import GetStartedWizard from '@/components/app/GetStartedWizard';
import { MessageSquare, Users, BookOpen, Eye, Inbox, Bot, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export default function OverviewPage() {
  const { t, locale, dir } = useTranslation();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const wsPath = useWorkspacePath();
  const { data: conversations } = useConversations(workspace?.id);
  const { data: visitors } = useOnlineVisitors(workspace?.id);
  const { data: articles } = useKBArticles(workspace?.id);

  const openConvos = conversations?.filter(c => c.status === 'open').length ?? 0;
  const totalConvos = conversations?.length ?? 0;
  const onlineVisitors = visitors?.filter(v => v.status === 'online').length ?? 0;
  const articleCount = articles?.length ?? 0;

  const numberLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  const formatNumber = (value: number) => value.toLocaleString(numberLocale);

  const statCards = [
    { label: t('dashboard.statOpenConversations'), value: openConvos, icon: Inbox, color: 'text-primary', bg: 'bg-primary/10' },
    { label: t('dashboard.statOnlineVisitors'), value: onlineVisitors, icon: Eye, color: 'text-success', bg: 'bg-success/10' },
    { label: t('dashboard.statTotalConversations'), value: totalConvos, icon: MessageSquare, color: 'text-info', bg: 'bg-info/10' },
    { label: t('dashboard.statKbArticles'), value: articleCount, icon: BookOpen, color: 'text-warning', bg: 'bg-warning/10' },
  ];

  const quickActions = [
    { label: t('dashboard.openInbox'), icon: Inbox, path: wsPath('/inbox'), color: 'bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20' },
    { label: t('dashboard.manageContacts'), icon: Users, path: wsPath('/contacts'), color: 'bg-info/10 text-info hover:bg-info/20 border border-info/20' },
    { label: t('dashboard.manageKb'), icon: BookOpen, path: wsPath('/knowledge-base'), color: 'bg-warning/10 text-warning hover:bg-warning/20 border border-warning/20' },
    { label: t('dashboard.aiAgent'), icon: Bot, path: wsPath('/ai'), color: 'bg-success/10 text-success hover:bg-success/20 border border-success/20' },
  ];

  return (
    <div dir={dir} className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-header">{t('dashboard.welcomeBack')}</h1>
          <p className="page-subtitle">
            {workspace?.name ? `${t('dashboard.workspaceLabel')}: ${workspace.name}` : platformName}
          </p>
        </div>
        <div className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('dashboard.quickActions')}</p>
        <div className="flex flex-wrap gap-2">
        {quickActions.map(action => (
          <Link
            key={action.label}
            to={action.path}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium transition-all ${action.color}`}
          >
            <action.icon className="w-4 h-4" />
            {action.label}
          </Link>
        ))}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statCards.map((stat) => (
          <div key={stat.label} className="stat-card group">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${stat.bg}`}>
                <stat.icon className={`w-4 h-4 ${stat.color}`} />
              </div>
              <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <div className="text-2xl font-bold text-foreground">{formatNumber(stat.value)}</div>
            <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Get Started Wizard */}
      <GetStartedWizard />

      {/* Empty state */}
      <div className="mt-8 flex flex-col items-center justify-center text-center">
        <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
          <span className="text-2xl font-black text-primary">{(platformName || 'A').charAt(0)}</span>
        </div>
        <h2 className="text-xl font-semibold text-foreground">{platformName}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('dashboard.subtitle')}
        </p>
      </div>
    </div>
  );
}
