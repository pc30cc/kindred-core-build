import { useQuery } from '@tanstack/react-query';
import { getChatRoutingPolicy } from '@/lib/chat-routing-api';

/**
 * The Super Admin's platform rules as they apply to this workspace's chat
 * routing (read only). Owner/admin pages only: the endpoint is theirs. An
 * error leaves `data` undefined, and the panel then describes the defaults
 * (every switch on).
 */
export function useChatRoutingPolicy(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['chat-routing-policy', workspaceId],
    queryFn: () => getChatRoutingPolicy(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 60_000,
    retry: false,
  });
}
