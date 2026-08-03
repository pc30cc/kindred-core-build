/**
 * Phase 6-S5-R7.2 — static invariants for the security closure.
 *
 * These guard the properties that are cheap to regress and expensive to
 * detect: a dropped-and-recreated SECURITY DEFINER function silently regains
 * PUBLIC execute, a route quietly downgrades a 503 to a 403, or the two
 * migration paths (self-host + Supabase) drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const M010 = 'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql';

describe('Migration 010 — SECURITY DEFINER lockdown', () => {
  const sql = read(M010);

  it('revokes PUBLIC execute on every fan-out and AI-KB RPC', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
    for (const fn of [
      'enqueue_entitlement_fanout',
      'claim_entitlement_fanout_jobs',
      'advance_entitlement_fanout',
      'complete_entitlement_fanout',
      'fail_entitlement_fanout',
      '_ai_kb_apply_generated',
      'accept_ai_kb_generated_article',
      'publish_ai_kb_generated_article',
      'reject_ai_kb_generated_article',
    ]) {
      expect(sql, fn).toContain(`'${fn}'`);
    }
  });

  it('re-grants only service_role, and only when the role exists', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION %s TO service_role/);
    expect(sql).toMatch(/SELECT 1 FROM pg_roles WHERE rolname = 'service_role'/);
    // Self-host installs have no anon/authenticated roles; the migration must
    // not abort there.
    expect(sql).toMatch(/rolname = 'anon'/);
    expect(sql).toMatch(/rolname = 'authenticated'/);
  });

  it('keeps the queue table internal-only', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.entitlement_fanout_jobs FROM PUBLIC/);
  });

  it('is forward-only: it never edits an already-shipped migration', () => {
    for (const earlier of ['007', '008', '009']) {
      const f = readdirSync(resolve(root, 'database/migrations'))
        .find((n) => n.startsWith(earlier));
      expect(f, earlier).toBeTruthy();
      expect(read(`database/migrations/${f}`)).not.toMatch(/Phase 6-S5-R7\.2/);
    }
  });
});

describe('Migration 010 — mutation state machine', () => {
  const sql = read(M010);

  it('locks the generated row before validating the transition', () => {
    const apply = sql.match(/CREATE FUNCTION public\._ai_kb_apply_generated[\s\S]*?\n\$\$;/)?.[0] ?? '';
    expect(apply).toMatch(/FOR UPDATE/);
    // The lock must be taken BEFORE any state decision.
    expect(apply.indexOf('FOR UPDATE')).toBeLessThan(apply.indexOf("'invalid_state'"));
  });

  it('reject is state-validated under the same row lock', () => {
    const rej = sql.match(/CREATE FUNCTION public\.reject_ai_kb_generated_article[\s\S]*?\n\$\$;/)?.[0] ?? '';
    expect(rej).toMatch(/FOR UPDATE/);
    expect(rej).toMatch(/NOT IN \('pending', 'rejected'\)/);
    expect(rej).toMatch(/invalid_state/);
  });

  it('refuses every illegal transition and reports the current status', () => {
    expect(sql).toMatch(/NOT IN \('pending', 'accepted'\)/);
    expect(sql).toMatch(/NOT IN \('pending', 'accepted', 'published'\)/);
    expect(sql).toMatch(/'current_status', g\.status/);
  });

  it('threads the server-computed slug seed into the transaction', () => {
    expect(sql).toMatch(/_slug_seed\s+text DEFAULT NULL/);
    expect(sql).toMatch(/NULLIF\(_slug_seed, ''\)/);
    // Slug allocation is serialized so two applies cannot pick the same slug.
    expect(sql).toMatch(/pg_advisory_xact_lock/);
  });
});

describe('Production migration parity', () => {
  it('the Supabase migration is byte-identical to the self-host one', () => {
    const mirror = readdirSync(resolve(root, 'supabase/migrations'))
      .find((n) => n.includes('fanout_rpc_security_and_kb_state_machine'));
    expect(mirror, 'missing Supabase mirror for migration 010').toBeTruthy();
    expect(read(`supabase/migrations/${mirror}`)).toBe(read(M010));
  });
});

describe('AI-KB routes — authoritative failure semantics', () => {
  const src = read('server/routes/aiKb.ts');

  it('maps a refused transition to 409, never to 500', () => {
    expect(src).toMatch(/status\(409\)/);
    expect(src).toMatch(/error: 'invalid_state'/);
    expect(src).toMatch(/current_status/);
  });

  it('passes the slug seed instead of mutating the in-memory row', () => {
    expect(src).toMatch(/_slug_seed: gen\.slug \|\| slugifyTitle\(gen\.title\)/);
    expect(src).not.toMatch(/if \(!gen\.slug\) gen\.slug = slugifyTitle/);
  });

  it('never renders an upgrade prompt for a non-authoritative denial', () => {
    const source = src.match(/aiKbRouter\.get\('\/source'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(source).toMatch(/denial\?\.status \?\? 403\) >= 500/);
    expect(source).toMatch(/retryable: true/);
  });

  it('diagnostics fail loudly instead of reporting a fabricated zero', () => {
    const diag = src.match(/aiKbRouter\.get\('\/worker\/diagnostics'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(diag).toMatch(/countError/);
    expect(diag).toMatch(/ai_kb_status_unavailable/);
    expect(diag).toMatch(/ai_platform_status_unavailable/);
  });

  it('bulk publish distinguishes a conflict from a failure', () => {
    const bulk = src.match(/publish-all'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(bulk).toMatch(/'invalid_state'/);
    expect(bulk).toMatch(/current_status/);
  });
});

describe('Entitlement lookups — outage is not a denial', () => {
  const src = read('server/services/ai-kb/access.ts');

  it('classifies rpc_error/exception as unavailable, not denied', () => {
    expect(src).toMatch(/INFRA_REASONS/);
    expect(src).toMatch(/'rpc_error', 'exception'/);
    expect(src).toMatch(/entitlement_status_unavailable/);
  });

  it('returns 503 for an unreadable module or feature entitlement', () => {
    expect(src).toMatch(/function unavailable\([\s\S]*?status: 503/);
    expect(src).toMatch(/if \(outcome === 'unavailable'\) return unavailable\('entitlement_status_unavailable'\)/);
    expect(src).toMatch(/if \(featureOutcome === 'unavailable'\) return unavailable\('entitlement_status_unavailable'\)/);
  });

  it('an unreadable permission is 503, not a permission denial', () => {
    expect(src).toMatch(/knowledge_base_permission_status_unavailable/);
    expect(read('server/services/knowledge-base/access.ts'))
      .toMatch(/checkKnowledgeBasePermissionDetailed/);
  });

  it('an admin cannot bypass a lookup that never ran', () => {
    // The `unavailable` return must precede the isAdmin bypass in both gates.
    const gate = src.match(/for \(const m of modules\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(gate.indexOf("outcome === 'unavailable'")).toBeGreaterThan(-1);
    expect(gate.indexOf("outcome === 'unavailable'")).toBeLessThan(gate.indexOf('opts.isAdmin'));
  });

  it('capabilities report unresolved entitlement state to the UI', () => {
    expect(src).toMatch(/entitlement_status_unavailable:\s*\n?\s*ai_assistant === 'unavailable'/);
    expect(read('src/lib/ai-kb-api.ts')).toMatch(/entitlement_status_unavailable: boolean/);
  });
});

describe('AI-KB client — no silent success', () => {
  const src = read('src/lib/ai-kb-api.ts');

  it('accept/reject/publish throw on a non-2xx response', () => {
    expect(src).toMatch(/class AiKbApiError/);
    for (const m of ['accept', 'reject', 'publish']) {
      const fn = src.match(new RegExp(`async ${m}\\(id: string\\)[\\s\\S]*?\\n  \\},`))?.[0] ?? '';
      expect(fn, m).toMatch(/parse</);
      expect(fn, m).not.toMatch(/return res\.json\(\);/);
    }
  });

  it('the review UI resyncs on a conflict instead of showing a raw code', () => {
    const ui = read('src/components/app/knowledge/AiKbBuilderTab.tsx');
    expect(ui).toMatch(/invalid_state/);
    expect(ui).toMatch(/retryable/);
  });
});
