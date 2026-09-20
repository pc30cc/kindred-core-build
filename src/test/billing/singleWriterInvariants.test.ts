import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Single-writer invariants for entitlement counters.
 *
 * The canonical writers of `workspace_usage_counters` are DB triggers and
 * the Super Admin "usage adjust" route. Application code MUST NOT call
 * `.from('workspace_usage_counters').insert(...)/.update(...)/.upsert(...)`
 * from anywhere else — that would create a parallel counter producer and
 * silently break resolver-backed limits.
 *
 * This test scans `server/` and `worker/` for forbidden writes and fails
 * if a new one appears. Reads (`select`) are allowed.
 */

const ROOT = resolve(__dirname, "../../..");
const ALLOWED_WRITERS = new Set<string>([
  // Super Admin manual usage adjust — explicitly allowed.
  "server/routes/plans.ts",
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("workspace_usage_counters — single-writer invariant", () => {
  it("no application code writes to workspace_usage_counters outside the allowlist", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    const writeOps = /\.(insert|update|upsert|delete)\s*\(/;

    for (const dir of ["server", "worker"]) {
      const abs = resolve(ROOT, dir);
      try { statSync(abs); } catch { continue; }
      for (const file of walk(abs)) {
        const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
        if (ALLOWED_WRITERS.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        if (!src.includes("workspace_usage_counters")) continue;

        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("workspace_usage_counters")) continue;
          // Look at this line + next 2 for chained `.insert(`/`.update(`/`.upsert(`.
          const window = lines.slice(i, i + 3).join(" ");
          if (writeOps.test(window)) {
            offenders.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
      }
    }

    expect(
      offenders,
      `Forbidden workspace_usage_counters writes detected outside ALLOWED_WRITERS:\n` +
        offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join("\n"),
    ).toEqual([]);
  });
});

describe("conversation/visitor limit helpers — wiring invariants", () => {
  /**
   * Both helpers pass the key through a `const LIMIT_KEY = '…'` rather than
   * repeating the literal at each call — a refactor that makes the invariant
   * stronger, one place naming the key, and that a literal-only regex cannot
   * see through. So the constant is resolved first, and the call still has to
   * pass THAT name: a helper gating on some other key, or wiring only one
   * half of the pair, fails exactly as before.
   */
  function gatesOn(src: string, key: string) {
    const named = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${key}['"]`).exec(src);
    const arg = named ? `(?:['"]${key}['"]|${named[1]})` : `['"]${key}['"]`;
    return {
      requiresLimit: new RegExp(`requireLimit\\(\\s*${arg}`).test(src),
      resolvesUsage: new RegExp(`usageFnForLimit\\(\\s*${arg}`).test(src),
    };
  }

  it("conversationLimit helper uses the shared requireLimit + usageFnForLimit pair", () => {
    const src = readFileSync(
      resolve(ROOT, "server/services/billing/conversationLimit.ts"),
      "utf8",
    );
    const wiring = gatesOn(src, "max_conversations");
    expect(wiring.requiresLimit).toBe(true);
    expect(wiring.resolvesUsage).toBe(true);
    // …and not on somebody else's key.
    expect(gatesOn(src, "max_visitors").requiresLimit).toBe(false);
  });

  it("visitorLimit helper uses the shared requireLimit + usageFnForLimit pair", () => {
    const src = readFileSync(
      resolve(ROOT, "server/services/billing/visitorLimit.ts"),
      "utf8",
    );
    const wiring = gatesOn(src, "max_visitors");
    expect(wiring.requiresLimit).toBe(true);
    expect(wiring.resolvesUsage).toBe(true);
    expect(gatesOn(src, "max_conversations").requiresLimit).toBe(false);
    // Must NOT increment counters itself — single-writer is the DB trigger.
    expect(src).not.toMatch(/\.upsert\(|\.update\(|\.insert\(/);
  });

  it("storage upload routes attach the storage_gb limit gate", () => {
    const files = [
      "server/routes/storage.ts",
      "server/routes/conversationAttachments.ts",
      "server/routes/widgetAttachments.ts",
    ];
    for (const f of files) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      expect(src, `${f} missing storage_gb limit gate`).toMatch(
        /requireLimit\(\s*['"]storage_gb['"]/,
      );
    }
  });
});