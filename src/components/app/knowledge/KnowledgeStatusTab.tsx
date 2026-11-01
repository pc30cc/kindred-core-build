import TrainPage from '@/pages/app/ai-agent/TrainPage';
import KnowledgePage from '@/pages/app/ai-agent/KnowledgePage';

/**
 * Knowledge Base → the assistant's knowledge status (`?tab=status`): what the
 * AI section's sync-status page (TrainPage: the counts, warnings, quick
 * actions with the index rebuild, sync logs, retrieval rules and the index)
 * and its Knowledge page (each source's readiness) showed, together and as
 * they are. Loaded only when the tab is opened (KnowledgeBasePage.tsx).
 */
export default function KnowledgeStatusTab() {
  return (
    <div data-kb-status-tab className="space-y-10">
      <TrainPage embedded />
      <KnowledgePage embedded />
    </div>
  );
}
