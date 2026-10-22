/**
 * The team chat on a page of its own: the direct messages between a
 * workspace's members (TeamChatPanel). The Inbox carries the same panel as
 * its Colleagues tab, but only the owner, admins and the chat team have the
 * Inbox (shared/chatRoles.ts); staff reach their colleagues here, and
 * RequireInboxAccess sends their old `/inbox?filter=colleagues` links here.
 * The route is gated by the plan's `inbox_team_chat` (App.tsx).
 */
import TeamChatPanel from '@/components/inbox/TeamChatPanel';
import { useTranslation } from '@/i18n';

export default function TeamChatPage() {
  const { dir } = useTranslation();
  return (
    <div data-page="team-chat" className="flex h-full min-h-0 flex-col" dir={dir}>
      <div className="flex-1 min-h-0 flex"><TeamChatPanel /></div>
    </div>
  );
}
