/**
 * A workspace member's identity in a call room, and the way back to the user.
 *
 * Everyone in a LiveKit room sees every other participant's identity, name,
 * metadata and attributes, and the visitor is in every call room (the call
 * widget's, and a call offered from the chat). A member therefore never joins
 * under their user id: an operator (or admin, internal) joins as
 * `<type>:<ref>`, where <ref> is the opaque reference the call widget's status
 * endpoint already sends as `call.assigned_agent_id` (D27/S9): the first 16 hex
 * of HMAC-SHA256 under the widget-session secret over
 * `ccw-agent-ref:<call>:<user>`. So:
 *   - one member on one call keeps one identity (a second device, or a rejoin,
 *     replaces the older connection, as LiveKit does for a repeated identity);
 *     another call or another member gets another;
 *   - the visitor can match a participant to the status's reference, and learns
 *     nothing about who it is;
 *   - the server finds the user again from the call (resolveParticipantId).
 * The room shows a member under their public name: the profile's own name, as
 * the visitor already sees it in the call status, or nothing; never an id or
 * any part of an e-mail.
 *
 * Calls that began before this release carry `<type>:<user uuid>`: every parser
 * keeps accepting it (rolling deploy, rollback).
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { mustDb } from '../../utils/mustDb.js';
import { launcherInitial } from '../../../shared/launcherStyles.js';

export type ParticipantType = 'visitor' | 'operator' | 'admin' | 'internal';
export type MemberParticipantType = Exclude<ParticipantType, 'visitor'>;

const PARTICIPANT_TYPES: ReadonlySet<string> = new Set(['visitor', 'operator', 'admin', 'internal']);
/** As the webhook has always read a user id out of an identity. */
const LEGACY_ID = /^[0-9a-f-]{36}$/i;
const REF = /^[0-9a-f]{16}$/;

/**
 * The secret chain of the widget session (and of the status endpoint's
 * reference, `server/routes/callWidget.ts` `operatorReference`): both must
 * yield the same reference for the same call and user.
 */
type OptionalSecrets = { widgetTokenSecret?: string; sessionSecret?: string };
function referenceKey(config: ServerConfig): string {
  const secrets = config as ServerConfig & OptionalSecrets;
  return secrets.widgetTokenSecret || secrets.sessionSecret || config.signingSecret || config.supabaseServiceRoleKey;
}

/** The opaque reference of one user on one call (the status's `call.assigned_agent_id`). */
export function operatorReference(config: ServerConfig, callId: string, userId: string): string {
  return crypto.createHmac('sha256', referenceKey(config)).update(`ccw-agent-ref:${callId}:${userId}`).digest('hex').slice(0, 16);
}

export function isMemberParticipantType(type: string): type is MemberParticipantType {
  return type === 'operator' || type === 'admin' || type === 'internal';
}

/** A member's identity in the room of one call: `<type>:<ref>`. */
export function memberParticipantIdentity(
  config: ServerConfig,
  callId: string,
  type: MemberParticipantType,
  userId: string,
): string {
  return `${type}:${operatorReference(config, callId, userId)}`;
}

export interface ParsedParticipantIdentity {
  /** The part before the first `:` (anything unknown counts as `internal`, as the webhook always read it). */
  type: ParticipantType;
  /** The id after it when it is a uuid: a member's user id (the old form) or a visitor's id. */
  uuid: string | null;
  /** A member's opaque reference (the current form). */
  ref: string | null;
}

export function parseParticipantIdentity(identity: string): ParsedParticipantIdentity {
  const at = identity.indexOf(':');
  const head = at >= 0 ? identity.slice(0, at) : identity;
  const rest = at >= 0 ? identity.slice(at + 1) : '';
  const type = (PARTICIPANT_TYPES.has(head) ? head : 'internal') as ParticipantType;
  return {
    type,
    uuid: at >= 0 && LEGACY_ID.test(rest) ? rest : null,
    ref: at >= 0 && isMemberParticipantType(type) && REF.test(rest) ? rest : null,
  };
}

type Db = ReturnType<typeof getServiceClient>;

/**
 * The `call_participants.participant_id` of a room identity: the member's user
 * id (from the old form, or found again from the reference), a visitor's id
 * when it is a uuid, else null. A reference is matched against the people the
 * call names, cheapest first: a row an earlier event of the same identity
 * resolved; the call's own columns (the operator who has it, the transfer's two
 * ends, who started it) and its queue entry; the workspace's members (an
 * operator of a call transferred twice, whose join was never seen). A read that
 * fails throws, so the webhook answers non-2xx and LiveKit retries, rather than
 * recording the participant as nobody.
 */
export async function resolveParticipantId(
  config: ServerConfig,
  sb: Db,
  args: { callSessionId: string; workspaceId: string; identity: string },
): Promise<string | null> {
  const parsed = parseParticipantIdentity(args.identity);
  if (parsed.uuid) return parsed.uuid;
  if (!parsed.ref) return null;
  const ref = parsed.ref;
  const tried = new Set<string>();
  const match = (candidates: Array<unknown>): string | null => {
    for (const c of candidates) {
      if (typeof c !== 'string' || !c || tried.has(c)) continue;
      tried.add(c);
      if (operatorReference(config, args.callSessionId, c) === ref) return c;
    }
    return null;
  };

  const parts = (await mustDb(
    await sb.from('call_participants')
      .select('participant_id, provider_participant_id')
      .eq('call_session_id', args.callSessionId),
    'call_participants.select:resolveParticipantId',
  )) as Array<{ participant_id: string | null; provider_participant_id: string | null }> | null;
  const rows = parts ?? [];
  // Resolved when this identity joined (kept even if the secret changed since).
  const stored = rows.find((r) => r.provider_participant_id === args.identity && r.participant_id);
  if (stored?.participant_id) return stored.participant_id;

  const call = (await mustDb(
    await sb.from('call_sessions')
      .select('assigned_agent_id, transfer_from_agent_id, transfer_to_agent_id, initiated_by')
      .eq('id', args.callSessionId)
      .maybeSingle(),
    'call_sessions.select:resolveParticipantId',
  )) as Record<string, string | null> | null;
  const queue = (await mustDb(
    await sb.from('call_queue_entries')
      .select('assigned_agent_id, offered_to_user_id')
      .eq('call_session_id', args.callSessionId),
    'call_queue_entries.select:resolveParticipantId',
  )) as Array<Record<string, string | null>> | null;
  const named = match([
    call?.assigned_agent_id, call?.transfer_from_agent_id, call?.transfer_to_agent_id, call?.initiated_by,
    ...(queue ?? []).flatMap((q) => [q.assigned_agent_id, q.offered_to_user_id]),
    ...rows.map((r) => r.participant_id),
  ]);
  if (named) return named;

  const members = (await mustDb(
    await sb.from('workspace_members').select('user_id').eq('workspace_id', args.workspaceId),
    'workspace_members.select:resolveParticipantId',
  )) as Array<{ user_id: string | null }> | null;
  return match((members ?? []).map((m) => m.user_id));
}

/**
 * A profile's own name as a visitor may see it, or empty: the rule of the call
 * status's `operator_name` (`publicPresence.ts` `operatorOwnName`, kept equal by
 * test; not imported, so the media provider does not load the presence memo):
 * trimmed, and a name with nothing that shows is no name.
 */
export function publicNameOf(fullName: unknown): string {
  const name = typeof fullName === 'string' ? fullName.trim() : '';
  return name && launcherInitial([name]) ? name : '';
}

/**
 * The name a room shows for a member: their profile's own name, or empty.
 * Never an id, never an e-mail (whatever a client asks to be called). A failed
 * read is no name: the call goes on without one.
 */
export async function publicMemberName(config: ServerConfig, userId: string): Promise<string> {
  try {
    const { data } = await getServiceClient(config).from('profiles').select('full_name').eq('id', userId).maybeSingle();
    return publicNameOf((data as { full_name?: unknown } | null)?.full_name);
  } catch {
    return '';
  }
}
