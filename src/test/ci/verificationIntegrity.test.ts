/**
 * Phase 6-S5-R7.5.1 §1/§3 — verification-integrity self-tests.
 *
 * These prove that the CI database proofs audit the REAL RPC surface (exact
 * signatures, derived from the migrations themselves), that no verifier can
 * silently skip a check, and that the lint gates fail closed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { baseResolution, parseNameStatus, isLintable } from '../../../scripts/lint-changed-core.mjs';

const CI_DIR = 'scripts/ci';
const INVENTORY = `${CI_DIR}/internal-rpc-signatures.sql`;
const VERIFIERS = [
  `${CI_DIR}/verify-migration-security.sql`,
  `${CI_DIR}/verify-hosted-chain.sql`,
  `${CI_DIR}/verify-selfhost-chain.sql`,
];

const read = (p: string) => readFileSync(p, 'utf8');

/** Signatures declared by the single source of truth. */
function inventorySignatures(): string[] {
  return [...read(INVENTORY).matchAll(/'(public\.[a-z_]+\([^)]*\))'/g)].map((m) => m[1]);
}

/**
 * Derives the effective signature of every audited function from the SQL
 * migrations, honouring later re-definitions in chain order.
 */
function migrationSignatures(): Map<string, string> {
  const files = readdirSync('database/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const sigs = new Map<string, string>();
  for (const file of files) {
    const sql = read(`database/migrations/${file}`);
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z_]+)\s*\(([\s\S]*?)\)\s*RETURNS/gi;
    for (const m of sql.matchAll(re)) {
      const name = m[1];
      const params = m[2].trim();
      const types = params
        ? params
            .split(',')
            .map((p) => p.replace(/DEFAULT[\s\S]*$/i, '').trim())
            .map((p) => p.split(/\s+/).slice(1).join(' ').trim())
            .filter(Boolean)
        : [];
      sigs.set(name, `public.${name}(${types.join(', ')})`);
    }
  }
  return sigs;
}

describe('internal RPC inventory — exactness', () => {
  const declared = inventorySignatures();
  const fromMigrations = migrationSignatures();

  it('declares exactly the nine internal RPCs', () => {
    expect(declared).toHaveLength(9);
    expect(new Set(declared).size).toBe(9);
  });

  it.each(inventorySignatures())('%s matches the signature the migrations create', (sig) => {
    const name = sig.slice('public.'.length, sig.indexOf('('));
    expect(fromMigrations.get(name)).toBe(sig);
  });

  it('contains no stale pre-009 fan-out overloads', () => {
    const sql = read(INVENTORY);
    expect(sql).not.toContain('enqueue_entitlement_fanout(uuid, text, jsonb)');
    expect(sql).not.toContain('claim_entitlement_fanout_jobs(integer, integer, text)');
    expect(sql).not.toContain('complete_entitlement_fanout(uuid, text)');
  });

  it('asserts presence and rejects overloads instead of skipping', () => {
    const sql = read(INVENTORY);
    expect(sql).toContain('to_regprocedure(sig) IS NULL');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('unexpected overload');
    expect(sql).not.toContain('CONTINUE WHEN');
  });
});

describe('CI verifiers — non-skippable', () => {
  it.each(VERIFIERS)('%s sources the single signature inventory', (file) => {
    expect(read(file)).toContain('\\ir internal-rpc-signatures.sql');
  });

  it.each(VERIFIERS)('%s hardcodes no RPC signature list of its own', (file) => {
    const sql = read(file);
    expect(sql).not.toMatch(/'public\.(accept|publish|reject|_ai_kb|enqueue|claim|advance|complete|fail)[a-z_]*\(/);
  });

  it.each(VERIFIERS)('%s never skips a check silently', (file) => {
    expect(read(file)).not.toContain('CONTINUE WHEN');
  });

  it('the security verifier proves denial live for both customer roles', () => {
    const sql = read(VERIFIERS[0]);
    expect(sql).toContain("ARRAY['anon', 'authenticated']");
    expect(sql).toContain('SET LOCAL ROLE');
    expect(sql).toContain('live denial proof incomplete');
    // The live proof must be transactional and rolled back.
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('ROLLBACK;');
    expect(sql).not.toContain('live denial check skipped');
  });

  it('the security verifier fails when the audited roles are absent', () => {
    expect(read(VERIFIERS[0])).toContain('ACL verification would be vacuous');
  });

  it('the security verifier accepts only the literals 0 or 1 for require_ai_kb', () => {
    const sql = read(VERIFIERS[0]);
    expect(sql).toContain("NOT IN ('0', '1')");
    expect(sql).toContain('require_ai_kb must be exactly 0 or 1');
    // The flag must be validated once, up front, as a session GUC — not
    // re-read transaction-locally where an invalid value could slip past.
    expect(sql).toContain("set_config('ci.require_ai_kb', :'require_ai_kb', false)");
    expect(sql).not.toContain("set_config('ci.require_ai_kb', :'require_ai_kb', true)");
  });

  it('the AI-KB proof asserts the exact not_found discriminator', () => {
    const sql = read(VERIFIERS[0]);
    const occurrences = sql.match(/res->>'error' IS DISTINCT FROM 'not_found'/g) ?? [];
    // accept + publish (loop), reject, _ai_kb_apply_generated
    expect(occurrences).toHaveLength(3);
    expect(sql).not.toMatch(/expected ok=false'/);
  });

  it('the queue check audits the complete privilege matrix including PUBLIC', () => {
    const sql = read(VERIFIERS[0]);
    expect(sql).toContain("ARRAY['public', 'anon', 'authenticated']");
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect(sql).toContain(priv);
    }
    expect(sql).toContain('service_role lacks % on entitlement_fanout_jobs');
  });

  it('the fan-out lifecycle proof asserts exact row state, not just status', () => {
    const sql = read(VERIFIERS[0]);
    for (const field of [
      'j.completed_generation IS DISTINCT FROM c.processing_generation',
      'j.claim_token IS DISTINCT FROM NULL',
      'j.worker_id IS DISTINCT FROM NULL',
      'j.processed_count IS DISTINCT FROM 2',
      "j.last_error_code IS DISTINCT FROM 'ci_proof'",
    ]) {
      expect(sql).toContain(field);
    }
  });
});

describe('self-host CI — official Auth image', () => {
  const workflow = read('.github/workflows/ci.yml');

  it('pins the Auth image by immutable digest', () => {
    expect(workflow).toMatch(
      /supabase\/auth:v2\.194\.0@sha256:2b352c02adf11a2025cd5993c246ef85db73743553c39194d2b1862d1cc4d1fd/,
    );
    // No unpinned reference may survive next to the pinned one.
    expect(workflow).not.toMatch(/supabase\/auth:v2\.194\.0(?!@sha256)/);
  });

  it('preflights that the image is pullable and exposes `migrate`', () => {
    expect(workflow).toContain('docker image inspect');
    expect(workflow).toContain('auth --help');
    expect(workflow).toContain("grep -q 'migrate'");
  });

  it('passes require_ai_kb explicitly on both chains', () => {
    expect(workflow).toContain('-v require_ai_kb=1');
    expect(workflow).toContain('-v require_ai_kb=0');
  });
});

describe('lint gates — fail closed', () => {
  it('the baseline runner refuses to create a missing baseline in enforce mode', () => {
    const src = read('scripts/lint-baseline.mjs');
    expect(src).toContain('is missing. The gate refuses to create it in enforce mode');
    expect(src).toContain('results.length === 0');
  });

  it('fails in CI when no base revision can be resolved', () => {
    const r = baseResolution('', { CI: 'true' });
    expect(r.action).toBe('fail');
    expect(r.message).toContain('fails closed');
  });

  it('stays advisory locally when no base revision exists', () => {
    expect(baseResolution('', {}).action).toBe('skip');
  });

  it('runs when a base revision is available', () => {
    expect(baseResolution('abc123', { CI: 'true' }).action).toBe('run');
  });

  it('lints the new path of a rename and ignores non-lintable files', () => {
    const raw = ['R100\told.ts\tnew.ts', 'M\tsrc/a.tsx', 'A\tdocs/readme.md'].join('\n');
    expect(parseNameStatus(raw)).toEqual(['new.ts', 'src/a.tsx']);
    expect(isLintable('docs/readme.md')).toBe(false);
  });
});