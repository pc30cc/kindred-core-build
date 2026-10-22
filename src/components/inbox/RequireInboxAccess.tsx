/**
 * Route guard — the Inbox is for the owner, admins and the chat team
 * (shared/chatRoles.ts). Staff such as marketing, SEO, analysts, developers,
 * billing and viewers do not answer chats: the server refuses their Inbox
 * requests (403 `inbox_not_allowed`), so the page never mounts for them and
 * its queries never fire. A link that still leads here (an old bookmark, a
 * shared URL) explains why instead of showing an empty, failing Inbox.
 */
import { Link } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { canUseInbox } from '../../../shared/chatRoles';

export function RequireInboxAccess({ children, showBack = true }: {
  children: React.ReactNode;
  /** The phone app's index IS the Inbox, so there it has nowhere to go back to. */
  showBack?: boolean;
}) {
  const workspace = useCurrentWorkspace();
  const { data: role, isPending } = useWorkspaceRole(workspace?.id);

  if (!workspace?.id || isPending) return <div className="h-full w-full" />;
  if (!canUseInbox(role)) return <InboxNotAllowed showBack={showBack} />;
  return <>{children}</>;
}

export function InboxNotAllowed({ showBack = true }: { showBack?: boolean }) {
  const { t, dir } = useTranslation();
  const wsPath = useWorkspacePath();
  return (
    <div
      data-inbox="not-allowed"
      className="flex h-full flex-col items-center justify-center gap-4 bg-background px-6 text-center"
      dir={dir}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary/60">
        <Inbox className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <h2 className="text-lg font-semibold text-foreground">{t('inbox.noAccessTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('inbox.noAccessDesc')}</p>
      </div>
      {showBack && (
        <Button asChild variant="outline">
          <Link to={wsPath('')}>{t('inbox.noAccessBack')}</Link>
        </Button>
      )}
    </div>
  );
}
