// ============================================================================
// SIMPLE BILLING phase 4 — a locked agent's open chats go back to the queue
// (docs/billing/SIMPLE_BILLING.md: "the most recently joined are deactivated
// and their open chats return to the queue"; design §5).
//
// The one write the lock design makes on purpose: billing_release_locked_agent_chats
// unassigns the open and pending chats of the members ranked past the seat
// limit (nothing while the kill switch is off), and each released chat is
// announced and routed again. An upgrade does not hand them back.
//
// Called after an applied plan change (account/plans.ts afterPlanChange), by
// the hourly job, and after a member is changed or removed (ranks shift).
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { publishOperatorEvent } from '../../realtime/publish.js';
import { routeConversationToOperator } from '../../chatRouting.js';

/**
 * Releases the locked agents' open chats of `workspaceId` and routes each
 * again. Returns the released conversation ids. Never throws.
 */
export async function releaseLockedAgentChats(config: ServerConfig, workspaceId: string): Promise<string[]> {
  if (config.selfHostBillingUnlimited === true || !workspaceId) return [];
  let ids: string[] = [];
  try {
    const { data, error } = await getServiceClient(config).rpc('billing_release_locked_agent_chats', { p_workspace_id: workspaceId });
    if (error) throw new Error(error.message || 'release failed');
    ids = (Array.isArray(data) ? data : [])
      .map((row) => (typeof row === 'string' ? row : (row as Record<string, unknown> | null)?.billing_release_locked_agent_chats))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch (e) {
    console.warn('[billing-locks] releasing locked agents\' chats failed:', e instanceof Error ? e.message : e);
    return [];
  }
  for (const conversationId of ids) {
    try {
      await publishOperatorEvent(config, {
        kind: 'conversation_updated',
        conversation_id: conversationId,
        workspace_id: workspaceId,
        actor_id: null,
        changes: { assigned_to: null },
        reason: 'seat_locked',
        updated_at: new Date().toISOString(),
      });
      await routeConversationToOperator(config, { workspaceId, conversationId });
    } catch (e) {
      console.warn('[billing-locks] re-routing a released chat failed:', conversationId, e instanceof Error ? e.message : e);
    }
  }
  return ids;
}
