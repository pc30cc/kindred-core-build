/**
 * Chat conversation routing/assignment.
 *
 * Chat conversations previously had NO automatic assignment at all — the
 * only write path to `conversations.assigned_to` was a manual operator
 * PATCH (plain read-then-write, not atomic). This adds a real routing
 * engine with three explicit, owner-selectable modes and an atomic claim
 * so two operators (or an auto-pick racing a manual claim) can never both
 * end up owning the same conversation.
 *
 * Reuses existing primitives rather than rebuilding them:
 *   - resolveRoutingCandidates / resolveGeneralPool / loadFallbackPolicy /
 *     ownerFallbackAllowed / resolveWorkspaceOwnerId (server/services/calls/departments.ts)
 *   - listWorkspacePresence (server/services/widget/operatorPresence.ts)
 *   - the atomic public.claim_conversation() Postgres function
 *     (supabase/migrations/20260807132846_chat_routing_assignment.sql)
 */
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  resolveRoutingCandidates,
  loadFallbackPolicy,
  ownerFallbackAllowed,
  resolveWorkspaceOwnerId,
} from './calls/departments.js';
import { listWorkspacePresence } from './widget/operatorPresence.js';
import { publishOperatorEvent } from './realtime/publish.js';

export type AssignmentMode = 'auto' | 'round_robin' | 'manual';

export type RoutingOutcome =
  | 'assigned_auto'
  | 'assigned_round_robin'
  | 'assigned_owner_fallback'
  | 'manual_queue'
  | 'no_eligible_agent'
  | 'already_assigned'
  | 'error';

export interface RouteResult {
  outcome: RoutingOutcome;
  assignedTo: string | null;
}

async function loadAssignmentConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ mode: AssignmentMode; cursor: string | null }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('widget_settings')
    .select('assignment_mode, round_robin_cursor_user_id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const raw = (data as any)?.assignment_mode;
  const mode: AssignmentMode = raw === 'round_robin' || raw === 'manual' ? raw : 'auto';
  return { mode, cursor: (data as any)?.round_robin_cursor_user_id || null };
}

/** Department the visitor picked, if any — read from conversation metadata,
 * falling back to the most recent visitor message (widget currently only
 * stamps department_id per-message; this persists it onto the conversation
 * the first time we see it so routing/diagnostics only need one lookup). */
async function resolveConversationDepartment(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  if (typeof metadata.department_id === 'string' && metadata.department_id) {
    return metadata.department_id;
  }
  const sb = getServiceClient(config);
  const { data: msg } = await sb
    .from('conversation_messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'contact')
    .not('metadata->>department_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const deptId = (msg as any)?.metadata?.department_id as string | undefined;
  if (!deptId) return null;
  try {
    await sb
      .from('conversations')
      .update({ metadata: { ...metadata, department_id: deptId } })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId);
  } catch { /* best-effort persistence only */ }
  return deptId;
}

/** Active (non-closed) assigned-conversation counts for a set of candidates. */
async function loadActiveLoad(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
): Promise<Map<string, number>> {
  const load = new Map<string, number>(userIds.map((id) => [id, 0]));
  if (!userIds.length) return load;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('assigned_to')
    .eq('workspace_id', workspaceId)
    .in('assigned_to', userIds)
    .neq('status', 'closed');
  for (const row of (data || []) as Array<{ assigned_to: string }>) {
    load.set(row.assigned_to, (load.get(row.assigned_to) || 0) + 1);
  }
  return load;
}

async function onlineEligibleCandidates(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string | null,
): Promise<string[]> {
  const { user_ids } = await resolveRoutingCandidates(config, workspaceId, 'chat', departmentId);
  if (!user_ids.length) return [];
  const presence = await listWorkspacePresence(config, workspaceId);
  const online = new Set(presence.filter((p) => p.state === 'online').map((p) => p.user_id));
  return user_ids.filter((id) => online.has(id));
}

async function tryClaim(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('claim_conversation', {
    p_conversation_id: conversationId,
    p_workspace_id: workspaceId,
    p_user_id: userId,
    p_force: false,
  });
  if (error) {
    console.warn('[chat-routing] claim_conversation rpc failed:', error.message);
    return false;
  }
  return Array.isArray(data) ? data.length > 0 : !!data;
}

async function tagOutcome(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  metadata: Record<string, unknown>,
  outcome: RoutingOutcome,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb
      .from('conversations')
      .update({ metadata: { ...metadata, routing_outcome: outcome, routing_outcome_at: new Date().toISOString() } })
      .eq('id', conversationId)
      .eq('workspace_id', workspaceId);
  } catch { /* best-effort */ }
}

/**
 * Route a conversation that just entered `needs_human` to an operator.
 * Idempotent — a conversation that's already assigned is left untouched.
 * Never throws; the handoff must always succeed even if routing fails.
 */
export async function routeConversationToOperator(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string },
): Promise<RouteResult> {
  try {
    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('id, assigned_to, metadata')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    if (!conv) return { outcome: 'error', assignedTo: null };
    if (conv.assigned_to) return { outcome: 'already_assigned', assignedTo: conv.assigned_to };

    const metadata = ((conv as any).metadata || {}) as Record<string, unknown>;
    const { mode, cursor } = await loadAssignmentConfig(config, args.workspaceId);

    if (mode === 'manual') {
      await tagOutcome(config, args.workspaceId, args.conversationId, metadata, 'manual_queue');
      return { outcome: 'manual_queue', assignedTo: null };
    }

    const departmentId = await resolveConversationDepartment(
      config, args.workspaceId, args.conversationId, metadata,
    );
    let candidates = await onlineEligibleCandidates(config, args.workspaceId, departmentId);

    let picked: string | null = null;
    let outcome: RoutingOutcome = 'no_eligible_agent';

    if (candidates.length) {
      if (mode === 'round_robin') {
        // Rotate starting right after the stored cursor for fairness.
        let ordered = candidates.slice().sort();
        if (cursor) {
          const idx = ordered.indexOf(cursor);
          if (idx >= 0) ordered = [...ordered.slice(idx + 1), ...ordered.slice(0, idx + 1)];
        }
        for (const candidate of ordered) {
          if (await tryClaim(config, args.workspaceId, args.conversationId, candidate)) {
            picked = candidate;
            outcome = 'assigned_round_robin';
            break;
          }
        }
        if (picked) {
          await sb.from('widget_settings')
            .update({ round_robin_cursor_user_id: picked })
            .eq('workspace_id', args.workspaceId);
        }
      } else {
        // auto — least-loaded eligible online operator, stable tie-break.
        const load = await loadActiveLoad(config, args.workspaceId, candidates);
        const ranked = candidates.slice().sort((a, b) => {
          const diff = (load.get(a) || 0) - (load.get(b) || 0);
          return diff !== 0 ? diff : a.localeCompare(b);
        });
        for (const candidate of ranked) {
          if (await tryClaim(config, args.workspaceId, args.conversationId, candidate)) {
            picked = candidate;
            outcome = 'assigned_auto';
            break;
          }
        }
      }
    }

    // No eligible online agent (department empty, general pool empty, or
    // everyone offline) — try the owner-fallback safety net before giving up.
    if (!picked) {
      const policy = await loadFallbackPolicy(config, args.workspaceId);
      if (ownerFallbackAllowed(policy, 'chat')) {
        const ownerId = await resolveWorkspaceOwnerId(config, args.workspaceId);
        if (ownerId) {
          const presence = await listWorkspacePresence(config, args.workspaceId);
          const ownerOnline = presence.find((p) => p.user_id === ownerId)?.state !== 'offline';
          if (ownerOnline && await tryClaim(config, args.workspaceId, args.conversationId, ownerId)) {
            picked = ownerId;
            outcome = 'assigned_owner_fallback';
          }
        }
      }
    }

    await tagOutcome(config, args.workspaceId, args.conversationId, metadata, outcome);

    if (picked) {
      try {
        await publishOperatorEvent(config, {
          kind: 'conversation_updated',
          conversation_id: args.conversationId,
          workspace_id: args.workspaceId,
          actor_id: null,
          reason: 'auto_assigned',
        });
      } catch { /* best-effort */ }
    }

    return { outcome, assignedTo: picked };
  } catch (err: any) {
    console.warn('[chat-routing] routeConversationToOperator failed:', err?.message || err);
    return { outcome: 'error', assignedTo: null };
  }
}

/**
 * Manual-mode claim: the first operator to press "claim" in the Unassigned
 * inbox owns the conversation. Atomic — two operators claiming at the same
 * instant can never both succeed.
 */
export async function claimConversationManually(
  config: ServerConfig,
  args: { workspaceId: string; conversationId: string; userId: string },
): Promise<{ claimed: boolean; assignedTo: string | null }> {
  const sb = getServiceClient(config);
  const ok = await tryClaim(config, args.workspaceId, args.conversationId, args.userId);
  if (!ok) {
    const { data } = await sb
      .from('conversations')
      .select('assigned_to')
      .eq('id', args.conversationId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    return { claimed: false, assignedTo: (data as any)?.assigned_to || null };
  }
  try {
    await publishOperatorEvent(config, {
      kind: 'conversation_updated',
      conversation_id: args.conversationId,
      workspace_id: args.workspaceId,
      actor_id: args.userId,
      reason: 'manual_claim',
    });
  } catch { /* best-effort */ }
  return { claimed: true, assignedTo: args.userId };
}
