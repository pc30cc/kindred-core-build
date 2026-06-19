import { describe, it, expect } from "vitest";
import {
  composeCallEntitlements,
  type PlanCallEntitlements,
} from "../../../server/services/calls/entitlementComposer";
import type { EffectiveCallChannels } from "../../../server/services/calls/controlPlane";

const allPlan: PlanCallEntitlements = {
  voice_video: true,
  voice: true,
  video: true,
  call_center: true,
  call_recording: true,
  call_queue: true,
  call_callbacks: true,
};

const allRuntime: EffectiveCallChannels = {
  voice_enabled: true,
  video_enabled: true,
  recording_enabled: true,
  queue_enabled: true,
  visitor_initiated_audio: true,
  visitor_initiated_video: true,
};

describe("composeCallEntitlements — plan AND runtime", () => {
  it("opens everything when both layers allow it", () => {
    const eff = composeCallEntitlements(allPlan, allRuntime);
    expect(eff.voice_enabled).toBe(true);
    expect(eff.video_enabled).toBe(true);
    expect(eff.visitor_voice_enabled).toBe(true);
    expect(eff.visitor_video_enabled).toBe(true);
    expect(eff.recording_enabled).toBe(true);
    expect(eff.queue_enabled).toBe(true);
    expect(eff.callbacks_enabled).toBe(true);
    expect(eff.call_center_enabled).toBe(true);
  });

  it("plan voice_video=false closes operator + visitor voice/video and recording", () => {
    const eff = composeCallEntitlements(
      { ...allPlan, voice_video: false },
      allRuntime,
    );
    expect(eff.voice_enabled).toBe(false);
    expect(eff.video_enabled).toBe(false);
    expect(eff.visitor_voice_enabled).toBe(false);
    expect(eff.visitor_video_enabled).toBe(false);
    expect(eff.recording_enabled).toBe(false);
    // Queue/callbacks still allowed because they're scoped to call_center.
    expect(eff.queue_enabled).toBe(true);
    expect(eff.callbacks_enabled).toBe(true);
  });

  it("plan call_center=false closes queue and callbacks regardless of runtime", () => {
    const eff = composeCallEntitlements(
      { ...allPlan, call_center: false },
      allRuntime,
    );
    expect(eff.queue_enabled).toBe(false);
    expect(eff.callbacks_enabled).toBe(false);
    expect(eff.call_center_enabled).toBe(false);
  });

  it("runtime voice_enabled=false closes operator voice but not video", () => {
    const eff = composeCallEntitlements(allPlan, {
      ...allRuntime,
      voice_enabled: false,
      visitor_initiated_audio: false,
    });
    expect(eff.voice_enabled).toBe(false);
    expect(eff.visitor_voice_enabled).toBe(false);
    expect(eff.video_enabled).toBe(true);
  });

  it("runtime queue_enabled=false closes both queue and callbacks", () => {
    const eff = composeCallEntitlements(allPlan, {
      ...allRuntime,
      queue_enabled: false,
    });
    expect(eff.queue_enabled).toBe(false);
    expect(eff.callbacks_enabled).toBe(false);
  });

  it("plan channel voice=false closes voice but leaves video open", () => {
    const eff = composeCallEntitlements(
      { ...allPlan, voice: false },
      allRuntime,
    );
    expect(eff.voice_enabled).toBe(false);
    expect(eff.visitor_voice_enabled).toBe(false);
    expect(eff.video_enabled).toBe(true);
  });

  it("plan call_recording=false closes recording even when runtime allows", () => {
    const eff = composeCallEntitlements(
      { ...allPlan, call_recording: false },
      allRuntime,
    );
    expect(eff.recording_enabled).toBe(false);
  });

  it("is purely a logical AND — never opens what either layer denies", () => {
    const denyAllPlan: PlanCallEntitlements = {
      voice_video: false,
      voice: false,
      video: false,
      call_center: false,
      call_recording: false,
      call_queue: false,
      call_callbacks: false,
    };
    const eff = composeCallEntitlements(denyAllPlan, allRuntime);
    expect(eff.voice_enabled).toBe(false);
    expect(eff.video_enabled).toBe(false);
    expect(eff.visitor_voice_enabled).toBe(false);
    expect(eff.visitor_video_enabled).toBe(false);
    expect(eff.recording_enabled).toBe(false);
    expect(eff.queue_enabled).toBe(false);
    expect(eff.callbacks_enabled).toBe(false);
    expect(eff.call_center_enabled).toBe(false);
  });
});