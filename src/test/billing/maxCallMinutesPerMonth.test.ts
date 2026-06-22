/**
 * Phase: max_call_minutes_per_month — Final Activation.
 *
 * Verifies the plan-side monthly billable-minutes ceiling helper:
 *   - unlimited (limit = -1) → allowed without consulting usage
 *   - under the ceiling → allowed
 *   - at the ceiling → denied with plan_limit_reached
 *   - plan does not include the key → plan_forbidden
 *   - usage resolver unsupported → fail-closed (usage_unavailable)
 *   - denial body shape is stable and capability-tagged
 *
 * Counting source is workspace_usage_counters.call_minutes_used,
 * written exclusively by the DB trigger tg_call_sessions_bill_minutes.
 * This test pins the read path only — no second writer exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const entitlementResult: { value: any } = { value: { allowed: true, limit: -1, plan: "free" } };
vi.mock("../../../server/middleware/featureGating.js", () => ({
  checkEntitlementFromDB: async (_u: string, _k: string, _ws: string, feature: string) => {
    if (feature !== "max_call_minutes_per_month") return { allowed: false, reason: "wrong_key" };
    return entitlementResult.value;
  },
}));

const usageResult: { value: any } = { value: { value: 0, supported: true } };
vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  resolveUsage: async (_c: any, _ws: string, key: string) => {
    if (key !== "max_call_minutes_per_month") return { value: 0, supported: false };
    return usageResult.value;
  },
}));

import {
  checkPlanMonthlyMinutesCeiling,
  planMinutesDenialBody,
} from "../../../server/services/calls/monthlyMinutesLimit";

const config: any = { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" };
const WS = "22222222-2222-2222-2222-222222222222";

describe("max_call_minutes_per_month — plan ceiling helper", () => {
  beforeEach(() => {
    entitlementResult.value = { allowed: true, limit: -1, plan: "free" };
    usageResult.value = { value: 0, supported: true };
  });

  it("unlimited (-1) → allowed without consulting usage", async () => {
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(-1);
  });

  it("under the ceiling → allowed", async () => {
    entitlementResult.value = { allowed: true, limit: 1000, plan: "pro" };
    usageResult.value = { value: 250, supported: true };
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    expect(d.allowed).toBe(true);
  });

  it("at the ceiling → denied with plan_limit_reached", async () => {
    entitlementResult.value = { allowed: true, limit: 60, plan: "pro" };
    usageResult.value = { value: 60, supported: true };
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("plan_limit_reached");
    expect(d.limit).toBe(60);
    expect(d.used).toBe(60);
  });

  it("plan does not include the key → plan_forbidden", async () => {
    entitlementResult.value = { allowed: false, reason: "feature_not_in_plan", plan: "legacy" };
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("plan_forbidden");
  });

  it("usage resolver unsupported → fail-closed", async () => {
    entitlementResult.value = { allowed: true, limit: 100, plan: "pro" };
    usageResult.value = { value: 0, supported: false, reasonIfUnsupported: "x" };
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("usage_unavailable");
  });

  it("denial body is stable + capability-tagged", async () => {
    entitlementResult.value = { allowed: true, limit: 10, plan: "pro" };
    usageResult.value = { value: 10, supported: true };
    const d = await checkPlanMonthlyMinutesCeiling(config, WS);
    const body = planMinutesDenialBody(d);
    expect(body.error).toBe("plan_limit_reached");
    expect(body.capability).toBe("max_call_minutes_per_month");
    expect(body.upgrade_required).toBe(true);
  });
});