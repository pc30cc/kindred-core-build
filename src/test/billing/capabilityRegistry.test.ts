import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPABILITY_REGISTRY,
  USAGE_BACKED_LIMIT_KEYS,
  getCapability,
  normalizePlanLimitsForCreate,
  validatePlanPayload,
  diagnoseAgainstPlans,
} from "../../../server/services/billing/capabilityRegistry";

describe("capability registry — integrity", () => {
  it("has unique keys", () => {
    const keys = CAPABILITY_REGISTRY.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes every middleware capability key referenced by completed rollouts", () => {
    // Keys actively consumed by `requireFeature/requireModule/requireChannel/requireLimit`
    // call sites in completed rollouts. If any of these disappear from the registry,
    // middleware will silently degrade — fail the build instead.
    const required = [
      "max_conversations",
      "max_visitors",
      "storage_gb",
      "ai_kb_jobs_per_month",
      "ai_credits_per_month",
      "advanced_ai_agent",
      "ai_kb_builder",
    ];
    for (const k of required) {
      expect(getCapability(k), `missing capability '${k}'`).toBeDefined();
    }
  });

  it("USAGE_BACKED_LIMIT_KEYS only references real limit-type capabilities", () => {
    for (const k of USAGE_BACKED_LIMIT_KEYS) {
      const def = getCapability(k);
      expect(def, `usage-backed key '${k}' missing from registry`).toBeDefined();
      expect(def!.type).toBe("limit");
    }
  });
});

describe("capability registry — usage-resolver alignment", () => {
  // Read the resolver source as text rather than importing it: usageResolvers.ts
  // pulls in @supabase/supabase-js and ai-kb internals which aren't needed to
  // assert the static key alignment invariant.
  const resolverSrc = readFileSync(
    resolve(__dirname, "../../../server/services/billing/usageResolvers.ts"),
    "utf8",
  );

  function extractResolverKeys(src: string): string[] {
    const m = src.match(/const RESOLVERS:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\};/);
    if (!m) throw new Error("RESOLVERS block not found in usageResolvers.ts");
    return Array.from(m[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gmi)).map((mm) => mm[1]);
  }

  it("RESOLVERS keys exactly match USAGE_BACKED_LIMIT_KEYS", () => {
    const resolverKeys = extractResolverKeys(resolverSrc).sort();
    const registryKeys = [...USAGE_BACKED_LIMIT_KEYS].sort();
    expect(resolverKeys).toEqual(registryKeys);
  });
});

describe("normalizePlanLimitsForCreate", () => {
  it("fills missing usage-backed keys with registry defaults", () => {
    const out = normalizePlanLimitsForCreate({});
    for (const k of USAGE_BACKED_LIMIT_KEYS) {
      expect(out).toHaveProperty(k);
      expect(typeof out[k]).toBe("number");
    }
  });

  it("never overwrites caller-supplied values", () => {
    const out = normalizePlanLimitsForCreate({ max_conversations: 9999, storage_gb: -1 });
    expect(out.max_conversations).toBe(9999);
    expect(out.storage_gb).toBe(-1);
  });

  it("preserves unknown / legacy keys untouched", () => {
    const out = normalizePlanLimitsForCreate({ legacy_quota_xyz: 42 });
    expect(out.legacy_quota_xyz).toBe(42);
  });

  it("does not mutate the input object", () => {
    const input = { max_conversations: 10 };
    normalizePlanLimitsForCreate(input);
    expect(Object.keys(input)).toEqual(["max_conversations"]);
  });
});

describe("validatePlanPayload", () => {
  it("flags non-boolean entitlement as error", () => {
    const r = validatePlanPayload({ entitlements: { advanced_ai_agent: 1 as any } });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.level === "error" && i.key === "advanced_ai_agent")).toBe(true);
  });

  it("flags non-numeric limit as error", () => {
    const r = validatePlanPayload({ limits: { storage_gb: "1gb" as any } });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.level === "error" && i.key === "storage_gb")).toBe(true);
  });

  it("warns on unknown keys but stays valid (backward compat)", () => {
    const r = validatePlanPayload({ limits: { legacy_xyz: 5 } });
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.level === "warning" && i.key === "legacy_xyz")).toBe(true);
  });

  it("accepts -1 as unlimited", () => {
    const r = validatePlanPayload({ limits: { storage_gb: -1, max_conversations: -1 } });
    expect(r.valid).toBe(true);
  });
});

describe("diagnoseAgainstPlans", () => {
  it("reports unknown DB keys, missing registry keys, and invalid values", () => {
    const d = diagnoseAgainstPlans([
      {
        id: "p1",
        slug: "free",
        entitlements: { advanced_ai_agent: false, mystery_flag: true } as any,
        limits: { max_conversations: 100, storage_gb: "huge" as any, legacy_quota: 7 },
      },
    ]);
    expect(d.unknownKeysInDb).toEqual(
      expect.arrayContaining([
        { planSlug: "free", key: "mystery_flag", bucket: "entitlements" },
        { planSlug: "free", key: "legacy_quota", bucket: "limits" },
      ]),
    );
    expect(d.invalidLimitValues).toEqual([
      { planSlug: "free", key: "storage_gb", value: "huge" },
    ]);
    // Capability that no plan defines should be reported as missing.
    expect(d.registryKeysMissingEverywhere.length).toBeGreaterThan(0);
  });
});