import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Rocket, ArrowRight, Code, MessageSquare, Mail, Smartphone,
  Palette, BookOpen, Bot, Users, Zap, Download, ChevronUp, ChevronDown,
  Clock, HelpCircle, X
} from 'lucide-react';

interface WizardTask {
  key: string;
  icon: React.ReactNode;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  link: string;
  trialDays?: number;
  featured?: boolean;
  icons?: React.ReactNode[];
}

const SECTION_TASKS: Record<string, WizardTask[]> = {
  connect: [
    { key: 'install_widget', icon: <Code className="w-5 h-5" />, titleKey: 'wizard.installWidget', descKey: 'wizard.installWidgetDesc', link: '/app/widget', trialDays: 6, featured: true },
    { key: 'connect_channels', icon: <MessageSquare className="w-5 h-5" />, titleKey: 'wizard.connectChannels', descKey: 'wizard.connectChannelsDesc', link: '/app/settings/providers', trialDays: 3, featured: true },
    { key: 'connect_email', icon: <Mail className="w-5 h-5" />, titleKey: 'wizard.connectEmail', descKey: 'wizard.connectEmailDesc', link: '/app/email', trialDays: 2 },
    { key: 'mobile_app', icon: <Smartphone className="w-5 h-5" />, titleKey: 'wizard.mobileApp', descKey: 'wizard.mobileAppDesc', link: '#', trialDays: 2 },
  ],
  customize: [
    { key: 'customize_widget', icon: <Palette className="w-5 h-5" />, titleKey: 'wizard.customizeWidget', descKey: 'wizard.customizeWidgetDesc', link: '/app/widget', trialDays: 2 },
    { key: 'knowledge_base', icon: <BookOpen className="w-5 h-5" />, titleKey: 'wizard.knowledgeBase', descKey: 'wizard.knowledgeBaseDesc', link: '/app/knowledge-base', trialDays: 4 },
    { key: 'setup_ai', icon: <Bot className="w-5 h-5" />, titleKey: 'wizard.setupAI', descKey: 'wizard.setupAIDesc', link: '/app/ai', trialDays: 2 },
  ],
  grow: [
    { key: 'shortcuts', icon: <Zap className="w-5 h-5" />, titleKey: 'wizard.shortcuts', descKey: 'wizard.shortcutsDesc', link: '/app/settings/general', trialDays: 2 },
    { key: 'invite_team', icon: <Users className="w-5 h-5" />, titleKey: 'wizard.inviteTeam', descKey: 'wizard.inviteTeamDesc', link: '/app/team', trialDays: 2 },
    { key: 'import_contacts', icon: <Download className="w-5 h-5" />, titleKey: 'wizard.importContacts', descKey: 'wizard.importContactsDesc', link: '/app/contacts', trialDays: 2 },
  ],
};

const ALL_TASKS = [...SECTION_TASKS.connect, ...SECTION_TASKS.customize, ...SECTION_TASKS.grow];

export default function GetStartedWizard() {
  const { t } = useTranslation();
  const { platformName } = useBrandingContext();
  const [hidden, setHidden] = useState(false);
  const [completedTasks, setCompletedTasks] = useState<string[]>([]);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ connect: true, customize: false, grow: false });

  if (hidden) return null;

  const totalTasks = ALL_TASKS.length;
  const completedCount = completedTasks.length;
  const progressPercent = totalTasks > 0 ? (completedCount / totalTasks) * 100 : 0;
  const totalTrialDays = ALL_TASKS.reduce((s, t) => s + (t.trialDays || 0), 0);
  const collectedDays = ALL_TASKS.filter(t => completedTasks.includes(t.key)).reduce((s, t) => s + (t.trialDays || 0), 0);

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const renderSection = (sectionKey: string, titleKey: TranslationKey, tasks: WizardTask[]) => {
    const isOpen = expandedSections[sectionKey];
    return (
      <div key={sectionKey} className="border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection(sectionKey)}
          className="w-full flex items-center justify-between px-5 py-4 bg-muted/30 hover:bg-muted/50 transition-colors text-start"
        >
          <span className="font-semibold text-foreground text-sm">{t(titleKey)}</span>
          {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {isOpen && (
          <div className="divide-y divide-border">
            {/* Featured cards */}
            {tasks.some(t => t.featured) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                {tasks.filter(t => t.featured).map(task => (
                  <Card key={task.key} className={`border-2 transition-all ${completedTasks.includes(task.key) ? 'border-primary/30 bg-primary/5' : 'border-border hover:border-primary/30'}`}>
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-foreground font-medium">
                          {task.icon}
                          <span className="text-sm">{t(task.titleKey)}</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{t(task.descKey)}</p>
                      <div className="flex items-center justify-between">
                        {task.trialDays && (
                          <span className="text-xs text-primary font-medium flex items-center gap-1">
                            <Clock className="w-3 h-3" /> +{task.trialDays} {t('wizard.days')}
                          </span>
                        )}
                        <Button size="sm" variant="default" asChild>
                          <Link to={task.link} className="gap-1">
                            {t('wizard.getStarted')} <ArrowRight className="w-3 h-3" />
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            {/* List items */}
            {tasks.filter(t => !t.featured).map(task => (
              <div key={task.key} className="flex items-center justify-between px-5 py-3.5 hover:bg-muted/20 transition-colors">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="text-muted-foreground">{task.icon}</div>
                  <span className="text-sm text-foreground truncate">{t(task.titleKey)}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {task.trialDays && (
                    <span className="text-xs text-primary font-medium flex items-center gap-1">
                      <Clock className="w-3 h-3" /> +{task.trialDays} {t('wizard.days')}
                    </span>
                  )}
                  <Button size="sm" variant="default" asChild>
                    <Link to={task.link} className="gap-1">
                      {t('wizard.getStarted')} <ArrowRight className="w-3 h-3" />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-foreground">{t('wizard.title')}</h2>
          <Rocket className="w-6 h-6 text-primary" />
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center justify-between gap-4 bg-muted/30 rounded-xl px-5 py-4 border border-border">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Progress value={progressPercent} className="h-2 flex-1" />
          </div>
          <p className="text-xs text-muted-foreground">
            {collectedDays} / {totalTrialDays} {t('wizard.trialDaysCollected')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5">
            <HelpCircle className="w-3.5 h-3.5" />
            {t('wizard.needHelp')}
          </Button>
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {renderSection('connect', 'wizard.sectionConnect', SECTION_TASKS.connect)}
        {renderSection('customize', 'wizard.sectionCustomize', SECTION_TASKS.customize)}
        {renderSection('grow', 'wizard.sectionGrow', SECTION_TASKS.grow)}
      </div>

      {/* Hide button */}
      <div className="flex justify-end">
        <button
          onClick={() => setHidden(true)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('wizard.hideThis')}
        </button>
      </div>
    </div>
  );
}
