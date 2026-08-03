/**
 * Phase 6-S5-R7.5 §10 — migration mirror parity.
 *
 * The self-host chain (database/migrations) and the hosted Supabase chain
 * (supabase/migrations) must stay functionally identical for the migrations
 * that exist in both. Only filenames and comments/whitespace may differ; any
 * functional SQL difference fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const MIRRORS: Array<{ label: string; selfHost: string; hosted: string }> = [
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