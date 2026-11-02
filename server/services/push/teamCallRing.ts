/**
 * RINGING A COLLEAGUE'S PHONES FOR A COLLEAGUE CALL (team calls).
 *
 * The contract is docs/operations/TEAM_CALLS.md, "Ring and its stop". A
 * colleague call rings like a phone call, on the lock screen too:
 *
 *  • iOS: a VoIP push (PushKit) to every enabled device of the callee that
 *    registered a VoIP token. The app reports each one to CallKit before
 *    PushKit's handler returns, which is what iOS demands of every VoIP push:
 *    so this is the ONLY VoIP push a colleague call ever sends. A ring is
 *    never followed by a VoIP "cancel" (it would be one more incoming call);
 *    a ringing iPhone learns that the call is over from the API (it polls
 *    GET /api/team-calls/:id) and from its realtime channel, and at
 *    `expires_at` on its own.
 *  • Android: a data-only, high-priority FCM message (`team_call_incoming`)
 *    the app turns into its full-screen call notification, and a
 *    `team_call_cancel` that stops it — sent only to the Android phones that
 *    were rung, and never to the one that answered.
 *
 * The devices rung are chosen before the call row is written and recorded in
 * it (`metadata.team_call.rung_*_device_ids`, by install id): the cancel goes
 * to exactly those, and nothing else ever has to write the row while it
 * rings. Every send is best-effort and swallowed: a phone that cannot be
 * reached never fails the call. Payloads carry ids and display strings only,
 * never an e-mail; the CallKit handle the app shows is the call id.
 *
 * A stop never overtakes its ring. FCM keeps no order between two messages
 * sent a few milliseconds apart, so a caller who cancels at once could have
 * the `team_call_cancel` delivered before the `team_call_incoming`, and the
 * phone would ring for a call that is over until its own `expiresAt`. So a
 * ring in flight is kept here by call id until its sends are done, and a
 * cancel for that call waits for it first; and a ring whose call stopped
 * ringing before its sends began sends nothing. The map is per process: one
 * replica is the common case, and with more the ring's own state check still
 * keeps most such rings from going out at all.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendVoipPush, isVoipConfigured } from './apnsVoip.js';
import { sendFcmData, isPushConfigured } from './fcm.js';
import { disableToken, forgetVoipToken } from './devices.js';
import {
  TEAM_CALL_RING_SECONDS,
  type TeamCallCancelReason,
  type TeamCallChannel,
} from '../calls/teamCall.js';

/** An iPhone of the callee, rung over PushKit. */
export interface TeamCallIosDevice {
  /** `mobile_push_devices.id`. */
  rowId: string;
  /** The install's own id (`mobile_push_devices.device_id`). */
  deviceId: string;
  voipToken: string;
}

/** An Android phone of the callee, rung over FCM. */
export interface TeamCallAndroidDevice {
  rowId: string;
  deviceId: string;
  token: string;
}

export interface TeamCallRingTargets {
  ios: TeamCallIosDevice[];
  android: TeamCallAndroidDevice[];
}

/** Who is calling, and from where, as the ring shows it. */
export interface TeamCallRingInput {
  callId: string;
  workspaceId: string;
  workspaceName: string | null;
  channel: TeamCallChannel;
  callerUserId: string;
  /** The caller's profile name, or empty: the app then says "Colleague". */
  callerName: string;
  callerAvatarUrl: string | null;
  /**
   * When the ring runs out, in Unix seconds: a JSON number in the PushKit
   * payload (`expires_at`, which the iOS app reads from an NSNumber) and the
   * same number as a string in the FCM data (`expiresAt`, as FCM requires).
   * src/test/ios/teamCallVoipPayload.test.ts holds the server and the iOS
   * parser to it. The REST `TeamCall.expires_at` is the same instant in ISO
   * 8601.
   */
  expiresAt: number;
}

/**
 * A signed avatar URL that would crowd out the rest of a push (FCM's 4 KB,
 * PushKit's 5 KB) is left out: the app draws the colleague's silhouette.
 */
const MAX_AVATAR_URL = 1500;

function avatarFor(url: string | null): string | null {
  return url && url.length <= MAX_AVATAR_URL ? url : null;
}

/** The PushKit payload of a colleague's ring. */
export function teamCallVoipPayload(input: TeamCallRingInput): Record<string, unknown> {
  return {
    kind: 'team_call',
    event: 'incoming',
    call_id: input.callId,
    workspace_id: input.workspaceId,
    workspace_name: input.workspaceName ? input.workspaceName.slice(0, 120) : null,
    channel: input.channel,
    caller_name: input.callerName.slice(0, 120),
    caller_avatar_url: avatarFor(input.callerAvatarUrl),
    caller_user_id: input.callerUserId,
    expires_at: input.expiresAt,
  };
}

/** The FCM data of a colleague's ring (every value a string, as FCM requires). */
export function teamCallAndroidRingData(input: TeamCallRingInput): Record<string, string> {
  const data: Record<string, string> = {
    type: 'team_call_incoming',
    callId: input.callId,
    workspaceId: input.workspaceId,
    channel: input.channel,
    callerName: input.callerName.slice(0, 120),
    callerUserId: input.callerUserId,
    expiresAt: String(input.expiresAt),
  };
  if (input.workspaceName) data.workspaceName = input.workspaceName.slice(0, 120);
  const avatar = avatarFor(input.callerAvatarUrl);
  if (avatar) data.callerAvatarUrl = avatar;
  return data;
}

/** The FCM data that stops a rung Android phone. */
export function teamCallAndroidCancelData(callId: string, reason: TeamCallCancelReason): Record<string, string> {
  return { type: 'team_call_cancel', callId, reason };
}

interface DeviceRow {
  id: string;
  device_id: string | null;
  voip_token?: string | null;
  push_token?: string | null;
}

/**
 * The callee's phones that a ring can reach: every enabled iOS registration
 * with a VoIP token (when APNs is configured), every enabled Android one
 * addressed over FCM (when Firebase is). The caller has checked the callee is
 * an active member; a suspended or seat-locked one is never rung. Never
 * throws: an unreadable device list rings nobody.
 */
export async function teamCallRingTargets(config: ServerConfig, calleeId: string): Promise<TeamCallRingTargets> {
  const voip = isVoipConfigured();
  const fcm = isPushConfigured();
  if (!voip && !fcm) return { ios: [], android: [] };
  try {
    const sb = getServiceClient(config);
    const [iosRead, androidRead] = await Promise.all([
      voip
        ? sb
          .from('mobile_push_devices')
          .select('id, device_id, voip_token')
          .eq('user_id', calleeId)
          .eq('platform', 'ios')
          .eq('enabled', true)
          .not('voip_token', 'is', null)
        : Promise.resolve({ data: [] as DeviceRow[], error: null }),
      fcm
        ? sb
          .from('mobile_push_devices')
          .select('id, device_id, push_token')
          .eq('user_id', calleeId)
          .eq('platform', 'android')
          .eq('transport', 'fcm')
          .eq('enabled', true)
          .not('push_token', 'is', null)
        : Promise.resolve({ data: [] as DeviceRow[], error: null }),
    ]);
    const ios = ((iosRead.data ?? []) as DeviceRow[])
      .filter((r) => !!r.voip_token && !!r.device_id)
      .map((r) => ({ rowId: String(r.id), deviceId: String(r.device_id), voipToken: String(r.voip_token) }));
    const android = ((androidRead.data ?? []) as DeviceRow[])
      .filter((r) => !!r.push_token && !!r.device_id)
      .map((r) => ({ rowId: String(r.id), deviceId: String(r.device_id), token: String(r.push_token) }));
    return { ios, android };
  } catch (err) {
    console.warn('[team-call-ring] device lookup failed:', err instanceof Error ? err.message : err);
    return { ios: [], android: [] };
  }
}

/** Rings whose sends are not done yet, by call id (see the top of this file). */
const ringsInFlight = new Map<string, Promise<unknown>>();

/**
 * Rings [targets] for the call. Returns how many sends the transports
 * accepted, which the caller may log. Never rejects.
 *
 * Kept as the call's ring in flight from the moment it is called until its
 * sends are done: call it before anyone can learn the call's id, so that
 * every stop of the call finds it (cancelTeamCallRing).
 */
export function ringTeamCall(
  config: ServerConfig,
  input: TeamCallRingInput,
  targets: TeamCallRingTargets,
): Promise<{ sent: number; devices: number }> {
  const ringing = sendRing(config, input, targets);
  ringsInFlight.set(input.callId, ringing);
  void ringing.then(() => {
    if (ringsInFlight.get(input.callId) === ringing) ringsInFlight.delete(input.callId);
  });
  return ringing;
}

/**
 * Whether the call is still ringing, read just before its ring goes out. A
 * call that no longer is (cancelled, declined or missed already) is not rung.
 * A failed read rings: better a ring that its stop then ends than none.
 */
async function stillRinging(config: ServerConfig, callId: string): Promise<boolean> {
  try {
    const { data, error } = await getServiceClient(config)
      .from('call_sessions')
      .select('state')
      .eq('id', callId)
      .maybeSingle();
    if (error) return true;
    return (data as { state?: string } | null)?.state === 'ringing';
  } catch {
    return true;
  }
}

async function sendRing(
  config: ServerConfig,
  input: TeamCallRingInput,
  targets: TeamCallRingTargets,
): Promise<{ sent: number; devices: number }> {
  const devices = targets.ios.length + targets.android.length;
  if (!devices) return { sent: 0, devices: 0 };
  try {
    if (!(await stillRinging(config, input.callId))) return { sent: 0, devices };
    const payload = teamCallVoipPayload(input);
    const data = teamCallAndroidRingData(input);
    const outcomes = await Promise.all([
      ...targets.ios.map(async (device) => {
        const outcome = await sendVoipPush({
          token: device.voipToken,
          payload,
          collapseId: input.callId,
          expirationSeconds: TEAM_CALL_RING_SECONDS,
        });
        if (outcome.unregistered) await forgetVoipToken(config, device.rowId);
        else if (!outcome.ok) console.warn('[team-call-ring] voip send failed', { reason: outcome.reason, status: outcome.status });
        return outcome.ok;
      }),
      ...targets.android.map((device) => sendAndroid(config, device.token, data, input.callId)),
    ]);
    return { sent: outcomes.filter(Boolean).length, devices };
  } catch (err) {
    console.warn('[team-call-ring] ring failed:', err instanceof Error ? err.message : err);
    return { sent: 0, devices };
  }
}

/**
 * Stops the callee's rung Android phones: the ones the call row recorded,
 * still enabled, minus the install that answered — after the call's ring, if
 * this process is still sending it (see the top of this file). Never a VoIP
 * push. Never throws.
 */
export async function cancelTeamCallRing(
  config: ServerConfig,
  input: {
    callId: string;
    calleeId: string;
    androidDeviceIds: readonly string[];
    reason: TeamCallCancelReason;
    /** The install that answered: it is in the call, not ringing. */
    exceptDeviceId?: string | null;
  },
): Promise<void> {
  const deviceIds = input.androidDeviceIds.filter((id) => id && id !== input.exceptDeviceId);
  if (!deviceIds.length || !isPushConfigured()) return;
  try {
    await ringsInFlight.get(input.callId);
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('mobile_push_devices')
      .select('id, device_id, push_token')
      .eq('user_id', input.calleeId)
      .eq('platform', 'android')
      .eq('transport', 'fcm')
      .eq('enabled', true)
      .in('device_id', deviceIds)
      .not('push_token', 'is', null);
    const tokens = ((data ?? []) as DeviceRow[])
      .map((r) => r.push_token)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    const cancel = teamCallAndroidCancelData(input.callId, input.reason);
    await Promise.all(tokens.map((token) => sendAndroid(config, token, cancel, input.callId)));
  } catch (err) {
    console.warn('[team-call-ring] cancel failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * One data-only send to an Android phone, collapsed onto the call (a late
 * ring and its cancel replace one another) and dropped by FCM once the ring
 * would be over. A dead token disables its device, as everywhere else.
 */
async function sendAndroid(
  config: ServerConfig,
  token: string,
  data: Record<string, string>,
  callId: string,
): Promise<boolean> {
  const outcome = await sendFcmData({
    token,
    data,
    ttlSeconds: TEAM_CALL_RING_SECONDS,
    collapseKey: callId,
  });
  if (outcome.unregistered) await disableToken(config, token, 'fcm_unregistered');
  else if (!outcome.ok) console.warn('[team-call-ring] android send failed', { status: outcome.status });
  return outcome.ok;
}
