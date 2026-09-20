/**
 * Call Center routing + assignment + transfer service.
 * Standalone Call Center only — does not touch chat-call flow.
 *
 * Routing reads canonical workspace_departments + workspace_department_members.
 * Channel eligibility uses cc_voice_enabled / cc_video_enabled / cc_callback_enabled.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishCallEvent, publishQueueEvent } from './realtime.js';
import { ringOperators } from '../push/callRing.js';
import {
  CALL_CENTER_ENTRY_SOURCES,
  WIDGET_ONLY_ENTRY_SOURCE,
} from '../../../shared/callCenter/entrySources.js';
import {
  assertDepartmentInWorkspace,
  assertAssignableAgent,
  DepartmentException,
} from './departments.js';

export type RoutingMode = 'broadcast' | 'round_robin' | 'least_busy';
type Channel = 'audio' | 'video' | 'callback';

export class RoutingException extends Error {
  constructor(public readonly code: string, public readonly httpStatus = 400) {
    super(code);
    this.name = 'RoutingException';
  }
}

function asRouting(e: unknown): never {
  if (e instanceof RoutingException) throw e;
  if (e instanceof DepartmentException) {
    throw new RoutingException(e.code, e.httpStatus);
  }
  throw e;
}

/**
 * The department columns routing actually reads. Typed rather than `any` so a
 * renamed column fails the build instead of silently disabling a channel.
 */
interface DepartmentRow {
  id: string;
  name?: string | null;
  sort_order?: number | null;
  cc_voice_enabled?: boolean | null;
  cc_video_enabled?: boolean | null;
  cc_callback_enabled?: boolean | null;
  cc_routing_mode?: RoutingMode | null;
  cc_fallback_department_id?: string | null;
  cc_routing_state?: RoutingState | null;
}

interface RoutingState {
  last_round_robin_user_id?: string | null;
  last_round_robin_at?: string | null;
}

interface DepartmentMemberRow {
  user_id: string;
  call_center_priority?: number | null;
  call_center_enabled?: boolean | null;
  call_center_max_concurrent_calls?: number | null;
}

interface MemberRoleRow {
  user_id: string;
  role: string | null;
}

interface CallSessionRow {
  id: string;
  workspace_id?: string | null;
  department_id?: string | null;
  call_type?: Channel | null;
  assigned_agent_id?: string | null;
  state?: string | null;
}

interface QueueEntryRow {
  id: string;
  routing_attempts?: number | null;
}

function channelEnabled(dept: DepartmentRow | null, channel: Channel): boolean {
  if (!dept) return false;
  if (channel === 'audio') return !!dept.cc_voice_enabled;
  if (channel === 'video') return !!dept.cc_video_enabled;
  if (channel === 'callback') return !!dept.cc_callback_enabled;
  return false;
}

const DEPT_COLS =
  'id, name, sort_order, cc_voice_enabled, cc_video_enabled, cc_callback_enabled, cc_routing_mode, cc_fallback_department_id, cc_routing_state';

async function getDept(
  config: ServerConfig, workspaceId: string, departmentId: string,
): Promise<DepartmentRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_departments')
    .select(DEPT_COLS)
    .eq('workspace_id', workspaceId)
    .eq('id', departmentId)
    .maybeSingle();
  return (data as DepartmentRow | null) ?? null;
}

async function getStandaloneCallCenterSession(
  config: ServerConfig, workspaceId: string, callId: string,
) {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_sessions')
    .select('*')
    .eq('id', callId)
    .eq('workspace_id', workspaceId)
    .in('entry_source', CALL_CENTER_ENTRY_SOURCES)
    .maybeSingle();
  return data;
}

interface AgentRow {
  user_id: string;
  priority: number;
  enabled: boolean;
  max_concurrent_calls: number | null;
}
interface PresenceRow {
  user_id: string;
  status: string;
  active_call_count: number;
  last_seen_at: string | null;
}

/**
 * Resolve eligible agents for a department. Reads canonical
 * workspace_department_members joined with workspace_members for role.
 * Falls back to all operator-roled workspace members when no department.
 */
const OPERATOR_ROLES = new Set(['owner', 'admin', 'agent', 'support_agent', 'team_lead']);

async function fetchEligibleAgents(
  config: ServerConfig,
  workspaceId: string,
  departmentId: string | null,
): Promise<{ agents: AgentRow[]; presence: Map<string, PresenceRow> }> {
  const sb = getServiceClient(config);
  let agents: AgentRow[] = [];
  if (departmentId) {
    const { data } = await sb
      .from('workspace_department_members')
      .select('user_id, call_center_priority, call_center_enabled, call_center_max_concurrent_calls')
      .eq('workspace_id', workspaceId)
      .eq('department_id', departmentId)
      .eq('call_center_enabled', true);
    const rows = (data || []) as DepartmentMemberRow[];
    const userIds = rows.map((r) => r.user_id);
    const roles = new Map<string, string>();
    if (userIds.length) {
      const { data: members } = await sb
        .from('workspace_members')
        .select('user_id, role')
        .eq('workspace_id', workspaceId)
        .in('user_id', userIds);
      for (const m of (members || []) as MemberRoleRow[]) {
        roles.set(m.user_id, String(m.role ?? ''));
      }
    }
    agents = rows
      .filter((r) => OPERATOR_ROLES.has(roles.get(r.user_id) || ''))
      .map((r) => ({
        user_id: r.user_id,
        priority: r.call_center_priority ?? 100,
        enabled: r.call_center_enabled !== false,
        max_concurrent_calls: r.call_center_max_concurrent_calls,
      }));
  } else {
    // No department — fall back to any presence-active operator-roled member.
    const { data: members } = await sb
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId);
    agents = ((members || []) as MemberRoleRow[])
      .filter((m) => OPERATOR_ROLES.has(String(m.role ?? '')))
      .map((m) => ({
        user_id: m.user_id, priority: 100, enabled: true, max_concurrent_calls: null,
      }));
  }

  const ids = agents.map((a) => a.user_id);
  const presence = new Map<string, PresenceRow>();
  if (ids.length) {
    const { data: pres } = await sb
      .from('call_center_agent_presence')
      .select('user_id, status, active_call_count, last_seen_at')
      .eq('workspace_id', workspaceId)
      .in('user_id', ids);
    for (const p of (pres || []) as PresenceRow[]) presence.set(p.user_id, p);
  }
  return { agents, presence };
}

function isAvailable(p: PresenceRow | undefined, agent: AgentRow): boolean {
  if (!p) return false;
  if (p.status !== 'available') return false;
  if (agent.max_concurrent_calls != null && p.active_call_count >= agent.max_concurrent_calls) {
    return false;
  }
  return true;
}

export async function pickAgentForDepartment(
  config: ServerConfig,
  args: { workspaceId: string; departmentId: string | null; mode: RoutingMode },
): Promise<string | null> {
  const { workspaceId, departmentId, mode } = args;
  const { agents, presence } = await fetchEligibleAgents(config, workspaceId, departmentId);
  const available = agents.filter((a) => isAvailable(presence.get(a.user_id), a));
  if (!available.length) return null;
  if (mode === 'broadcast') return null;

  if (mode === 'least_busy') {
    available.sort((a, b) => {
      const pa = presence.get(a.user_id)!;
      const pb = presence.get(b.user_id)!;
      if (pa.active_call_count !== pb.active_call_count) {
        return pa.active_call_count - pb.active_call_count;
      }
      if (a.priority !== b.priority) return b.priority - a.priority;
      const ta = pa.last_seen_at ? Date.parse(pa.last_seen_at) : 0;
      const tb = pb.last_seen_at ? Date.parse(pb.last_seen_at) : 0;
      return tb - ta;
    });
    return available[0].user_id;
  }

  if (mode === 'round_robin') {
    const sb = getServiceClient(config);
    let lastUid: string | null = null;
    if (departmentId) {
      const { data: dept } = await sb
        .from('workspace_departments')
        .select('cc_routing_state')
        .eq('workspace_id', workspaceId)
        .eq('id', departmentId)
        .maybeSingle();
      lastUid = (dept?.cc_routing_state as RoutingState | null)?.last_round_robin_user_id || null;
    }
    available.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.user_id.localeCompare(b.user_id);
    });
    let next = available[0];
    if (lastUid) {
      const idx = available.findIndex((a) => a.user_id === lastUid);
      if (idx >= 0) next = available[(idx + 1) % available.length];
    }
    if (departmentId) {
      const { data: dept } = await sb
        .from('workspace_departments')
        .select('cc_routing_state')
        .eq('workspace_id', workspaceId)
        .eq('id', departmentId)
        .maybeSingle();
      const state: RoutingState = (dept?.cc_routing_state as RoutingState | null) || {};
      state.last_round_robin_user_id = next.user_id;
      state.last_round_robin_at = new Date().toISOString();
      await sb
        .from('workspace_departments')
        .update({ cc_routing_state: state })
        .eq('workspace_id', workspaceId)
        .eq('id', departmentId);
    }
    return next.user_id;
  }
  return null;
}

export async function assignCallToAgent(
  config: ServerConfig,
  args: {
    workspaceId: string;
    callSessionId: string;
    agentId: string | null;
    reason?: string;
    actorId: string;
  },
) {
  const sb = getServiceClient(config);
  const call = await getStandaloneCallCenterSession(config, args.workspaceId, args.callSessionId);
  if (!call) throw new RoutingException('call_not_found', 404);
  if (args.agentId) {
    try {
      await assertAssignableAgent(config, {
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        departmentId: call.department_id || null,
      });
    } catch (e) { asRouting(e); }
  }
  const { error } = await sb
    .from('call_sessions')
    .update({ assigned_agent_id: args.agentId })
    .eq('id', args.callSessionId)
    .eq('workspace_id', args.workspaceId);
  if (error) throw error;
  await sb
    .from('call_queue_entries')
    .update({
      assigned_agent_id: args.agentId,
      last_routing_at: new Date().toISOString(),
    })
    .eq('call_session_id', args.callSessionId)
    .eq('workspace_id', args.workspaceId);
  await sb.from('call_events').insert({
    call_session_id: args.callSessionId,
    event_type: 'call_assigned',
    actor_type: 'operator',
    actor_id: args.actorId,
    payload: { agent_id: args.agentId, reason: args.reason || null },
  });
  await publishCallEvent(config, args.workspaceId, args.callSessionId, 'call_assigned', {
    call_id: args.callSessionId, agent_id: args.agentId,
  });
  await publishQueueEvent(config, args.workspaceId, 'call_assigned', {
    call_id: args.callSessionId, agent_id: args.agentId,
  });
  return { call_id: args.callSessionId, assigned_agent_id: args.agentId };
}

/**
 * Apply routing for a queued call. Picks an agent (or leaves unassigned for
 * broadcast) and updates queue + session rows. Channel-aware: validates the
 * department has the required cc_* channel enabled and falls back per
 * cc_fallback_department_id when needed.
 */
export async function routeIncomingCall(
  config: ServerConfig,
  args: {
    workspaceId: string;
    callSessionId: string;
    departmentId?: string | null;
    callType?: 'audio' | 'video' | null;
    actorId?: string;
  },
) {
  const sb = getServiceClient(config);
  const call = await getStandaloneCallCenterSession(config, args.workspaceId, args.callSessionId);
  if (!call) throw new RoutingException('call_not_found', 404);
  const channel: Channel = (args.callType as Channel) || call.call_type || 'audio';
  let departmentId: string | null = args.departmentId ?? null;
  let mode: RoutingMode = 'broadcast';
  let routingReason: string | null = null;
  const originalDepartmentId: string | null = departmentId;

  if (departmentId) {
    try { await assertDepartmentInWorkspace(config, args.workspaceId, departmentId); }
    catch (e) { asRouting(e); }
    const dept = await getDept(config, args.workspaceId, departmentId);
    if (dept && !channelEnabled(dept, channel)) {
      const fbId = dept.cc_fallback_department_id ?? null;
      if (fbId) {
        const fb = await getDept(config, args.workspaceId, fbId);
        if (fb && channelEnabled(fb, channel)) {
          departmentId = fb.id;
          mode = fb.cc_routing_mode || 'broadcast';
          routingReason = 'department_channel_disabled_fallback';
        } else {
          mode = dept.cc_routing_mode || 'broadcast';
          routingReason = 'department_channel_disabled_no_fallback';
          departmentId = null; // leave unassigned: required channel unavailable
        }
      } else {
        mode = dept.cc_routing_mode || 'broadcast';
        routingReason = 'department_channel_disabled_no_fallback';
        departmentId = null;
      }
    } else if (dept) {
      mode = dept.cc_routing_mode || 'broadcast';
    }
  } else {
    const { data: ws } = await sb
      .from('call_center_settings')
      .select('routing_mode')
      .eq('workspace_id', args.workspaceId)
      .maybeSingle();
    mode = (ws?.routing_mode as RoutingMode | null) || 'broadcast';
  }

  const agentId = routingReason && routingReason.endsWith('no_fallback')
    ? null
    : await pickAgentForDepartment(config, {
        workspaceId: args.workspaceId, departmentId, mode,
      });

  await sb
    .from('call_sessions')
    .update({ department_id: departmentId, assigned_agent_id: agentId })
    .eq('id', args.callSessionId)
    .eq('workspace_id', args.workspaceId);

  const { data: queueRow } = await sb
    .from('call_queue_entries')
    .select('id, routing_attempts')
    .eq('call_session_id', args.callSessionId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle();
  if (queueRow) {
    const nextAttempts = ((queueRow as QueueEntryRow).routing_attempts || 0) + 1;
    await sb
      .from('call_queue_entries')
      .update({
        department_id: departmentId,
        assigned_agent_id: agentId,
        routing_mode: mode,
        routing_attempts: nextAttempts,
        last_routing_at: new Date().toISOString(),
      })
      .eq('id', (queueRow as QueueEntryRow).id);
  }

  await sb.from('call_events').insert({
    call_session_id: args.callSessionId,
    event_type: 'call_routed',
    actor_type: 'system',
    actor_id: args.actorId || null,
    payload: {
      department_id: departmentId,
      original_department_id: originalDepartmentId,
      fallback_department_id: routingReason === 'department_channel_disabled_fallback' ? departmentId : null,
      mode,
      channel,
      agent_id: agentId,
      reason: routingReason,
    },
  });
  await publishQueueEvent(config, args.workspaceId, 'call_routed', {
    call_id: args.callSessionId, department_id: departmentId, agent_id: agentId,
  });

  // Ring the phones the same way the console was just told to light up: one
  // agent when the router picked one, every available agent on broadcast.
  // Fire-and-forget and silent on failure — a phone that cannot be reached
  // must never hold up, or fail, the caller's place in the queue.
  //
  // A callback request is deliberately not a ring: nobody is waiting on the
  // line, and a phone that rings for one would be lying about what answering
  // it does.
  if (channel === 'audio' || channel === 'video') {
    void ringOperators(config, {
      workspaceId: args.workspaceId,
      callSessionId: args.callSessionId,
      agentId,
      channel,
    });
  }

  return {
    department_id: departmentId,
    routing_mode: mode,
    assigned_agent_id: agentId,
    reason: routingReason,
  };
}

export async function transferCall(
  config: ServerConfig,
  args: {
    workspaceId: string;
    callSessionId: string;
    fromAgentId: string;
    toAgentId?: string | null;
    toDepartmentId?: string | null;
    reason?: string | null;
    actorId: string;
  },
) {
  const sb = getServiceClient(config);
  if (!args.toAgentId && !args.toDepartmentId) {
    throw new RoutingException('transfer_target_required', 400);
  }
  const call = await getStandaloneCallCenterSession(config, args.workspaceId, args.callSessionId);
  if (!call) throw new RoutingException('call_not_found', 404);
  if (!['active', 'ringing', 'connecting', 'pending'].includes(String(call.state ?? ''))) {
    throw new RoutingException('call_not_active', 409);
  }
  const channel: Channel = call.call_type || 'audio';
  if (args.toDepartmentId) {
    try { await assertDepartmentInWorkspace(config, args.workspaceId, args.toDepartmentId); }
    catch (e) { asRouting(e); }
  }
  if (args.toAgentId) {
    try {
      await assertAssignableAgent(config, {
        workspaceId: args.workspaceId,
        agentId: args.toAgentId,
        departmentId: args.toDepartmentId || call.department_id || null,
      });
    } catch (e) { asRouting(e); }
  }

  await sb.from('call_events').insert({
    call_session_id: args.callSessionId,
    event_type: 'call_transfer_requested',
    actor_type: 'operator',
    actor_id: args.actorId,
    payload: {
      from_agent_id: args.fromAgentId,
      to_agent_id: args.toAgentId || null,
      to_department_id: args.toDepartmentId || null,
      reason: args.reason || null,
    },
  });

  try {
    let assignedAgentId: string | null = args.toAgentId || null;
    let departmentId: string | null =
      args.toDepartmentId || call.department_id || null;

    if (args.toDepartmentId) {
      const dept = await getDept(config, args.workspaceId, args.toDepartmentId);
      if (!dept) throw new RoutingException('department_not_found', 404);
      let mode: RoutingMode = dept.cc_routing_mode || 'broadcast';
      let targetDept = args.toDepartmentId;
      if (!channelEnabled(dept, channel) && dept.cc_fallback_department_id) {
        const fb = await getDept(config, args.workspaceId, dept.cc_fallback_department_id);
        if (fb && channelEnabled(fb, channel)) {
          targetDept = fb.id;
          mode = fb.cc_routing_mode || 'broadcast';
        }
      }
      departmentId = targetDept;
      if (!args.toAgentId) {
        assignedAgentId = await pickAgentForDepartment(config, {
          workspaceId: args.workspaceId, departmentId: targetDept, mode,
        });
      }
    }

    await sb
      .from('call_sessions')
      .update({
        assigned_agent_id: assignedAgentId,
        department_id: departmentId,
        transfer_from_agent_id: args.fromAgentId,
        transfer_to_agent_id: args.toAgentId || null,
        transfer_to_department_id: args.toDepartmentId || null,
        transfer_reason: args.reason || null,
      })
      .eq('id', args.callSessionId)
      .eq('workspace_id', args.workspaceId);

    await sb
      .from('call_queue_entries')
      .update({
        assigned_agent_id: assignedAgentId,
        department_id: departmentId,
        last_routing_at: new Date().toISOString(),
      })
      .eq('call_session_id', args.callSessionId)
      .eq('workspace_id', args.workspaceId);

    await sb.from('call_events').insert({
      call_session_id: args.callSessionId,
      event_type: 'call_transferred',
      actor_type: 'operator',
      actor_id: args.actorId,
      payload: {
        from_agent_id: args.fromAgentId,
        to_agent_id: assignedAgentId,
        to_department_id: departmentId,
      },
    });
    await publishCallEvent(config, args.workspaceId, args.callSessionId, 'call_transferred', {
      call_id: args.callSessionId, agent_id: assignedAgentId, department_id: departmentId,
    });
    await publishQueueEvent(config, args.workspaceId, 'call_transferred', {
      call_id: args.callSessionId, agent_id: assignedAgentId, department_id: departmentId,
    });

    return {
      ok: true,
      assigned_agent_id: assignedAgentId,
      department_id: departmentId,
      // Honest disclosure: media handoff is manual.
      handoff: 'manual',
      message:
        'Transfer reassigns the call and lets the new operator join the same room. Automatic media handoff/disconnect will be added later.',
    };
  } catch (e) {
    await sb.from('call_events').insert({
      call_session_id: args.callSessionId,
      event_type: 'call_transfer_failed',
      actor_type: 'operator',
      actor_id: args.actorId,
      payload: { error: e instanceof Error ? e.message : String(e) },
    });
    if (e instanceof RoutingException) throw e;
    throw new RoutingException('transfer_failed', 500);
  }
}
