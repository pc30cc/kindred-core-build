/**
 * Phase 8D — Smart Routing Engine.
 *
 * Deterministic, rule-based router. NO AI in this phase.
 *
 * Inputs:
 *   workspace, channel, (optional) conversation_id
 *
 * Outputs (resolveCallRoutingTarget):
 *   { kind: 'direct',   operator_id }
 *   { kind: 'queue' }
 *   { kind: 'callback' }
 *   { kind: 'unavailable', reason }
 *
 * Rules (v1):
 *   1. Channel must be enabled by effective gates.
 *   2. Operator must hold can_join_queue_calls AND
 *      can_receive_audio_call (audio) or can_receive_video_call (video).
 *   3. Operator's per-workspace availability must allow the channel and
 *      they must NOT currently be in_call.
 *   4. If 1+ eligible operators → 'direct' (round-robin by user_id).
 *      Else if queue is enabled → 'queue'.
 *      Else if callback fallback enabled → 'callback'.
 *      Else → 'unavailable'.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadCallControlPlane, loadEffectiveCallChannels } from './controlPlane.js';
import { resolveRolePermissions, type RoleSlug } from './permissions.js';
import { listWorkspaceAvailability, isEligible } from './availability.js';
import {
  resolveRoutingCandidates,
  loadFallbackPolicy,
  ownerFallbackAllowed,
  resolveWorkspaceOwnerId,
} from './departments.js';

export type RoutingChannel = 'audio' | 'video';

export type RoutingDecision =
  | { kind: 'direct'; operator_id: string }
  | { kind: 'queue' }
  | { kind: 'callback' }
  | { kind: 'unavailable'; reason: string };

export interface EligibleOperator {
  user_id: string;
  role: RoleSlug;
  status: string;
  in_call: boolean;
}

export async function resolveEligibleOperatorsForCall(
  config: ServerConfig,
  workspaceId: string,
  channel: RoutingChannel,
  departmentId?: string | null,
): Promise<EligibleOperator[]> {
  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);
  if (!members || members.length === 0) return [];

  const availability = await listWorkspaceAvailability(config, workspaceId);
  const availMap = new Map(availability.map((a) => [a.user_id, a]));

  // Optional department narrowing. When departmentId is omitted the
  // candidate pool is the General Pool (or all members if empty), which
  // preserves pre-Phase-8H behavior for workspaces without departments.
  const candidates = await resolveRoutingCandidates(
    config,
    workspaceId,
    channel,
    departmentId ?? null,
  );
  const candidateSet = new Set(candidates.user_ids);

  const out: EligibleOperator[] = [];
  // Resolve permissions per distinct role to avoid N+1.
  const perRole = new Map<string, Awaited<ReturnType<typeof resolveRolePermissions>>>();
  for (const m of members) {
    if (!candidateSet.has(m.user_id)) continue;
    const role = (m.role || 'viewer') as RoleSlug;
    if (!perRole.has(role)) {
      perRole.set(role, await resolveRolePermissions(config, workspaceId, role));
    }
    const perms = perRole.get(role)!;
    if (!perms.can_join_queue_calls) continue;
    if (channel === 'audio' && !perms.can_receive_audio_call) continue;
    if (channel === 'video' && !perms.can_receive_video_call) continue;
    const av = availMap.get(m.user_id);
    if (!av) continue; // operator never set availability → not ready
    if (!isEligible(av, channel)) continue;
    out.push({
      user_id: m.user_id,
      role,
      status: av.status,
      in_call: av.in_call,
    });
  }
  // Deterministic ordering for fairness (lex by user_id).
  out.sort((a, b) => a.user_id.localeCompare(b.user_id));
  return out;
}

export async function resolveCallRoutingTarget(
  config: ServerConfig,
  workspaceId: string,
  channel: RoutingChannel,
  departmentId?: string | null,
): Promise<RoutingDecision> {
  const channels = await loadEffectiveCallChannels(config, workspaceId);
  if (channel === 'audio' && !channels.visitor_initiated_audio) {
    return { kind: 'unavailable', reason: 'voice_disabled' };
  }
  if (channel === 'video' && !channels.visitor_initiated_video) {
    return { kind: 'unavailable', reason: 'video_disabled' };
  }

  // 1) Try department-scoped pool when provided.
  let eligible = await resolveEligibleOperatorsForCall(config, workspaceId, channel, departmentId ?? null);
  // 2) Fallback: if a department was given but no one is available, retry
  //    against the General Pool. This guarantees no routing dead-ends.
  if (eligible.length === 0 && departmentId) {
    eligible = await resolveEligibleOperatorsForCall(config, workspaceId, channel, null);
  }
  if (eligible.length > 0) {
    return { kind: 'direct', operator_id: eligible[0].user_id };
  }

  // Owner fallback — last-resort direct route before queue/callback. Only
  // applies when the policy explicitly allows it for this channel AND the
  // owner themselves passes the same eligibility checks.
  const fallback = await loadFallbackPolicy(config, workspaceId);
  if (ownerFallbackAllowed(fallback, channel)) {
    const ownerId = await resolveWorkspaceOwnerId(config, workspaceId);
    if (ownerId) {
      const ownerEligible = await resolveEligibleOperatorsForCall(
        config,
        workspaceId,
        channel,
        null,
      );
      const ownerEntry = ownerEligible.find((e) => e.user_id === ownerId);
      if (ownerEntry) {
        return { kind: 'direct', operator_id: ownerId };
      }
    }
  }

  if (channels.queue_enabled) return { kind: 'queue' };

  const cp = await loadCallControlPlane(config);
  if (cp.callback_offer_after_timeout) return { kind: 'callback' };
  return { kind: 'unavailable', reason: 'no_operators' };
}

/**
 * Pick the next eligible operator that hasn't already been offered THIS
 * queue entry. Used by the auto-assignment loop. Returns null when nobody
 * is available.
 */
export async function pickOperatorForOffer(
  config: ServerConfig,
  workspaceId: string,
  channel: RoutingChannel,
  excludeUserIds: string[] = [],
  departmentId?: string | null,
): Promise<string | null> {
  let eligible = await resolveEligibleOperatorsForCall(config, workspaceId, channel, departmentId ?? null);
  let next = eligible.find((e) => !excludeUserIds.includes(e.user_id));
  if (!next && departmentId) {
    // Fallback to General Pool to avoid stranded queue entries.
    eligible = await resolveEligibleOperatorsForCall(config, workspaceId, channel, null);
    next = eligible.find((e) => !excludeUserIds.includes(e.user_id));
  }
  return next?.user_id ?? null;
}
