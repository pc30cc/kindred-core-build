import { useWorkspaceSections } from '@/hooks/useWorkspaceSections';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { kbAiTabsVisible, type KbAiTab } from './knowledgeBaseTabs';

export interface KnowledgeAiTabs extends Record<KbAiTab, boolean> {
  /** The member's role, the plan and the platform's AI switches are all in. */
  known: boolean;
}

/** The assistant's Knowledge Base tabs this member sees (kbAiTabsVisible). */
export function useKnowledgeAiTabs(): KnowledgeAiTabs {
  const sections = useWorkspaceSections();
  // The same queries, and cache entries, as useWorkspaceSections' own.
  const { data: capabilities } = useAiAgentCapabilities(sections.workspaceId);
  const { isError: roleFailed } = useWorkspaceRole(sections.workspaceId ?? undefined);
  return {
    ...kbAiTabsVisible(sections.visible('aiAgent'), capabilities?.customer_nav),
    // A role that cannot be read is not an admin's: known, and no tab.
    known: sections.ready && sections.aiSurface !== null && (sections.roleKnown || roleFailed),
  };
}
