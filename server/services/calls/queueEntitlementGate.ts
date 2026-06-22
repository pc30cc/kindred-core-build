/**
 * Visitor Queue Enqueue — plan denial helper.
 *
 * Single-purpose helper consumed only by the visitor-side queue enqueue
 * surface (POST /api/widget/call-queue/enqueue). It does NOT introduce a
 * second composer or a new capability key — it only projects the canonical
 * EffectiveCallEntitlements onto the channel the visitor requested.
 *
 * plan_forbidden produced here is strictly distinct from runtime queue /
 * business-state denials emitted by the queue service (queue_disabled,
 * voice_disabled, video_disabled — runtime workspace toggles, surfaced as
 * 409) and from validation failures (400). Status/cancel/read flows do
 * NOT call this helper.
 */
import type { EffectiveCallEntitlements } from './entitlementComposer.js';

export type QueueChannel = 'audio' | 'video';

export interface QueueDenial {
  allowed: false;
  capability: 'call_queue' | 'voice' | 'video';
}
export interface QueueAllow { allowed: true }
export type QueueGateResult = QueueAllow | QueueDenial;

export function evaluateVisitorQueueEnqueueGate(
  eff: EffectiveCallEntitlements,
  channel: QueueChannel,
): QueueGateResult {
  if (!eff.queue_enabled) return { allowed: false, capability: 'call_queue' };
  if (channel === 'audio' && !eff.visitor_voice_enabled) {
    return { allowed: false, capability: 'voice' };
  }
  if (channel === 'video' && !eff.visitor_video_enabled) {
    return { allowed: false, capability: 'video' };
  }
  return { allowed: true };
}