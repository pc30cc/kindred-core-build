import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { bridgeRequest, type BridgeSettings, type BridgeContact } from './api';

export function useBridgeSettings(workspaceId?: string, allowed = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['widget-bridge-settings', user?.id, workspaceId],
    enabled: !!workspaceId && !!user && allowed,
    queryFn: () => bridgeRequest<{ settings: BridgeSettings }>(workspaceId!, '/settings'),
    retry: false, staleTime: 30000,
  });
}

export function useBridgeContacts(workspaceId?: string, enabled = true, aiOnly = false) {
  const { user } = useAuth();
  const query = useInfiniteQuery({
    queryKey: ['widget-bridge-contacts', user?.id, workspaceId, aiOnly],
    enabled: !!workspaceId && enabled, retry: false, refetchInterval: 10000,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => bridgeRequest<{ contacts: BridgeContact[]; hasMore: boolean }>(workspaceId!,
      `/contacts${aiOnly ? '?aiReplied=true' : ''}${pageParam ? `${aiOnly ? '&' : '?'}before=${pageParam}` : ''}`),
    getNextPageParam: page => page.hasMore ? page.contacts[page.contacts.length - 1]?.id : undefined,
  });
  return { ...query, data: query.data ? { contacts: [...new Map(query.data.pages.flatMap(page => page.contacts).map(c => [c.id,c])).values()] } : undefined };
}
