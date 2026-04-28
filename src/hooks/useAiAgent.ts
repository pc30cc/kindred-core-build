import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiAgentApi, type AgentSettings } from '@/lib/ai-agent-api';

export function useAiAgentSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent', 'settings', workspaceId],
    queryFn: () => aiAgentApi.getSettings(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useUpdateAiAgentSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AgentSettings>) => aiAgentApi.updateSettings(workspaceId!, patch),
    onSuccess: (data) => {
      qc.setQueryData(['ai-agent', 'settings', workspaceId], data);
      qc.invalidateQueries({ queryKey: ['ai-agent', 'diagnostics', workspaceId] });
    },
  });
}

export function useAiAgentDiagnostics(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent', 'diagnostics', workspaceId],
    queryFn: () => aiAgentApi.getDiagnostics(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useAiAgentKnowledgeStatus(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent', 'knowledge', workspaceId],
    queryFn: () => aiAgentApi.getKnowledgeStatus(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useAiAgentAnalytics(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent', 'analytics', workspaceId],
    queryFn: () => aiAgentApi.getAnalytics(workspaceId!),
    enabled: !!workspaceId,
  });
}

export function useAiAgentRuns(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-agent', 'runs', workspaceId],
    queryFn: () => aiAgentApi.getRuns(workspaceId!, 100),
    enabled: !!workspaceId,
  });
}