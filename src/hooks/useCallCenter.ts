import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callCenterApi, callCenterAdminApi } from '@/lib/call-center-api';
import type { CallCenterWorkspaceSettings, CallCenterPlatformSettings } from '@/lib/call-center-api';

export function useCallCenterSettings(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'settings', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.getSettings(workspaceId!),
    staleTime: 15_000,
  });
}
export function useUpdateCallCenterSettings(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CallCenterWorkspaceSettings>) => callCenterApi.updateSettings(workspaceId!, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'settings', workspaceId] }),
  });
}
export function useCallCenterOverview(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'overview', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.getOverview(workspaceId!),
    refetchInterval: 5000,
  });
}
export function useCallCenterQueue(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'queue', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.listQueue(workspaceId!),
    refetchInterval: 5000,
  });
}
export function useCallCenterCalls(workspaceId?: string | null, filters?: { status?: string }) {
  return useQuery({
    queryKey: ['call-center', 'calls', workspaceId, filters],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.listCalls(workspaceId!, filters),
  });
}
export function useCallCenterCall(workspaceId?: string | null, callId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'call', workspaceId, callId],
    enabled: !!workspaceId && !!callId,
    queryFn: () => callCenterApi.getCall(workspaceId!, callId!),
  });
}
export function useCallCenterCallbacks(workspaceId?: string | null, status?: string) {
  return useQuery({
    queryKey: ['call-center', 'callbacks', workspaceId, status],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.getCallbacks(workspaceId!, status),
    refetchInterval: 10_000,
  });
}
export function useCallCenterAdminPlatform() {
  return useQuery({
    queryKey: ['call-center', 'admin', 'platform'],
    queryFn: () => callCenterAdminApi.getPlatform(),
    staleTime: 10_000,
  });
}
export function useUpdateCallCenterAdminPlatform() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CallCenterPlatformSettings>) => callCenterAdminApi.updatePlatform(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'admin'] }),
  });
}
export function useCallCenterAdminWorkspaces() {
  return useQuery({
    queryKey: ['call-center', 'admin', 'workspaces'],
    queryFn: () => callCenterAdminApi.listWorkspaces(),
  });
}
