/**
 * The workspace's departments as the Inbox shows them: a conversation's
 * department, the list's department filter and "Transfer to a department".
 * Readable by every member who has the Inbox (GET …/directory). An empty list
 * when it cannot be read, so the Inbox simply offers no department controls.
 */
import { useQuery } from '@tanstack/react-query';
import { listInboxDepartments, type InboxDepartment } from '@/lib/workspace-departments-api';

export type { InboxDepartment };

export function useInboxDepartments(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['inbox-departments', workspaceId],
    queryFn: () => listInboxDepartments(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
