/**
 * General, ongoing drift guard between the hosted (supabase/migrations) and
 * self-host (database/migrations) RLS chains — added alongside the VS-1 fix
 * (see visitorSessionRlsHardening.test.ts) so THAT class of bug (one chain
 * quietly staying more permissive than the other for a table both chains
 * define) cannot recur unnoticed for any other table.
 *
 * Scope, deliberately narrow: only tables BOTH chains actually define (the
 * self-host chain is a smaller bootstrap subset of the hosted schema, so
 * hosted-only tables are out of scope by construction — see database/README.md).
 * For each such table, for each (command, role) pair either chain grants a
 * policy on, this asserts both chains agree on whether that grant is
 * "wide-open" (a bare `USING (true)` / `WITH CHECK (true)`, no other
 * condition) or not. It does not compare exact policy text — different
 * wording for an equally-scoped condition is fine; only the true/false
 * "is anyone with this role unconditionally let in" bit needs to match.
 *
 * A newly-accepted, deliberate asymmetry is not a bug in this test — add it
 * to ALLOWLIST below with a one-line reason, the same way an eslint-disable
 * would be justified, rather than loosening the general check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

interface PolicyEvent {
  kind: 'CREATE' | 'DROP';
  table: string;
  name: string;
  command: string;
  roles: string;
  wideOpen: boolean;
  pos: number;
}

function qualify(t: string): string {
  const bare = t.replace(/"/g, '');
  return bare.includes('.') ? bare.split('.').pop()! : bare;
}

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** Balanced-paren extraction, same approach as the audit tooling. */
function extractParen(text: string, openIdx: number): { content: string; end: number } {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { content: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return { content: text.slice(openIdx + 1), end: text.length };
}

function parsePolicies(rawSql: string): PolicyEvent[] {
  const sql = stripComments(rawSql);
  const events: PolicyEvent[] = [];

  const dropRe = /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|(\S+))\s+ON\s+([A-Za-z0-9_."]+)/gi;
  for (const m of sql.matchAll(dropRe)) {
    const name = m[1] ?? m[2];
    events.push({ kind: 'DROP', table: qualify(m[3]), name, command: '', roles: '', wideOpen: false, pos: m.index! });
  }

  const createRe = /CREATE\s+POLICY/gi;
  for (const m of sql.matchAll(createRe)) {
    const start = m.index!;
    const end = sql.indexOf(';', start);
    const stmt = sql.slice(start, end === -1 ? undefined : end + 1);

    const nameM = stmt.match(/CREATE\s+POLICY\s+"?([^"\n(]+?)"?\s+ON\b/i);
    const name = nameM ? nameM[1].trim() : 'UNKNOWN';
    const tableM = stmt.match(/\bON\s+"?([A-Za-z0-9_.]+)"?/i);
    const table = tableM ? qualify(tableM[1]) : 'UNKNOWN';
    const cmdM = stmt.match(/\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
    const command = cmdM ? cmdM[1].toUpperCase() : 'ALL';
    const rolesM = stmt.match(/\bTO\s+([A-Za-z0-9_,"\s]+?)\s*(?:\bUSING\b|\bWITH\s+CHECK\b|$)/i);
    const roles = rolesM ? rolesM[1].replace(/["\s]/g, '').toLowerCase() : 'unknown';

    let usingBody: string | null = null;
    let checkBody: string | null = null;
    const usingIdx = stmt.search(/\bUSING\s*\(/i);
    if (usingIdx !== -1) {
      const openParen = stmt.indexOf('(', usingIdx);
      usingBody = extractParen(stmt, openParen).content.trim();
    }
    const checkIdx = stmt.search(/\bWITH\s+CHECK\s*\(/i);
    if (checkIdx !== -1) {
      const openParen = stmt.indexOf('(', checkIdx);
      checkBody = extractParen(stmt, openParen).content.trim();
    }
    const wideOpen = usingBody?.toLowerCase() === 'true' || checkBody?.toLowerCase() === 'true';

    events.push({ kind: 'CREATE', table, name, command, roles, wideOpen, pos: start });
  }

  return events.sort((a, b) => a.pos - b.pos);
}

function concatChain(dir: string): PolicyEvent[] {
  const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.sql')).sort();
  const all: PolicyEvent[] = [];
  let offset = 0;
  for (const f of files) {
    const text = readFileSync(join(ROOT, dir, f), 'utf8');
    for (const ev of parsePolicies(text)) all.push({ ...ev, pos: ev.pos + offset });
    offset += text.length + 1;
  }
  return all;
}

/** Final active policy set: last CREATE per (table,name) that isn't later DROPped. */
function resolveFinal(events: PolicyEvent[]): Map<string, PolicyEvent> {
  const latest = new Map<string, PolicyEvent>();
  for (const ev of events) {
    const key = `${ev.table}::${ev.name}`;
    latest.set(key, ev);
  }
  const active = new Map<string, PolicyEvent>();
  for (const [key, ev] of latest) {
    if (ev.kind === 'CREATE') active.set(key, ev);
  }
  return active;
}

/** For "anyone with role X unconditionally let in" purposes, only client-facing roles matter. */
const CLIENT_ROLES = ['anon', 'authenticated', 'public'];

function wideOpenGrants(active: Map<string, PolicyEvent>): Set<string> {
  const grants = new Set<string>();
  for (const ev of active.values()) {
    if (!ev.wideOpen) continue;
    const roles = ev.roles.split(',').filter((r) => CLIENT_ROLES.includes(r));
    for (const r of roles) grants.add(`${ev.table}::${ev.command}::${r}`);
  }
  return grants;
}

const hostedActive = resolveFinal(concatChain('supabase/migrations'));
const selfHostActive = resolveFinal(concatChain('database/migrations'));

const hostedTables = new Set([...hostedActive.values()].map((e) => e.table));
const selfHostTables = new Set([...selfHostActive.values()].map((e) => e.table));
const sharedTables = [...selfHostTables].filter((t) => hostedTables.has(t)).sort();

const hostedWideOpen = wideOpenGrants(hostedActive);
const selfHostWideOpen = wideOpenGrants(selfHostActive);

/**
 * Deliberate, reviewed asymmetries. Each entry is `table::COMMAND::role`.
 * Empty today — the VS-1 fix (022) brought self-host to parity with hosted
 * for every shared table. Add here only with an explicit reason in the
 * accompanying comment, never to silence an unreviewed failure.
 */
const ALLOWLIST = new Set<string>([]);

describe('migration chain — anon/authenticated/public wide-open policy parity', () => {
  it('found at least one shared table to compare (sanity check the extractor is working)', () => {
    expect(sharedTables.length).toBeGreaterThan(5);
  });

  it('self-host is never MORE permissive than hosted for any shared table (a wide-open grant in self-host must also be wide-open in hosted)', () => {
    const offenders = [...selfHostWideOpen]
      .filter((key) => sharedTables.some((t) => key.startsWith(`${t}::`)))
      .filter((key) => !hostedWideOpen.has(key))
      .filter((key) => !ALLOWLIST.has(key));
    expect(offenders).toEqual([]);
  });

  it('hosted is never MORE permissive than self-host for any shared table (a wide-open grant in hosted must also be wide-open in self-host)', () => {
    const offenders = [...hostedWideOpen]
      .filter((key) => sharedTables.some((t) => key.startsWith(`${t}::`)))
      .filter((key) => !selfHostWideOpen.has(key))
      .filter((key) => !ALLOWLIST.has(key));
    expect(offenders).toEqual([]);
  });
});
