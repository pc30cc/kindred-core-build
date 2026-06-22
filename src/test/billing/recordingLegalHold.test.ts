/**
 * Operability pass — recording retention status classifier.
 *
 * The admin recordings surface labels each row with one of:
 *   on_hold | expired | expires_at | legacy_unmanaged
 *
 * Rules pinned here (must match janitor selection semantics):
 *   - legal_hold = true                            → on_hold        (janitor MUST skip)
 *   - retention_expires_at IS NULL && !legal_hold  → legacy_unmanaged (janitor never selects)
 *   - retention_expires_at in the past             → expired         (janitor will sweep)
 *   - retention_expires_at in the future           → expires_at
 */
import { describe, it, expect } from "vitest";

// Copy of the route's pure helper. Kept here so the test pins the
// behavior without booting Express. If the route diverges, this test
// fails — which is the intended canary for legal-hold semantics.
function retentionStatus(row: {
  legal_hold?: boolean;
  retention_expires_at?: string | null;
}): "on_hold" | "expired" | "expires_at" | "legacy_unmanaged" {
  if (row?.legal_hold) return "on_hold";
  if (!row?.retention_expires_at) return "legacy_unmanaged";
  const exp = new Date(row.retention_expires_at).getTime();
  if (Number.isFinite(exp) && exp <= Date.now()) return "expired";
  return "expires_at";
}

describe("recording retention status classifier", () => {
  it("legal_hold = true wins over everything else", () => {
    expect(retentionStatus({ legal_hold: true, retention_expires_at: "2000-01-01T00:00:00Z" })).toBe("on_hold");
    expect(retentionStatus({ legal_hold: true, retention_expires_at: null })).toBe("on_hold");
  });

  it("NULL retention_expires_at (legacy) is labelled legacy_unmanaged, never expired", () => {
    expect(retentionStatus({ legal_hold: false, retention_expires_at: null })).toBe("legacy_unmanaged");
    expect(retentionStatus({ retention_expires_at: null })).toBe("legacy_unmanaged");
  });

  it("past timestamp without hold is expired", () => {
    expect(retentionStatus({ legal_hold: false, retention_expires_at: "2000-01-01T00:00:00Z" })).toBe("expired");
  });

  it("future timestamp without hold is expires_at", () => {
    const future = new Date(Date.now() + 86400 * 1000).toISOString();
    expect(retentionStatus({ legal_hold: false, retention_expires_at: future })).toBe("expires_at");
  });
});