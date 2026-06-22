/**
 * Phase: recording_retention_days — Final Activation.
 *
 * Pure-helper coverage for the retention resolver + stamper. The
 * janitor itself is exercised indirectly via the policy these
 * helpers enforce: only rows with a non-null `retention_expires_at`
 * are ever selected, so `-1`/unlimited never deletes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ent: { value: any } = { value: { allowed: true, limit: 30, plan: "pro" } };
vi.mock("../../../server/middleware/featureGating.js", () => ({
  checkEntitlementFromDB: async (_u: string, _k: string, _ws: string, f: string) => {
    if (f !== "recording_retention_days") return { allowed: false };
    return ent.value;
  },
}));

const plane: { value: any } = { value: { retention_default_days: 30 } };
vi.mock("../../../server/services/calls/controlPlane.js", () => ({
  loadCallControlPlane: async () => plane.value,
}));

import {
  computeRetentionExpiresAt,
  resolveEffectiveRecordingRetentionDays,
} from "../../../server/services/recordings/recordingRetention";

const cfg: any = { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" };
const WS = "33333333-3333-3333-3333-333333333333";

describe("recording_retention_days — effective resolver", () => {
  beforeEach(() => {
    ent.value = { allowed: true, limit: 30, plan: "pro" };
    plane.value = { retention_default_days: 30 };
  });

  it("uses workspace/plan limit when present", async () => {
    ent.value = { allowed: true, limit: 7, plan: "pro" };
    const r = await resolveEffectiveRecordingRetentionDays(cfg, WS);
    expect(r.days).toBe(7);
    expect(r.source).toBe("workspace_or_plan");
  });

  it("falls back to control-plane default when plan does not include the key", async () => {
    ent.value = { allowed: false, reason: "feature_not_in_plan" };
    plane.value = { retention_default_days: 45 };
    const r = await resolveEffectiveRecordingRetentionDays(cfg, WS);
    expect(r.days).toBe(45);
    expect(r.source).toBe("control_plane_default");
  });

  it("treats -1 (unlimited) as a real plan value, not a fallthrough", async () => {
    ent.value = { allowed: true, limit: -1, plan: "enterprise" };
    const r = await resolveEffectiveRecordingRetentionDays(cfg, WS);
    expect(r.days).toBe(-1);
    expect(r.source).toBe("workspace_or_plan");
  });
});

describe("recording_retention_days — stamper", () => {
  it("computes expires_at as created_at + days", () => {
    const iso = computeRetentionExpiresAt("2026-06-01T00:00:00Z", 7);
    expect(iso).toBe("2026-06-08T00:00:00.000Z");
  });

  it("returns NULL for unlimited (-1) so the janitor never selects it", () => {
    expect(computeRetentionExpiresAt("2026-06-01T00:00:00Z", -1)).toBeNull();
  });

  it("returns NULL on garbage input (fail-closed against accidental deletion)", () => {
    expect(computeRetentionExpiresAt("not-a-date", 30)).toBeNull();
    expect(computeRetentionExpiresAt("2026-06-01T00:00:00Z", Number.NaN)).toBeNull();
  });

  it("0 days = expires immediately (administrative purge mode)", () => {
    const iso = computeRetentionExpiresAt("2026-06-01T00:00:00Z", 0);
    expect(iso).toBe("2026-06-01T00:00:00.000Z");
  });
});