import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callCenterApi, callCenterAdminApi } from '@/lib/call-center-api';
import type {
  CallCenterWorkspaceSettings,
  CallCenterPlatformSettings,
  CreateDepartmentPayload,
  AddDepartmentAgentPayload,
  CallCenterPresenceStatus,
  TransferCallPayload,
} from '@/lib/call-center-api';

export function useCallCenterCapabilities(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'capabilities', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.getCapabilities(workspaceId!),
    staleTime: 30_000,
  });
}

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
    refetchInterval: 4000,
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

// ── Departments ─────────────────────────────────────────────────
export function useCallCenterDepartments(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'departments', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.listDepartments(workspaceId!),
    staleTime: 15_000,
  });
}
export function useCallCenterDepartmentAgents(workspaceId?: string | null, departmentId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'department-agents', workspaceId, departmentId],
    enabled: !!workspaceId && !!departmentId,
    queryFn: () => callCenterApi.listDepartmentAgents(workspaceId!, departmentId!),
  });
}
export function useCreateDepartment(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateDepartmentPayload) => callCenterApi.createDepartment(workspaceId!, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'departments', workspaceId] }),
  });
}
export function useUpdateDepartment(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<CreateDepartmentPayload> }) =>
      callCenterApi.updateDepartment(workspaceId!, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'departments', workspaceId] }),
  });
}
export function useDeleteDepartment(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => callCenterApi.deleteDepartment(workspaceId!, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'departments', workspaceId] }),
  });
}
export function useAddDepartmentAgent(workspaceId?: string | null, departmentId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: AddDepartmentAgentPayload) =>
      callCenterApi.addDepartmentAgent(workspaceId!, departmentId!, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call-center', 'department-agents', workspaceId, departmentId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'departments', workspaceId] });
    },
  });
}
export function useRemoveDepartmentAgent(workspaceId?: string | null, departmentId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      callCenterApi.removeDepartmentAgent(workspaceId!, departmentId!, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call-center', 'department-agents', workspaceId, departmentId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'departments', workspaceId] });
    },
  });
}

// ── Presence ────────────────────────────────────────────────────
export function useCallCenterAgentPresence(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'presence', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => callCenterApi.getAgentPresence(workspaceId!),
    refetchInterval: 15_000,
  });
}
export function useUpdateMyCallCenterPresence(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ status, statusMessage }: { status: CallCenterPresenceStatus; statusMessage?: string | null }) =>
      callCenterApi.updateMyPresence(workspaceId!, status, statusMessage),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-center', 'presence', workspaceId] }),
  });
}

// ── Assign / transfer ───────────────────────────────────────────
export function useAssignCall(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, agentId, reason }: { callId: string; agentId: string | null; reason?: string }) =>
      callCenterApi.assignCall(workspaceId!, callId, agentId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call-center', 'queue', workspaceId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'calls', workspaceId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'presence', workspaceId] });
    },
  });
}
export function useTransferCall(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, payload }: { callId: string; payload: TransferCallPayload }) =>
      callCenterApi.transferCall(workspaceId!, callId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['call-center', 'queue', workspaceId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'calls', workspaceId] });
      qc.invalidateQueries({ queryKey: ['call-center', 'presence', workspaceId] });
    },
  });
}

// ── Operator wrap-up notes ──────────────────────────────────────
export function useCallCenterCallNotes(workspaceId?: string | null, callId?: string | null) {
  return useQuery({
    queryKey: ['call-center', 'call-notes', workspaceId, callId],
    enabled: !!workspaceId && !!callId,
    queryFn: () => callCenterApi.listCallNotes(workspaceId!, callId!),
    staleTime: 10_000,
  });
}
export function useAddCallNote(workspaceId?: string | null, callId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => callCenterApi.addCallNote(workspaceId!, callId!, note),
    onSuccess: (r) => {
      // Seed the cache from the response so the note appears without a refetch,
      // then refresh the call detail so the timeline picks up the new event.
      qc.setQueryData(['call-center', 'call-notes', workspaceId, callId], { notes: r.notes });
      qc.invalidateQueries({ queryKey: ['call-center', 'call', workspaceId, callId] });
    },
  });
}
