import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthContext';
import { bridgeRequest, type BridgeSettings } from './api';

export function useBridgeSettings(workspaceId?: string, allowed = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['widget-bridge-settings', user?.id, workspaceId],
    enabled: !!workspaceId && !!user && allowed,
    queryFn: () => bridgeRequest<{ settings: BridgeSettings }>(workspaceId!, '/settings'),
    retry: false, staleTime: 30000,
  });
}
