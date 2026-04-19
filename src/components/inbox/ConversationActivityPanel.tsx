/**
 * Phase 4b/4c — Operator-only Activity panel (refactored).
 *
 * Renders Notes + Timeline inside the Inbox sidebar's "Activity" tab.
 * Logic lives in NotesSection / TimelineSection / NoteRow. This shell just
 * provides layout + dir.
 */
import { Separator } from '@/components/ui/separator';
import { NotesSection } from './NotesSection';
import { TimelineSection } from './TimelineSection';

interface Props {
  conversationId: string;
  workspaceId: string;
  currentUserId: string | null;
  t: (key: string) => string;
  dir: 'ltr' | 'rtl';
}

export function ConversationActivityPanel({
  conversationId, workspaceId, currentUserId, t, dir,
}: Props) {
  return (
    <div className="p-3 space-y-4" dir={dir}>
      <NotesSection
        conversationId={conversationId}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        t={t}
      />
      <Separator className="opacity-50" />
      <TimelineSection
        conversationId={conversationId}
        workspaceId={workspaceId}
        t={t}
      />
    </div>
  );
}
