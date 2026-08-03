/**
 * CI hotfix — single canonical source for the internal RPC signatures used by
 * the TypeScript integration suites.
 *
 * The signatures are PARSED from `scripts/ci/internal-rpc-signatures.sql`, the
 * one source of truth the SQL verifiers already `\ir`. No suite may maintain
 * its own hand-typed list; a stale copy is exactly what broke CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RPC_INVENTORY_SQL = 'scripts/ci/internal-rpc-signatures.sql';

export interface InternalRpc {
  sig: string;
  proname: string;
  kind: string;
}

/** All nine internal RPCs, exactly as declared by the SQL inventory. */
export function internalRpcInventory(): InternalRpc[] {
  const sql = readFileSync(resolve(process.cwd(), RPC_INVENTORY_SQL), 'utf8');
  const values = sql.slice(sql.indexOf('INSERT INTO ci_internal_rpc'));
  const re = /'(public\.[a-z_]+\([^)]*\))',\s*'([a-z_]+)',\s*'([a-z_]+)'/g;
  return [...values.matchAll(re)].map((m) => ({ sig: m[1], proname: m[2], kind: m[3] }));
}

/** Signatures of a single inventory kind, e.g. `ai_kb` or `fanout`. */
export function internalRpcSignatures(kind?: string): string[] {
  return internalRpcInventory()
    .filter((r) => !kind || r.kind === kind)
    .map((r) => r.sig);
}