/**
 * Workspace AI wallet summary (customer-facing final numbers only).
 *
 * The dashboard used to read `workspace_usage_counters.ai_credits_used`,
 * which no code path ever writes — AI spend lives in the AI billing ledger.
 * This hook reads the same authoritative endpoint as the billing screens.
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

export interface AiWalletSummary {
  currency: string;
  cycleId: string;
  renewsAt: string;
  available: number;
  reserved: number;
  granted: number;
  usedThisCycle: number;
  planRemaining: number;
  purchasedRemaining: number;
  aiReplies: number;
  mode: 'METER_ONLY' | 'ENFORCED';
}

export function useAiWalletSummary(workspaceId: string | undefined, enabled = true) {
  return useQuery<AiWalletSummary | null>({
    queryKey: ['ai-wallet-summary', workspaceId],
    enabled: !!workspaceId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/ai-billing/workspaces/${workspaceId}/summary`,
        { credentials: 'include' },
      );
      if (!res.ok) return null;
      return (await res.json()) as AiWalletSummary;
    },
  });
}
