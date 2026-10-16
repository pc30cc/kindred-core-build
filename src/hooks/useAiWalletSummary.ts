/**
 * Workspace AI credit for dashboard surfaces.
 *
 * Single source of truth: the AI section of the account billing page
 * (GET /api/billing/account/:workspaceId/ai) — the exact same wallet the
 * Billing screen's AI credit card renders, so the dashboard never disagrees
 * with Billing. A caller who may not read billing (403) or any other error
 * gets null, and the card shows a dash.
 */
import { useQuery } from '@tanstack/react-query';
import { accountBillingApi } from '@/lib/accountBillingApi';

export interface AiCreditSnapshot {
  /** Remaining plan allowance for the running month (IRR). */
  cycleRemainingIrr: number;
  /** Purchased credit that survives the month (IRR). */
  purchasedRemainingIrr: number;
  /** What the customer can still spend right now (IRR). */
  totalRemainingIrr: number;
  /** The account currency the billing page shows the wallet in. */
  currency: string | null;
  /** What can be spent now in minor units of `currency`, as the billing page shows it; null without a rate. */
  availableMinor: number | null;
}

export function useAiWalletSummary(workspaceId: string | undefined, enabled = true) {
  return useQuery<AiCreditSnapshot | null>({
    queryKey: ['ai-credit-snapshot', workspaceId],
    enabled: !!workspaceId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const section = await accountBillingApi.ai(workspaceId!);
        const cycleRemainingIrr = Number(section.wallet?.plan_remaining ?? 0) || 0;
        const purchasedRemainingIrr = Number(section.wallet?.purchased_remaining ?? 0) || 0;
        return {
          cycleRemainingIrr,
          purchasedRemainingIrr,
          totalRemainingIrr: cycleRemainingIrr + purchasedRemainingIrr,
          currency: section.currency || null,
          availableMinor: typeof section.display?.available_minor === 'number' ? section.display.available_minor : null,
        };
      } catch {
        return null;
      }
    },
  });
}
