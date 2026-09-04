import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type AiProactiveMode = 'off' | 'conservative' | 'balanced' | 'active';

export interface AiNudgeSettings {
  enabled: boolean;
  mode: AiProactiveMode;
  include_paths: string[];
  exclude_paths: string[];
  guidance: string | null;
  use_kb: boolean;
  use_journey: boolean;
  use_returning_visitor: boolean;
  max_per_session: number;
  cooldown_seconds: number;
  stop_after_dismiss: boolean;
  stop_after_widget_open: boolean;
  stop_after_conversation: boolean;
  mobile_enabled: boolean;
}

export interface AiNudgeEffectivePolicy {
  available: boolean;
  unavailableReason: string | null;
  mode: AiProactiveMode;
  maxPerSession: number;
  cooldownSeconds: number;
  maxEvaluationsPerSession: number;
  maxMessageLength: number;
  minConfidenceFloor: number;
}

export interface AiNudgeStats {
  counters: { shown: number; dismissed: number; cta_clicked: number; widget_opened: number; conversation_started: number };
  nudgesGenerated: number;
  topTopics: { topic: string; count: number }[];
  topPages: { page: string; count: number }[];
  aiUsage: { costUsd: number; chargeIrr: number; runs: number };
}

function url(workspaceId: string, suffix = ''): string {
  return `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/ai-nudge-settings${suffix}`;
}

async function callApi(u: string, init?: RequestInit): Promise<any> {
  const res = await fetch(u, { credentials: 'include', ...init });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Unexpected response (HTTP ${res.status}): ${raw.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(json?.error || `Request failed: ${res.status}`);
  return json;
}

export function useAiNudgeSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-nudge-settings', workspaceId],
    queryFn: async () => {
      const json = await callApi(url(workspaceId!));
      return json as { settings: AiNudgeSettings; effective: AiNudgeEffectivePolicy };
    },
    enabled: !!workspaceId,
  });
}

export function useSaveAiNudgeSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<AiNudgeSettings>) => {
      if (!workspaceId) throw new Error('workspace_required');
      const json = await callApi(url(workspaceId), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });
      return json as { settings: AiNudgeSettings; effective: AiNudgeEffectivePolicy };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-nudge-settings', workspaceId] }),
  });
}

export function useAiNudgeStats(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ai-nudge-stats', workspaceId],
    queryFn: async () => (await callApi(url(workspaceId!, '/stats'))) as AiNudgeStats,
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

export interface AiNudgePreviewInput {
  path: string;
  title?: string;
  device?: 'desktop' | 'mobile';
  locale?: string;
  returning?: boolean;
  sessionPageCount?: number;
  elapsedMs?: number;
  scrollPercent?: number;
}

export interface AiNudgePreviewResult {
  eligible: boolean;
  score?: number;
  threshold?: number;
  reasons: string[];
  effective: AiNudgeEffectivePolicy;
}

export function useAiNudgePreview(workspaceId: string | undefined) {
  return useMutation({
    mutationFn: async (input: AiNudgePreviewInput) => {
      if (!workspaceId) throw new Error('workspace_required');
      const json = await callApi(url(workspaceId, '/preview'), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) });
      return json as AiNudgePreviewResult;
    },
  });
}
