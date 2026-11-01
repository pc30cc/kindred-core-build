import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { Compass } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { GuidanceRulesList } from './persona/GuidanceRulesList';

/**
 * The workspace's answer rules on a page of their own. The list itself
 * (add, edit, turn off, delete, the starter rules) is GuidanceRulesList,
 * which the Personality & behavior page shows too.
 */
export default function GuidancePage() {
  const { t } = useTranslation();
  const wsId = useCurrentWorkspace()?.id;

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <AiPageHeader
        icon={Compass}
        accent="violet"
        title={t('aiAgent.guidance.title')}
        subtitle={t('aiAgent.guidance.subtitle')}
      />
      <GuidanceRulesList workspaceId={wsId} />
    </div>
  );
}
