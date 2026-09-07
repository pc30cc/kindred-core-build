import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { EntitlementAccessGate } from '@/components/plan/EntitlementAccessGate';
import AiKbBuilderTab from '@/components/app/knowledge/AiKbBuilderTab';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';

/**
 * Knowledge Base — dedicated page for the AI website-scan article builder.
 * Its own plan entitlement (`ai_assistant` + `ai_kb_builder`); a workspace
 * without it lands here and sees the upgrade card, never a locked button
 * buried inside the Articles list.
 */
export default function AiBuilderPage() {
  const { t, dir } = useTranslation();
  const rtl = dir === 'rtl';
  const BackIcon = rtl ? ArrowRight : ArrowLeft;
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const goBack = () => navigate(wsPath('/knowledge-base'));

  return (
    <div className="space-y-6 animate-fade-in" dir={dir}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5 shrink-0">
          <BackIcon className="w-4 h-4" />{t('knowledgeBase.editor.back')}
        </Button>
      </div>

      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
          <Sparkles className="h-6 w-6 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('knowledgeBase.aiBuilder.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{t('knowledgeBase.aiBuilder.subtitle')}</p>
        </div>
      </div>

      <EntitlementAccessGate
        mode="inline"
        requirements={[
          { type: 'module', key: 'ai_assistant' },
          { type: 'feature', key: 'ai_kb_builder' },
        ]}
      >
        <AiKbBuilderTab />
      </EntitlementAccessGate>
    </div>
  );
}
