/**
 * Phase 6-S5-R7.5 §10 — migration mirror parity.
 *
 * The self-host chain (database/migrations) and the hosted Supabase chain
 * (supabase/migrations) must stay functionally identical for the migrations
 * that exist in both. Only filenames and comments/whitespace may differ; any
 * functional SQL difference fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const MIRRORS: Array<{ label: string; selfHost: string; hosted: string }> = [
  {
    label: '008 — fan-out generation semantics',
    selfHost: 'database/migrations/008_entitlement_fanout_generations.sql',
    hosted: 'supabase/migrations/20260803060000_entitlement_fanout_generations.sql',
  },
  {
    label: '009 — fan-out cursor generation + AI-KB transactions',
    selfHost: 'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
    hosted: 'supabase/migrations/20260803070000_fanout_cursor_generation_and_ai_kb_tx.sql',
  },
  {
    label: '011 — AI-KB slug namespace lock',
    selfHost: 'database/migrations/011_ai_kb_slug_namespace_lock.sql',
    hosted: 'supabase/migrations/20260803090000_ai_kb_slug_namespace_lock.sql',
  },
  {
    label: '012 — AI-KB ACL re-assertion',
    selfHost: 'database/migrations/012_ai_kb_acl_reassert_guarded.sql',
    hosted: 'supabase/migrations/20260803120000_ai_kb_acl_reassert_guarded.sql',
  },
  {
    label: '010 — fan-out RPC security + KB state machine',
    selfHost: 'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
    hosted: 'supabase/migrations/20260803080000_fanout_rpc_security_and_kb_state_machine.sql',
  },
  {
    label: '013 — public schema CREATE lockdown',
    selfHost: 'database/migrations/013_public_schema_create_lockdown.sql',
    hosted: 'supabase/migrations/20260803130000_public_schema_create_lockdown.sql',
  },
  {
    label: '014 — core SECURITY DEFINER ACL lockdown',
    selfHost: 'database/migrations/014_core_security_definer_acl_lockdown.sql',
    hosted: 'supabase/migrations/20260803150000_core_security_definer_acl_lockdown.sql',
  },
];

/** Strips line comments, block comments and collapses whitespace. */
function functionalSql(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('migration mirror parity', () => {
  for (const { label, selfHost, hosted } of MIRRORS) {
    it(`${label} is functionally identical in both chains`, () => {
      expect(functionalSql(hosted)).toBe(functionalSql(selfHost));
    });
  }
});

/**
 * Chain completeness: every canonical self-host migration from 008 onward must
 * have its hosted mirror present. A gap (as with the missing 009 mirror) is a
 * hard failure even when the later mirrors are all there.
 */
const CANONICAL_ORDER = [
  'database/migrations/008_entitlement_fanout_generations.sql',
  'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
  'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
  'database/migrations/011_ai_kb_slug_namespace_lock.sql',
  'database/migrations/012_ai_kb_acl_reassert_guarded.sql',
  'database/migrations/013_public_schema_create_lockdown.sql',
  'database/migrations/014_core_security_definer_acl_lockdown.sql',
];

describe('hosted mirror chain completeness', () => {
  const bySelfHost = new Map(MIRRORS.map((m) => [m.selfHost, m.hosted]));

  it('declares a hosted mirror for every canonical migration 008 → 014', () => {
    const missing = CANONICAL_ORDER.filter((p) => !bySelfHost.has(p));
    expect(missing).toEqual([]);
  });

  it('every declared hosted mirror file exists on disk', () => {
    const absent = MIRRORS.filter((m) => !existsSync(m.hosted) || !existsSync(m.selfHost));
    expect(absent.map((m) => m.label)).toEqual([]);
  });

  it('hosted mirror timestamps sort in canonical migration order', () => {
    const stamps = CANONICAL_ORDER.map((p) => {
      const hosted = bySelfHost.get(p);
      return hosted ? hosted.split('/').pop()!.split('_')[0] : '';
    });
    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});