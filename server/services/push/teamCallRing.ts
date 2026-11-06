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
 * A workspace whose plan has the mobile app off (`mobile_app` false;
 * docs/operations/MOBILE_APP_PLAN.md) rings no phone: its targets are none,
 * so nothing is rung and nothing is recorded to cancel. The call itself is
 * still placed, and the callee's open web panel rings from its realtime
 * event as for anyone else.
 *
 * A stop never overtakes its ring. FCM keeps no order between two messages
 * sent a few milliseconds apart, so a caller who cancels at once could have
 * the `team_call_cancel` delivered before the `team_call_incoming`, and the
 * phone would ring for a call that is over until its own `expiresAt`. So a
 * ring in flight is kept here by call id until its sends are done, and a
 * cancel for that call waits for it first; and a ring whose call stopped
 * ringing before its sends began sends nothing. The map is per process: one
 * replica is the common case, and with more the ring's own state check still
 * keeps most such rings from going out at all. When the backend runs several
 * processes in one container (BACKEND_PROCESSES, docs/operations/
 * BACKEND_PROCESSES.md) the ring also holds the container-wide lock
 * `ring:<call>` from before anyone can learn the call's id
 * (holdTeamCallRing) until its sends are done, and a cancel on any worker
 * waits on it (at most CANCEL_WAITS_FOR_RING_MS).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendVoipPush, isVoipConfigured } from './apnsVoip.js';
import { sendFcmData, isPushConfigured } from './fcm.js';
import { disableToken, forgetVoipToken } from './devices.js';
import { mobileAppAllowed } from '../mobileApp/planGate.js';
import { getPlatformEditionOrNull } from '../platformRegion.js';
import { hubActive, hubLock } from '../../cluster/client.js';
import type { Edition } from '../../../shared/edition.js';
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
  /** Whether an accepted ring to it stamps `rang_at` (teamCallPushStampsRang). */
  pushStampsRang: boolean;
}

/** An Android phone of the callee, rung over FCM. */
export interface TeamCallAndroidDevice {
  rowId: string;
  deviceId: string;
  token: string;
  /** As on TeamCallIosDevice. */
  pushStampsRang: boolean;
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
  app_version?: string | null;
}

/**
 * Which builds a ring push stamps `rang_at` for (docs/operations/TEAM_CALLS.md,
 * "Ringback for old builds"): those that ring for colleague calls but do not
 * say `POST /:id/rang` themselves, `floor <= build < first`.
 *
 * `first`, the first build that says `rang`:
 *   - Android, WebYar (`iran`): versionCode 30, WebYar 1.9, the first built
 *     with #412 (1.8, versionCode 29, is the one on Cafe Bazaar).
 *   - Android, RESPOK (`international`): versionCode 6, RESPOK 1.0.5, built
 *     from the same tree as WebYar 1.9 (docs/ANDROID_RELEASE.md).
 *   - iOS, both brands (one CURRENT_PROJECT_VERSION for both targets): build
 *     6. #414 brought `rang` with the project still at 5, and every upload
 *     before it (the App Store archive of 2026-11-03 included) is 5 or
 *     below; the project went to 6 with this rule, so every build cut from
 *     `main` since is 6 or above.
 *
 * `floor`, the first build that rings for colleague calls at all: below it
 * the app has no handler for the ring, the push is accepted all the same, and
 * a stamp would show "Ringing…" while nothing rings:
 *   - Android, WebYar: versionCode 28 (1.7, built from `main` at b6fee6e).
 *   - Android, RESPOK: versionCode 4 (1.0.3, the same tree).
 *   - iOS: build 3 (#382, colleague calls; builds 1 and 2 had none).
 *
 * When the edition cannot be read, WebYar's numbers apply: they stamp only
 * WebYar 1.7 and 1.8 (no RESPOK build was ever numbered 28 or 29), so a
 * RESPOK phone is then not stamped and its caller sees an honest "Calling…".
 */
export const TEAM_CALL_PUSH_STAMP_BUILDS = {
  android: {
    iran: { floor: 28, first: 30 },
    international: { floor: 4, first: 6 },
  },
  ios: { floor: 3, first: 6 },
} as const;

/**
 * The build number in an `app_version` as both apps register it:
 * `"<name> (<build>)"` (Android's versionName and versionCode, iOS's
 * CFBundleShortVersionString and CFBundleVersion). Null when there is none.
 */
export function teamCallAppBuild(appVersion: string | null | undefined): number | null {
  const match = /\((\d{1,9})\)\s*$/.exec(appVersion ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Whether an accepted ring push to this phone stamps `rang_at` (platform
 * `push`): only a build that rings for colleague calls and cannot say `rang`
 * itself. A phone with no app_version, or none with a build number in it,
 * is never stamped: it could as well be a build from before colleague calls,
 * and an honest "Calling…" is better than "Ringing…" while nothing rings.
 */
export function teamCallPushStampsRang(
  platform: 'ios' | 'android',
  appVersion: string | null | undefined,
  edition: Edition | null,
): boolean {
  const build = teamCallAppBuild(appVersion);
  if (build === null) return false;
  const range = platform === 'ios'
    ? TEAM_CALL_PUSH_STAMP_BUILDS.ios
    : TEAM_CALL_PUSH_STAMP_BUILDS.android[edition ?? 'iran'];
  return build >= range.floor && build < range.first;
}

/**
 * The callee's phones that a ring can reach: every enabled iOS registration
 * with a VoIP token (when APNs is configured), every enabled Android one
 * addressed over FCM (when Firebase is). The caller has checked the callee is
 * an active member; a suspended or seat-locked one is never rung. None at
 * all when [workspaceId]'s plan has the mobile app off (a plan that cannot
 * be read rings as before). Never throws: an unreadable device list rings
 * nobody.
 */
export async function teamCallRingTargets(
  config: ServerConfig,
  calleeId: string,
  workspaceId: string,
): Promise<TeamCallRingTargets> {
  const voip = isVoipConfigured();
  const fcm = isPushConfigured();
  if (!voip && !fcm) return { ios: [], android: [] };
  if (!(await mobileAppAllowed(config, workspaceId))) return { ios: [], android: [] };
  try {
    const sb = getServiceClient(config);
    const [iosRead, androidRead] = await Promise.all([
      voip
        ? sb
          .from('mobile_push_devices')
          .select('id, device_id, voip_token, app_version')
          .eq('user_id', calleeId)
          .eq('platform', 'ios')
          .eq('enabled', true)
          .not('voip_token', 'is', null)
        : Promise.resolve({ data: [] as DeviceRow[], error: null }),
      fcm
        ? sb
          .from('mobile_push_devices')
          .select('id, device_id, push_token, app_version')
          .eq('user_id', calleeId)
          .eq('platform', 'android')
          .eq('transport', 'fcm')
          .eq('enabled', true)
          .not('push_token', 'is', null)
        : Promise.resolve({ data: [] as DeviceRow[], error: null }),
    ]);
    const iosRows = ((iosRead.data ?? []) as DeviceRow[]).filter((r) => !!r.voip_token && !!r.device_id);
    const androidRows = ((androidRead.data ?? []) as DeviceRow[]).filter((r) => !!r.push_token && !!r.device_id);
    const edition = androidRows.length ? await getPlatformEditionOrNull(config) : null;
    const ios = iosRows.map((r) => ({
      rowId: String(r.id),
      deviceId: String(r.device_id),
      voipToken: String(r.voip_token),
      pushStampsRang: teamCallPushStampsRang('ios', r.app_version, edition),
    }));
    const android = androidRows.map((r) => ({
      rowId: String(r.id),
      deviceId: String(r.device_id),
      token: String(r.push_token),
      pushStampsRang: teamCallPushStampsRang('android', r.app_version, edition),
    }));
    return { ios, android };
  } catch (err) {
    console.warn('[team-call-ring] device lookup failed:', err instanceof Error ? err.message : err);
    return { ios: [], android: [] };
  }
}

/** Rings whose sends are not done yet, by call id (see the top of this file). */
const ringsInFlight = new Map<string, Promise<unknown>>();

/** Cluster mode: the release of each call's `ring:<call>` hold, by call id. */
const ringHolds = new Map<string, () => void>();
/** How long a cancel on another worker waits for the call's ring at most. */
const CANCEL_WAITS_FOR_RING_MS = 10_000;

function releaseRingHold(callId: string): void {
  const release = ringHolds.get(callId);
  if (!release) return;
  ringHolds.delete(callId);
  release();
}

/**
 * Cluster mode only (a no-op in the single process): takes the
 * container-wide hold on the call's ring, acknowledged by the primary, so a
 * stop handled by another worker waits for the ring's sends. Await it before
 * ringTeamCall, before the call is announced and before its id is answered;
 * ringTeamCall releases it when its sends are done.
 */
export async function holdTeamCallRing(callId: string): Promise<void> {
  if (!hubActive()) return;
  const release = await hubLock(`ring:${callId}`, 0);
  ringHolds.set(callId, release);
  // Never longer than the ring itself, whatever happens to ringTeamCall.
  const timer = setTimeout(() => releaseRingHold(callId), (TEAM_CALL_RING_SECONDS + 15) * 1000);
  timer.unref?.();
}

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
    releaseRingHold(input.callId);
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
    // The first accepted ring of a phone that cannot say `rang` stamps it
    // for that phone (once per call; markTeamCallRang keeps the first
    // stamp). Started, never awaited here: the stamp can find the ring over
    // and mark it missed, whose stop waits for this very ring.
    let stamped = false;
    const accepted = (device: { deviceId: string; pushStampsRang: boolean }): void => {
      if (!device.pushStampsRang || stamped) return;
      stamped = true;
      startPushStamp(config, input.callId, device.deviceId);
    };
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
        if (outcome.ok) accepted(device);
        return outcome.ok;
      }),
      ...targets.android.map(async (device) => {
        const ok = await sendAndroid(config, device.token, data, input.callId);
        if (ok) accepted(device);
        return ok;
      }),
    ]);
    return { sent: outcomes.filter(Boolean).length, devices };
  } catch (err) {
    console.warn('[team-call-ring] ring failed:', err instanceof Error ? err.message : err);
    return { sent: 0, devices };
  }
}

/**
 * The ring stamp for an old build (platform `push`): the call, if still
 * ringing with no stamp, gets `rang_at` now and both members hear it, as from
 * `POST /:id/rang`. A best effort: the transport took the push, which says
 * nothing of the phone being on. A real `rang` that came first wins, and so
 * does this over a later one; neither changes the state or the ring's end.
 * Never rejects. Kept out of the ring in flight (sendRing): when the ring
 * ran out meanwhile, markTeamCallRang marks the call missed, and that stop
 * (cancelTeamCallRing) waits for the ring.
 *
 * The lifecycle is imported when needed: it imports this file for the
 * ring's stop.
 */
const pushStampsInFlight = new Map<string, Promise<void>>();

function startPushStamp(config: ServerConfig, callId: string, deviceId: string): void {
  const stamping = stampRangFromPush(config, callId, deviceId);
  pushStampsInFlight.set(callId, stamping);
  void stamping.then(() => {
    if (pushStampsInFlight.get(callId) === stamping) pushStampsInFlight.delete(callId);
  });
}

/** For tests: the push stamp of [callId] that is still being written, if any. */
export function teamCallPushStampSettled(callId: string): Promise<void> {
  return pushStampsInFlight.get(callId) ?? Promise.resolve();
}

async function stampRangFromPush(config: ServerConfig, callId: string, deviceId: string): Promise<void> {
  try {
    const { loadTeamCall, markTeamCallRang } = await import('../calls/teamCallLifecycle.js');
    const row = await loadTeamCall(config, callId);
    if (!row) return;
    const rang = await markTeamCallRang(config, row, { deviceId, platform: 'push' });
    await rang.effects;
  } catch (err) {
    console.warn('[team-call-ring] push stamp failed:', err instanceof Error ? err.message : err);
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
    // A ring sent by another worker of this container (cluster mode only).
    if (hubActive()) (await hubLock(`ring:${input.callId}`, CANCEL_WAITS_FOR_RING_MS))();
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
