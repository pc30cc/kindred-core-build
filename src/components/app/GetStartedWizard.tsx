import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  ArrowRight, Code, MessageSquare, Mail, Smartphone,
  Palette, BookOpen, Bot, Users, Zap, Download, ChevronDown,
  Clock, X, Globe, Blocks,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface WizardTask {
  key: string;
  icon: React.ReactNode;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  subPath: string;
  trialDays?: number;
  featured?: boolean;
  featureIcons?: React.ReactNode[];
}

const SECTION_TASKS: Record<string, WizardTask[]> = {
  connect: [
    {
      key: 'install_widget', icon: <Code className="w-5 h-5" />, titleKey: 'wizard.installWidget', descKey: 'wizard.installWidgetDesc', subPath: '/widget', trialDays: 6, featured: true,
      featureIcons: [<MessageSquare key="1" className="w-5 h-5" />, <Globe key="2" className="w-5 h-5" />, <Blocks key="3" className="w-5 h-5" />],
    },
    {
      key: 'connect_channels', icon: <MessageSquare className="w-5 h-5" />, titleKey: 'wizard.connectChannels', descKey: 'wizard.connectChannelsDesc', subPath: '/settings/providers', trialDays: 3, featured: true,
      featureIcons: [<Mail key="1" className="w-5 h-5" />, <MessageSquare key="2" className="w-5 h-5" />],
    },
    { key: 'connect_email', icon: <Mail className="w-5 h-5" />, titleKey: 'wizard.connectEmail', descKey: 'wizard.connectEmailDesc', subPath: '/email', trialDays: 2 },
    { key: 'mobile_app', icon: <Smartphone className="w-5 h-5" />, titleKey: 'wizard.mobileApp', descKey: 'wizard.mobileAppDesc', subPath: '#', trialDays: 2 },
  ],
  customize: [
    { key: 'customize_widget', icon: <Palette className="w-5 h-5" />, titleKey: 'wizard.customizeWidget', descKey: 'wizard.customizeWidgetDesc', subPath: '/widget', trialDays: 2 },
    { key: 'knowledge_base', icon: <BookOpen className="w-5 h-5" />, titleKey: 'wizard.knowledgeBase', descKey: 'wizard.knowledgeBaseDesc', subPath: '/knowledge-base', trialDays: 4 },
    { key: 'setup_ai', icon: <Bot className="w-5 h-5" />, titleKey: 'wizard.setupAI', descKey: 'wizard.setupAIDesc', subPath: '/ai', trialDays: 2 },
  ],
  grow: [
    { key: 'shortcuts', icon: <Zap className="w-5 h-5" />, titleKey: 'wizard.shortcuts', descKey: 'wizard.shortcutsDesc', subPath: '/settings/general', trialDays: 2 },
    { key: 'invite_team', icon: <Users className="w-5 h-5" />, titleKey: 'wizard.inviteTeam', descKey: 'wizard.inviteTeamDesc', subPath: '/team', trialDays: 2 },
    { key: 'import_contacts', icon: <Download className="w-5 h-5" />, titleKey: 'wizard.importContacts', descKey: 'wizard.importContactsDesc', subPath: '/contacts', trialDays: 2 },
  ],
};

const ALL_TASKS = [...SECTION_TASKS.connect, ...SECTION_TASKS.customize, ...SECTION_TASKS.grow];

export default function GetStartedWizard() {
  const { t } = useTranslation();
  const { platformName } = useBrandingContext();
  const [hidden, setHidden] = useState(false);
  const [completedTasks] = useState<string[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ connect: true, customize: false, grow: false });

  if (hidden) return null;

  const totalTrialDays = ALL_TASKS.reduce((s, t) => s + (t.trialDays || 0), 0);
  const collectedDays = ALL_TASKS.filter(t => completedTasks.includes(t.key)).reduce((s, t) => s + (t.trialDays || 0), 0);
  const progressPercent = totalTrialDays > 0 ? (collectedDays / totalTrialDays) * 100 : 0;

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const sectionLabels: Record<string, TranslationKey> = {
    connect: 'wizard.sectionConnect',
    customize: 'wizard.sectionCustomize',
    grow: 'wizard.sectionGrow',
  };

  return (
    <div className="space-y-5">
      {/* Progress card */}
      <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('wizard.title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {collectedDays} / {totalTrialDays} {t('wizard.trialDaysCollected')}
            </p>
          </div>
          <button
            onClick={() => setHidden(true)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <Progress value={progressPercent} className="h-1.5" />
      </div>

      {/* Sections */}
      {Object.entries(SECTION_TASKS).map(([sectionKey, tasks]) => {
        const isOpen = expandedSections[sectionKey];
        return (
          <div key={sectionKey} className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
            <button
              onClick={() => toggleSection(sectionKey)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/30 transition-colors text-start"
            >
              <span className="font-semibold text-foreground text-sm">{t(sectionLabels[sectionKey])}</span>
              <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
            </button>

            {isOpen && (
              <div>
                {/* Featured cards */}
                {tasks.some(t => t.featured) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-5 pb-4">
                    {tasks.filter(t => t.featured).map(task => (
                      <div
                        key={task.key}
                        className="rounded-xl border border-border bg-background p-5 hover:border-primary/30 hover:shadow-md transition-all group"
                      >
                        {/* Feature icons row */}
                        {task.featureIcons && (
                          <div className="flex items-center gap-1.5 mb-3">
                            {task.featureIcons.map((icon, i) => (
                              <div key={i} className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                                {icon}
                              </div>
                            ))}
                          </div>
                        )}
                        <h4 className="text-sm font-semibold text-foreground mb-1">{t(task.titleKey)}</h4>
                        <p className="text-xs text-muted-foreground leading-relaxed mb-4">{t(task.descKey)}</p>
                        <Button size="sm" asChild className="gap-1.5 shadow-sm">
                          <Link to={task.link}>
                            {t('wizard.getStarted')} <ArrowRight className="w-3 h-3" />
                          </Link>
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* List items */}
                {tasks.filter(t => !t.featured).map(task => (
                  <div key={task.key} className="flex items-center justify-between px-5 py-3 border-t border-border hover:bg-muted/20 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                        {task.icon}
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-foreground">{t(task.titleKey)}</span>
                        {task.trialDays && (
                          <span className="text-xs text-primary font-medium ms-2 inline-flex items-center gap-0.5">
                            <Clock className="w-3 h-3" /> +{task.trialDays} {t('wizard.days')}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" asChild className="gap-1 shrink-0">
                      <Link to={task.link}>
                        {t('wizard.getStarted')} <ArrowRight className="w-3 h-3" />
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
