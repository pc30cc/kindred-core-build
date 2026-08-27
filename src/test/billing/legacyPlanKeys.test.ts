import { describe, it, expect } from "vitest";
import {
  validatePlanPayload,
  normalizePlanLimitsForCreate,
  USAGE_BACKED_LIMIT_KEYS,
  getCapability,
} from "../../../server/services/billing/capabilityRegistry";

/**
 * Backward-compatibility contract for legacy plan JSON keys catalogued in
 * docs/PLAN_DATA_RECONCILIATION.md. These keys still live in active
 * `billing_plans` seed rows (free / pro / enterprise) and MUST continue
 * to:
 *   - validate as warnings (never errors),
 *   - pass untouched through the create-time normalizer,
 *   - not collide with any canonical registry key.
 *
 * If any of these break, plan create/update will hard-fail on existing
 * legacy seed rows or silently mutate legacy values — both are
 * regressions of the strict cleanup phase.
 */

const LEGACY_ENTITLEMENT_KEYS = [
  "advanced_analytics",
  "ai_enabled",
] as const;

const LEGACY_LIMIT_KEYS = [
  "conversations",
  "conversations_monthly",
  "contacts",
  "team_members",
  "agents",
  "ai_credits",
  "ai_requests_monthly",
  "ai_kb_monthly_credits",
  "ai_kb_max_articles",
  "ai_kb_max_chars",
  "kb_articles",
  "storage_mb",
  "file_storage_mb",
] as const;

describe("legacy plan keys — soft backward compatibility", () => {
  it("known legacy entitlement keys validate silently (no warning, no error)", () => {
    const ent = Object.fromEntries(
      LEGACY_ENTITLEMENT_KEYS.map((k) => [k, true]),
    );
    const result = validatePlanPayload({ entitlements: ent });
    expect(result.valid).toBe(true);
    for (const k of LEGACY_ENTITLEMENT_KEYS) {
      expect(
        result.issues.find((i) => i.key === k),
        `legacy entitlement '${k}' must not raise an issue`,
      ).toBeUndefined();
    }
  });

  it("known legacy limit keys validate silently (no warning, no error)", () => {
    const lim = Object.fromEntries(LEGACY_LIMIT_KEYS.map((k) => [k, 123]));
    const result = validatePlanPayload({ limits: lim });
    expect(result.valid).toBe(true);
    for (const k of LEGACY_LIMIT_KEYS) {
      expect(
        result.issues.find((i) => i.key === k),
        `legacy limit '${k}' must not raise an issue`,
      ).toBeUndefined();
    }
  });

  it("genuinely unknown keys still warn", () => {
    const result = validatePlanPayload({ limits: { totally_made_up_key: 1 } });
    expect(result.valid).toBe(true);
    const issue = result.issues.find((i) => i.key === "totally_made_up_key");
    expect(issue).toBeDefined();
    expect(issue!.level).toBe("warning");
  });


  it("legacy keys are not in the registry (no accidental rename collision)", () => {
    // Note: the string 'contacts' is intentionally excluded — it is a
    // canonical *module* key in the registry AND a legacy *limit* key in
    // seed JSON. The cross-namespace collision is documented in
    // docs/PLAN_DATA_RECONCILIATION.md §2.2 and surfaces correctly as a
    // type-mismatch warning via validatePlanPayload (covered above).
    const noCollision = [
      ...LEGACY_ENTITLEMENT_KEYS,
      ...LEGACY_LIMIT_KEYS.filter((k) => k !== "contacts"),
    ];
    for (const k of noCollision) {
      expect(getCapability(k), `legacy key '${k}' must not be in registry`).toBeUndefined();
    }
  });

  it("normalizer passes legacy limit keys through untouched", () => {
    const input = {
      contacts: 5000,
      team_members: 10,
      conversations_monthly: 1000,
      storage_mb: 5000,
      ai_requests_monthly: 5000,
    };
    const out = normalizePlanLimitsForCreate(input);
    for (const [k, v] of Object.entries(input)) {
      expect(out[k]).toBe(v);
    }
  });

  it("normalizer never overwrites a caller-supplied canonical limit", () => {
    const input: Record<string, number> = {};
    for (const k of USAGE_BACKED_LIMIT_KEYS) input[k] = 999;
    const out = normalizePlanLimitsForCreate(input);
    for (const k of USAGE_BACKED_LIMIT_KEYS) {
      expect(out[k]).toBe(999);
    }
  });

  it("normalizer fills only missing canonical resolver-ready keys with registry defaults", () => {
    const out = normalizePlanLimitsForCreate({});
    for (const k of USAGE_BACKED_LIMIT_KEYS) {
      const def = getCapability(k);
      if (def && typeof def.defaultValue === "number") {
        expect(out[k]).toBe(def.defaultValue);
      }
    }
  });

  it("a realistic Pro-style legacy seed validates without errors", () => {
    const result = validatePlanPayload({
      entitlements: {
        advanced_analytics: true,
        ai_enabled: true,
        ai_kb_builder: true,
        custom_branding: true,
        knowledge_base: true,
        priority_support: false,
      },
      limits: {
        ai_credits_per_month: 5000,
        ai_kb_jobs_per_month: 5,
        ai_kb_max_articles: 30,
        ai_kb_max_chars: 100000,
        ai_kb_max_depth: 2,
        ai_kb_max_pages: 25,
        ai_kb_monthly_credits: 200,
        ai_requests_monthly: 5000,
        contacts: 5000,
        conversations_monthly: 1000,
        kb_articles: 100,
        max_conversations: 1000,
        max_visitors: 50000,
        storage_gb: 5,
        storage_mb: 5000,
        team_members: 10,
      },
    });
    expect(result.valid).toBe(true);
    expect(result.issues.every((i) => i.level === "warning")).toBe(true);
  });
});