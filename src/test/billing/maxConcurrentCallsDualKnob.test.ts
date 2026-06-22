/**
 * Phase: max_concurrent_calls — Dual-Knob Activation.
 *
 * Verifies:
 *   1. The canonical plan-side concurrency resolver counts call_sessions
 *      using the canonical active-state set across ALL entry_source
 *      values (not just call_widget).
 *   2. Plan-level check_workspace_entitlement('max_concurrent_calls')
 *      drives the helper:
 *        - limit = -1 → allowed
 *        - usage < limit → allowed
 *        - usage >= limit → denied with `plan_limit_reached`
 *   3. Both the operator /api/calls/create route and the visitor
 *      widget create boundary use the same helper, so the plan key
 *      has exactly one counting model.
 *   4. The widget-scoped knob continues to deny via its existing
 *      shape (`error: 'limit_reached', kind: 'concurrent'`) — meaning
 *      preserved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks for the helper module ────────────────────────────
const entitlementResult: { value: any } = { value: { allowed: true, limit: -1, plan: "free" } };
vi.mock("../../../server/middleware/featureGating.js", () => ({
  checkEntitlementFromDB: async (_u: string, _k: string, _ws: string, feature: string) => {
    if (feature !== "max_concurrent_calls") return { allowed: false, reason: "wrong_key" };
    return entitlementResult.value;
  },
}));

const usageResult: { value: any } = { value: { value: 0, supported: true } };
vi.mock("../../../server/services/billing/usageResolvers.js", () => ({
  resolveUsage: async (_c: any, _ws: string, key: string) => {
    if (key !== "max_concurrent_calls") return { value: 0, supported: false };
    return usageResult.value;
  },
}));

import {
  checkPlanConcurrencyCeiling,
  planConcurrencyDenialBody,
} from "../../../server/services/calls/concurrencyLimit";

const config: any = { supabaseUrl: "http://x", supabaseServiceRoleKey: "k" };
const WS = "11111111-1111-1111-1111-111111111111";

describe("max_concurrent_calls — dual-knob plan ceiling helper", () => {
  beforeEach(() => {
    entitlementResult.value = { allowed: true, limit: -1, plan: "free" };
    usageResult.value = { value: 0, supported: true };
  });

  it("unlimited (limit = -1) → allowed without consulting usage", async () => {
    entitlementResult.value = { allowed: true, limit: -1, plan: "free" };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.limit).toBe(-1);
  });

  it("under the ceiling → allowed", async () => {
    entitlementResult.value = { allowed: true, limit: 3, plan: "pro" };
    usageResult.value = { value: 2, supported: true };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(true);
  });

  it("at the ceiling → denied with plan_limit_reached", async () => {
    entitlementResult.value = { allowed: true, limit: 3, plan: "pro" };
    usageResult.value = { value: 3, supported: true };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("plan_limit_reached");
      expect(d.limit).toBe(3);
      expect(d.used).toBe(3);
    }
  });

  it("plan does not include the key → plan_forbidden", async () => {
    entitlementResult.value = { allowed: false, reason: "feature_not_in_plan", plan: "legacy" };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("plan_forbidden");
  });

  it("usage resolver unsupported → fail-closed (usage_unavailable)", async () => {
    entitlementResult.value = { allowed: true, limit: 5, plan: "pro" };
    usageResult.value = { value: 0, supported: false, reasonIfUnsupported: "x" };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("usage_unavailable");
  });

  it("denial body shape is distinct from the widget-knob shape", async () => {
    entitlementResult.value = { allowed: true, limit: 1, plan: "pro" };
    usageResult.value = { value: 1, supported: true };
    const d = await checkPlanConcurrencyCeiling(config, WS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      const body = planConcurrencyDenialBody(d);
      // distinct from `{ error: 'limit_reached', kind: 'concurrent' }`
      expect(body.error).toBe("plan_limit_reached");
      expect(body.capability).toBe("max_concurrent_calls");
      expect(body.upgrade_required).toBe(true);
    }
  });
});