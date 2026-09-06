/**
 * Workspace AI credit for dashboard surfaces.
 *
 * Single source of truth: the customer billing overview read-model — the
 * exact same numbers the Billing screen's "AI credit" tab renders. Reading a
 * second source (the AI ledger wallet) made the dashboard disagree with
 * Billing, so it is deliberately not used here.
 */
import { useQuery } from '@tanstack/react-query';
import { billingOverview } from '@/lib/billingApi';

export interface AiCreditSnapshot {
  /** Remaining plan allowance for the running cycle (IRR). */
  cycleRemainingIrr: number;
  /** Purchased credit that survives the cycle (IRR). */
  purchasedRemainingIrr: number;
  /** What the customer can still spend right now (IRR). */
  totalRemainingIrr: number;
}

export function useAiWalletSummary(workspaceId: string | undefined, enabled = true) {
  return useQuery<AiCreditSnapshot | null>({
    queryKey: ['ai-credit-snapshot', workspaceId],
    enabled: !!workspaceId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const overview = await billingOverview(workspaceId!);
        const cycleRemainingIrr = Number(overview.aiCycle?.remainingIrr ?? 0);
        const purchasedRemainingIrr = Number(overview.aiPurchasedRemainingIrr ?? 0);
        return {
          cycleRemainingIrr,
          purchasedRemainingIrr,
          totalRemainingIrr: cycleRemainingIrr + purchasedRemainingIrr,
        };
      } catch {
        return null;
      }
    },
  });
}
