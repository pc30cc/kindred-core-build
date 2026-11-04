/**
 * Who may act on a call-centre call (the call widget's calls): one rule for
 * the Call Center console's routes (routes/callCenter.ts) and the generic
 * call routes the dashboard and the apps also use on those calls
 * (routes/calls.ts, `/api/calls/:id/*`; audit 2026-11-04, calls-3 and -8).
 *
 *   - Only the operator roles act on a call; viewer, analyst, billing, SEO
 *     and marketing never do.
 *   - A call assigned to another operator is theirs: only an elevated role
 *     (owner, admin, team lead) may take it over, end it, transfer it or
 *     join it.
 *   - An unassigned call may be accepted (or assigned, or transferred) by any
 *     operator; rejected, ended or joined only by an elevated role or by the
 *     operator the queue is offering it to.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

/** Roles allowed to operate calls (accept/reject/end/availability). */
export const OPERATOR_ROLES = new Set([
  'owner', 'admin', 'agent', 'support_agent', 'team_lead',
]);

/**
 * Roles allowed to take over / force-end a call already assigned to another
 * operator. Keep this strictly conservative.
 */
export const ELEVATED_CALL_ROLES = new Set(['owner', 'admin', 'team_lead']);

/**
 * `accept`, `assign`, `transfer`: an unassigned call is open to any operator.
 * `reject`, `end`, `join` (a room token, recording): an unassigned call only
 * to an elevated role or the operator it is offered to.
 */
export type CallAction = 'accept' | 'assign' | 'transfer' | 'reject' | 'end' | 'join';

export interface OwnershipDecision {
  role: string | null;
  isElevated: boolean;
  isAssignedToMe: boolean;
  isTakeover: boolean;
}

export interface HttpStatusError extends Error {
  httpStatus: number;
}

export function isHttpStatusError(e: unknown): e is HttpStatusError {
  return e instanceof Error && typeof (e as { httpStatus?: unknown }).httpStatus === 'number';
}

export function makeHttpStatusError(message: string, httpStatus: number): HttpStatusError {
  const err = new Error(message) as HttpStatusError;
  err.httpStatus = httpStatus;
  return err;
}

export async function getWorkspaceRole(
  config: ServerConfig, workspaceId: string, userId: string,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.rpc('get_workspace_role', {
    _workspace_id: workspaceId, _user_id: userId,
  });
  return data ? String(data) : null;
}

const OPEN_WHEN_UNASSIGNED: ReadonlySet<CallAction> = new Set(['accept', 'assign', 'transfer']);

/**
 * Decide whether the user can perform `action` on a call-centre call.
 * Returns the resolved role and whether this is an elevated takeover; throws
 * an HttpStatusError (403) the route turns into its answer. `role` may be
 * passed when the caller already has it; `globalAdmin` acts as elevated.
 */
export async function canOperateCall(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  call: { assigned_agent_id?: string | null } | null | undefined,
  action: CallAction,
  queueRow?: { offered_to_user_id?: string | null } | null,
  opts: { role?: string | null; globalAdmin?: boolean } = {},
): Promise<OwnershipDecision> {
  const role = opts.role !== undefined ? opts.role : await getWorkspaceRole(config, workspaceId, userId);
  const isElevated = opts.globalAdmin === true || (!!role && ELEVATED_CALL_ROLES.has(role));
  const assigned = (call?.assigned_agent_id as string | null) || null;
  const isAssignedToMe = !!assigned && assigned === userId;

  if (assigned && assigned !== userId) {
    if (!isElevated) {
      throw makeHttpStatusError('call_assigned_to_another_operator', 403);
    }
    return { role, isElevated, isAssignedToMe: false, isTakeover: true };
  }

  if (!assigned && !OPEN_WHEN_UNASSIGNED.has(action)) {
    const offeredToMe = !!queueRow && queueRow.offered_to_user_id === userId;
    if (!isElevated && !offeredToMe) {
      throw makeHttpStatusError('operator_permission_required', 403);
    }
  }
  return { role, isElevated, isAssignedToMe, isTakeover: false };
}
