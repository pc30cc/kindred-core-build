/**
 * RINGING A CALL ON THE OPERATOR'S PHONE.
 *
 * Until this existed the call centre could only reach an operator who already
 * had the console open in a browser tab: `call_requested` and `call_routed`
 * went out on the realtime channel and nowhere else. A phone in a pocket
 * learned about a waiting caller when its owner next looked at it.
 *
 * What this adds is the missing half: a VoIP push per eligible operator, which
 * iOS hands to PushKit and the app turns into a real CallKit ring — the phone
 * rings on the lock screen, with the caller's name, whether the app is open,
 * backgrounded or not running at all.
 *
 * Rules that keep it honest:
 *  • Ringing follows the SAME routing decision the console follows. An
 *    assigned call rings one phone; a broadcast call rings every available
 *    agent. Nobody is rung who would not have been offered the call.
 *  • Every send is best-effort and swallowed. A phone that cannot be reached
 *    must never fail the call for the visitor or for anyone else.
 *  • A ring is always followed by a cancel — on accept, reject, end or the
 *    visitor hanging up — because a CallKit call that nothing ends keeps
 *    ringing until iOS gives up, which is the single worst bug this feature
 *    can have.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { randomUUID } from 'node:crypto';
import { sendVoipPush, isVoipConfigured } from './apnsVoip.js';
import { createStorageUrlResolver, resolveContactAvatarUrl } from '../storage/urlResolver.js';

/** How long a ring is worth delivering. Past this it is a missed call. */
const RING_TTL_SECONDS = 45;

export interface RingInput {
  workspaceId: string;
  callSessionId: string;
  /** `null` rings every available agent, matching broadcast routing. */
  agentId: string | null;
  channel: 'audio' | 'video';
}

interface RingDevice {
  id: string;
  userId: string;
  voipToken: string;
}

/** The handful of columns this file reads, named rather than inferred. */
interface MemberRoleRow {
  user_id: string;
  role: string | null;
}

interface PresenceRow {
  user_id: string;
  status: string | null;
}

interface DeviceRow {
  id: string;
  user_id: string;
  voip_token: string | null;
}

interface CallRow {
  id: string;
  contact_id: string | null;
  visitor_session_id: string | null;
}

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  visitor_code: string | null;
  avatar_url: string | null;
  avatar_storage_key: string | null;
}

interface WorkspaceRow {
  name: string | null;
}

/**
 * Rings the phones that should be ringing for this call.
 *
 * Returns how many devices were reached, which the caller may log. It never
 * throws.
 */
export async function ringOperators(
  config: ServerConfig,
  input: RingInput,
): Promise<{ sent: number; devices: number }> {
  if (!isVoipConfigured()) return { sent: 0, devices: 0 };
  try {
    const userIds = await resolveRingRecipients(config, input);
    if (!userIds.length) return { sent: 0, devices: 0 };

    const devices = await voipDevicesFor(config, userIds);
    if (!devices.length) return { sent: 0, devices: 0 };

    const caller = await describeCaller(config, input.workspaceId, input.callSessionId);
    const payload = {
      event: 'incoming',
      call_id: input.callSessionId,
      workspace_id: input.workspaceId,
      workspace_name: caller.workspaceName,
      channel: input.channel,
      caller: caller.name,
      caller_id: caller.id,
      avatar_url: caller.avatarUrl,
      expires_at: Math.floor(Date.now() / 1000) + RING_TTL_SECONDS,
    };

    const outcomes = await Promise.all(
      devices.map(async (device) => {
        const outcome = await sendVoipPush({
          token: device.voipToken,
          payload,
          collapseId: input.callSessionId,
          expirationSeconds: RING_TTL_SECONDS,
        });
        if (outcome.unregistered) await forgetVoipToken(config, device.id);
        return outcome.ok;
      }),
    );
    return { sent: outcomes.filter(Boolean).length, devices: devices.length };
  } catch (err) {
    console.warn('[call-ring] ring failed:', err instanceof Error ? err.message : err);
    return { sent: 0, devices: 0 };
  }
}

/**
 * Stops every phone that might be ringing for this call.
 *
 * Sent to all devices that could have been rung rather than only the ones we
 * know we reached: a ring delivered to a phone we then forgot about would
 * otherwise keep ringing with nothing to stop it. Duplicated cancels are
 * harmless — the app ends a call it has already ended without complaint.
 */
export async function cancelRing(
  config: ServerConfig,
  input: {
    workspaceId: string;
    callSessionId: string;
    /** Why it stopped, so the phone can say "answered elsewhere". */
    reason: 'answered' | 'declined' | 'ended' | 'cancelled' | 'timeout';
    /** The operator who took it, so their own phone is left alone. */
    exceptUserId?: string | null;
    /**
     * Silences only this operator's phones. A rejection is personal: the
     * others are still being offered the call and must keep ringing.
     */
    onlyUserId?: string | null;
  },
): Promise<void> {
  if (!isVoipConfigured()) return;
  try {
    const userIds = input.onlyUserId
      ? [input.onlyUserId]
      : await everyAgentInWorkspace(config, input.workspaceId);
    const targets = input.exceptUserId
      ? userIds.filter((id) => id !== input.exceptUserId)
      : userIds;
    if (!targets.length) return;

    const devices = await voipDevicesFor(config, targets);
    if (!devices.length) return;

    const payload = {
      event: 'cancel',
      call_id: input.callSessionId,
      workspace_id: input.workspaceId,
      reason: input.reason,
    };
    await Promise.all(
      devices.map(async (device) => {
        const outcome = await sendVoipPush({
          token: device.voipToken,
          payload,
          collapseId: input.callSessionId,
          // A cancel that arrives late is worse than useless, so it expires
          // with the ring it is cancelling.
          expirationSeconds: RING_TTL_SECONDS,
        });
        if (outcome.unregistered) await forgetVoipToken(config, device.id);
      }),
    );
  } catch (err) {
    console.warn('[call-ring] cancel failed:', err instanceof Error ? err.message : err);
  }
}

// ── Who to ring ─────────────────────────────────────────────────────────

async function resolveRingRecipients(
  config: ServerConfig,
  input: RingInput,
): Promise<string[]> {
  if (input.agentId) return [input.agentId];
  // Broadcast: everyone the router would have considered, which is every
  // operator-roled member whose presence says they are available.
  return availableAgents(config, input.workspaceId);
}

const OPERATOR_ROLES = new Set(['owner', 'admin', 'team_lead', 'agent']);

async function workspaceOperatorIds(
  config: ServerConfig,
  workspaceId: string,
): Promise<string[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);
  return ((data || []) as MemberRoleRow[])
    .filter((m) => OPERATOR_ROLES.has(String(m.role ?? '')))
    .map((m) => String(m.user_id));
}

async function availableAgents(config: ServerConfig, workspaceId: string): Promise<string[]> {
  const ids = await workspaceOperatorIds(config, workspaceId);
  if (!ids.length) return [];
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_center_agent_presence')
    .select('user_id, status')
    .eq('workspace_id', workspaceId)
    .in('user_id', ids);
  const available = new Set(
    ((data || []) as PresenceRow[])
      .filter((p) => String(p.status ?? '') === 'available')
      .map((p) => String(p.user_id)),
  );
  return ids.filter((id) => available.has(id));
}

/**
 * Everyone who could conceivably have a ringing phone for this workspace.
 * Presence is deliberately NOT consulted here: an agent who went away after
 * being rung still has a phone that needs telling to stop.
 */
async function everyAgentInWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<string[]> {
  return workspaceOperatorIds(config, workspaceId);
}

async function voipDevicesFor(
  config: ServerConfig,
  userIds: string[],
): Promise<RingDevice[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('mobile_push_devices')
    .select('id, user_id, voip_token')
    .in('user_id', userIds)
    .eq('enabled', true)
    .not('voip_token', 'is', null);
  return ((data || []) as DeviceRow[])
    .filter((row): row is DeviceRow & { voip_token: string } => !!row.voip_token)
    .map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      voipToken: row.voip_token,
    }));
}

async function forgetVoipToken(config: ServerConfig, deviceId: string): Promise<void> {
  try {
    const sb = getServiceClient(config);
    // The device keeps its notification token: only its VoIP address is dead.
    await sb
      .from('mobile_push_devices')
      .update({ voip_token: null, voip_token_updated_at: new Date().toISOString() })
      .eq('id', deviceId);
  } catch { /* best-effort */ }
}

// ── Who is calling ──────────────────────────────────────────────────────

interface CallerDescription {
  name: string;
  id: string;
  avatarUrl: string | null;
  workspaceName: string | null;
}

/**
 * The name CallKit puts on the lock screen.
 *
 * A contact's own name first, then whatever identifies the visitor, and only
 * then a generic label — an operator answering a call deserves to know who it
 * is before they pick up, and "Unknown" is the last resort, not the default.
 */
async function describeCaller(
  config: ServerConfig,
  workspaceId: string,
  callSessionId: string,
): Promise<CallerDescription> {
  const sb = getServiceClient(config);
  const fallback: CallerDescription = {
    name: 'Website visitor',
    id: callSessionId,
    avatarUrl: null,
    workspaceName: null,
  };
  try {
    const [{ data: call }, { data: workspace }] = await Promise.all([
      sb
        .from('call_sessions')
        .select('id, contact_id, visitor_session_id, metadata')
        .eq('id', callSessionId)
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      sb.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
    ]);
    fallback.workspaceName = (workspace as WorkspaceRow | null)?.name ?? null;
    if (!call) return fallback;

    const contactId = (call as CallRow).contact_id;
    if (contactId) {
      const { data: contact } = await sb
        .from('contacts')
        .select('id, name, email, visitor_code, avatar_url, avatar_storage_key')
        .eq('id', contactId)
        .maybeSingle();
      if (contact) {
        const row = contact as ContactRow;
        const name = firstNonEmpty([row.name, row.email, row.visitor_code]) ?? fallback.name;
        return {
          name,
          id: String(row.id),
          // From the key through the provider in use now, like every other avatar.
          avatarUrl: await resolveContactAvatarUrl(createStorageUrlResolver(config), workspaceId, row),
          workspaceName: fallback.workspaceName,
        };
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}


/**
 * Rings the caller's own phone with a made-up call, for diagnostics.
 *
 * Push delivery has a long chain — key, topic, environment, token, background
 * mode, CallKit — and every link fails silently. Without a way to ring on
 * demand the only test is to have somebody load the website and call, then
 * guess which link broke. This makes the chain testable in one tap.
 *
 * It rings a real CallKit call on the tester's device, with a call id that
 * belongs to no call session, so answering it finds nothing to answer and the
 * app ends it. That is the honest behaviour: the point is the ring.
 */
export async function ringTestDevice(
  config: ServerConfig,
  input: { userId: string; callerName: string; channel: 'audio' | 'video' },
): Promise<{ devices: number; sent: number; failures: string[] }> {
  if (!isVoipConfigured()) return { devices: 0, sent: 0, failures: ['not_configured'] };
  const devices = await voipDevicesFor(config, [input.userId]);
  if (!devices.length) return { devices: 0, sent: 0, failures: ['no_devices'] };

  const callId = randomUUID();
  const payload = {
    event: 'incoming',
    call_id: callId,
    workspace_id: TEST_WORKSPACE_ID,
    channel: input.channel,
    caller: input.callerName,
    expires_at: Math.floor(Date.now() / 1000) + RING_TTL_SECONDS,
  };

  const failures: string[] = [];
  let sent = 0;
  for (const device of devices) {
    const outcome = await sendVoipPush({
      token: device.voipToken,
      payload,
      collapseId: callId,
      expirationSeconds: RING_TTL_SECONDS,
    });
    if (outcome.ok) sent += 1;
    else failures.push(outcome.reason || `status_${outcome.status ?? 0}`);
    if (outcome.unregistered) await forgetVoipToken(config, device.id);
  }
  return { devices: devices.length, sent, failures };
}

/** A workspace id that exists nowhere, so a test ring cannot touch real data. */
const TEST_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
