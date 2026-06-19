/**
 * Call Entitlement Composer
 *
 * Single canonical helper for composing plan-level call entitlements
 * with the existing runtime/global/workspace call control plane.
 *
 * Plan keys act as an UPPER BOUND on what the control plane lets
 * through. The control plane (`loadEffectiveCallChannels`) stays
 * authoritative for runtime kill switches, provider routing, and
 * per-call defaults. This module DOES NOT replace it — it composes
 * a logical AND on top.
 *
 * No route is gated on this composer yet. It exists so the next
 * enforcement phase has one place to consult, instead of scattering
 * ad-hoc plan checks across many call handlers.
 */
import type { ServerConfig } from '../../config.js';
import {
  loadEffectiveCallChannels,
  type EffectiveCallChannels,
} from './controlPlane.js';
import {
  checkChannelAccess,
  checkEntitlementFromDB,
  checkModuleAccess,
} from '../../middleware/featureGating.js';

export interface PlanCallEntitlements {
  voice_video: boolean;     // module
  voice: boolean;           // channel
  video: boolean;           // channel
  call_center: boolean;     // module
  call_recording: boolean;  // feature
  call_queue: boolean;      // feature
  call_callbacks: boolean;  // feature
}

export interface EffectiveCallEntitlements {
  /** Operator-initiated voice calls. */
  voice_enabled: boolean;
  /** Operator-initiated video calls. */
  video_enabled: boolean;
  /** Visitor-initiated voice. */
  visitor_voice_enabled: boolean;
  /** Visitor-initiated video. */
  visitor_video_enabled: boolean;
  /** Recording surfaces (start/stop) usable. */
  recording_enabled: boolean;
  /** Queue surfaces usable (admission, offer, accept). */
  queue_enabled: boolean;
  /** Callback request/management surfaces usable. */
  callbacks_enabled: boolean;
  /** True iff any of the above are usable. Convenience for module-level gating. */
  call_center_enabled: boolean;
  plan: PlanCallEntitlements;
  runtime: EffectiveCallChannels;
}

/**
 * Pure composition. Tested independently from any DB/RPC layer.
 * Effective = plan AND runtime. Both layers must agree.
 */
export function composeCallEntitlements(
  plan: PlanCallEntitlements,
  runtime: EffectiveCallChannels,
): EffectiveCallEntitlements {
  const voice = plan.voice_video && plan.voice && runtime.voice_enabled;
  const video = plan.voice_video && plan.video && runtime.video_enabled;
  const visitor_voice =
    plan.voice_video && plan.voice && runtime.visitor_initiated_audio;
  const visitor_video =
    plan.voice_video && plan.video && runtime.visitor_initiated_video;
  const recording =
    plan.voice_video && plan.call_recording && runtime.recording_enabled;
  const queue =
    plan.call_center && plan.call_queue && runtime.queue_enabled;
  // Callbacks are gated by call_center module + call_callbacks feature
  // and rely on the queue runtime gate (callbacks are surfaced once a
  // queue offer has timed out per `callback_offer_after_timeout`).
  const callbacks =
    plan.call_center && plan.call_callbacks && runtime.queue_enabled;

  return {
    voice_enabled: voice,
    video_enabled: video,
    visitor_voice_enabled: visitor_voice,
    visitor_video_enabled: visitor_video,
    recording_enabled: recording,
    queue_enabled: queue,
    callbacks_enabled: callbacks,
    call_center_enabled: queue || callbacks,
    plan,
    runtime,
  };
}

/**
 * Async resolver. Reads plan entitlements via the existing RPC layer
 * (`check_module_access`, `check_channel_access`,
 * `check_workspace_entitlement`) and composes them with the runtime
 * control plane. Fail-closed: any RPC error collapses the
 * corresponding plan flag to false.
 */
export async function loadEffectiveCallEntitlements(
  config: ServerConfig,
  workspaceId: string,
): Promise<EffectiveCallEntitlements> {
  const url = config.supabaseUrl;
  const key = config.supabaseServiceRoleKey;

  const [
    voiceVideoMod,
    callCenterMod,
    voiceCh,
    videoCh,
    recordingFeat,
    queueFeat,
    callbacksFeat,
    runtime,
  ] = await Promise.all([
    checkModuleAccess(url, key, workspaceId, 'voice_video'),
    checkModuleAccess(url, key, workspaceId, 'call_center'),
    checkChannelAccess(url, key, workspaceId, 'voice'),
    checkChannelAccess(url, key, workspaceId, 'video'),
    checkEntitlementFromDB(url, key, workspaceId, 'call_recording'),
    checkEntitlementFromDB(url, key, workspaceId, 'call_queue'),
    checkEntitlementFromDB(url, key, workspaceId, 'call_callbacks'),
    loadEffectiveCallChannels(config, workspaceId),
  ]);

  const plan: PlanCallEntitlements = {
    voice_video: !!voiceVideoMod.allowed,
    voice: !!voiceCh.allowed,
    video: !!videoCh.allowed,
    call_center: !!callCenterMod.allowed,
    call_recording: !!recordingFeat.allowed,
    call_queue: !!queueFeat.allowed,
    call_callbacks: !!callbacksFeat.allowed,
  };

  return composeCallEntitlements(plan, runtime);
}