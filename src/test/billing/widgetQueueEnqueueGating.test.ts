/**
 * Visitor Queue Enqueue — plan denial helper unit tests.
 *
 * Verifies the canonical-composer-backed gate used at
 * POST /api/widget/call-queue/enqueue. Only this helper is in scope —
 * runtime queue/business-state denials (queue_disabled / voice_disabled /
 * video_disabled) are emitted by the queue service and remain strictly
 * distinct from plan_forbidden.
 */
import { describe, it, expect } from "vitest";
import { evaluateVisitorQueueEnqueueGate } from "../../../server/services/calls/queueEntitlementGate";
import type { EffectiveCallEntitlements } from "../../../server/services/calls/entitlementComposer";

const fullEff: EffectiveCallEntitlements = {
  voice_enabled: true,
  video_enabled: true,
  visitor_voice_enabled: true,
  visitor_video_enabled: true,
  recording_enabled: true,
  queue_enabled: true,
  callbacks_enabled: true,
  call_center_enabled: true,
  plan: {} as any,
  runtime: {} as any,
} as any;

describe("visitor queue enqueue plan gate", () => {
  it("allows audio when visitor_voice_enabled and queue_enabled", () => {
    expect(evaluateVisitorQueueEnqueueGate(fullEff, "audio")).toEqual({ allowed: true });
  });

  it("allows video when visitor_video_enabled and queue_enabled", () => {
    expect(evaluateVisitorQueueEnqueueGate(fullEff, "video")).toEqual({ allowed: true });
  });

  it("denies with capability=call_queue when queue_enabled=false (regardless of channel)", () => {
    const eff = { ...fullEff, queue_enabled: false };
    expect(evaluateVisitorQueueEnqueueGate(eff, "audio"))
      .toEqual({ allowed: false, capability: "call_queue" });
    expect(evaluateVisitorQueueEnqueueGate(eff, "video"))
      .toEqual({ allowed: false, capability: "call_queue" });
  });

  it("denies audio with capability=voice when visitor_voice_enabled=false", () => {
    const eff = { ...fullEff, visitor_voice_enabled: false };
    expect(evaluateVisitorQueueEnqueueGate(eff, "audio"))
      .toEqual({ allowed: false, capability: "voice" });
  });

  it("denies video with capability=video when visitor_video_enabled=false", () => {
    const eff = { ...fullEff, visitor_video_enabled: false };
    expect(evaluateVisitorQueueEnqueueGate(eff, "video"))
      .toEqual({ allowed: false, capability: "video" });
  });

  it("queue_enabled=false takes precedence over channel-level denial (stable shape)", () => {
    const eff = { ...fullEff, queue_enabled: false, visitor_voice_enabled: false };
    expect(evaluateVisitorQueueEnqueueGate(eff, "audio"))
      .toEqual({ allowed: false, capability: "call_queue" });
  });
});