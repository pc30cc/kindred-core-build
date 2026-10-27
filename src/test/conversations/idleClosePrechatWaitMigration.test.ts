/**
 * Migration 287 (database/migrations/287_inactivity_close_prechat_wait_assigned.sql),
 * read as text: conversation_idle_check() is 286's, word for word, but for
 * the one condition the owner's fix needs (2026-10-27): a pre-chat wait
 * (metadata.routing_pending) counts as 'routing' only while nobody holds the
 * conversation. Any other drift from 286's function fails here.
 *
 * And the file is safe to run by hand and by RESPOK's migrator: lock_timeout
 * first and last, the 286 guard before anything, no transaction statement
 * of its own, no data written, the function service_role's only. Its
 * behaviour on a real database is
 * src/test/integration/conversationIdleClose287.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL_284 = readFileSync('database/migrations/284_conversation_inactivity_close.sql', 'utf8');
const SQL_285 = readFileSync('database/migrations/285_inactivity_close_app_review_workspace.sql', 'utf8');
const SQL_286 = readFileSync('database/migrations/286_inactivity_close_every_channel.sql', 'utf8');
const SQL_287 = readFileSync('database/migrations/287_inactivity_close_prechat_wait_assigned.sql', 'utf8');
/** The SQL without its comment lines. */
const code = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const CODE_287 = code(SQL_287);
/** The SQL without its string literals (a message naming DROP is no DROP). */
const STATEMENTS_287 = CODE_287.replace(/'(?:[^']|'')*'/g, "''");

const CHECK = 'conversation_idle_check(p_conversation_id uuid)';

/**
 * One function's definition (CREATE … through its closing dollar tag) as the
 * file has it: the comments inside its body are stored with it (pg_proc, and
 * pg_get_functiondef, which the guard reads), so they are kept.
 */
function rawFn(sql: string, signature: string, tag: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
  const end = sql.indexOf(`$${tag}$;`, start);
  expect(start, signature).toBeGreaterThan(-1);
  expect(end, signature).toBeGreaterThan(start);
  return sql.slice(start, end + `$${tag}$;`.length);
}
/** The same, comments dropped. */
const fn = (sql: string, signature: string, tag: string) => code(rawFn(sql, signature, tag));

/** `text` with `from` (found exactly once) replaced by `to`. */
function once(text: string, from: string, to: string): string {
  expect(text.split(from), from).toHaveLength(2);
  return text.replace(from, () => to);
}

const CLAUSE_286 = "  IF c.metadata->>'routing_pending' = 'true'\n";
const CLAUSE_287 = "  IF (c.metadata->>'routing_pending' = 'true' AND c.assigned_to IS NULL)\n";
/** 287's clause with the two comment lines it added above it, inside the body. */
const CLAUSE_287_RAW = '  -- A pre-chat wait counts only while nobody holds the conversation (287):\n'
  + '  -- once a person has it, routing has nothing left to do.\n'
  + CLAUSE_287;

describe('migration 287: conversation_idle_check() is 286\'s but for the pre-chat wait', () => {
  it('the function is 286\'s, word for word and comment for comment, with the routing_pending clause (and its comment) normalised', () => {
    expect(rawFn(SQL_287, CHECK, 'fn_idle_check')).toBe(once(rawFn(SQL_286, CHECK, 'fn_idle_check'), CLAUSE_286, CLAUSE_287_RAW));
    expect(fn(SQL_287, CHECK, 'fn_idle_check')).toBe(once(fn(SQL_286, CHECK, 'fn_idle_check'), CLAUSE_286, CLAUSE_287));
  });

  it('only the routing_pending clause changed: 286\'s other routing conditions are all still there, unassigned where they were', () => {
    const check = fn(SQL_287, CHECK, 'fn_idle_check');
    const routing = check.slice(check.indexOf(CLAUSE_287), check.indexOf("RETURN QUERY SELECT 'routing'::text"));
    expect(routing).toContain("(c.assigned_to IS NULL\n         AND jsonb_typeof(c.metadata->'queued_at') = 'string'\n         AND c.metadata->>'routing_outcome' = 'manual_queue')");
    expect(routing).toContain('(s.waiting_since IS NOT NULL OR s.prechat_deadline IS NOT NULL OR s.timeout_due_at IS NOT NULL)');
    // needs_reply is decided first, for a held conversation too.
    expect(check.indexOf("RETURN QUERY SELECT 'needs_reply'::text")).toBeLessThan(check.indexOf(CLAUSE_287));
    expect(check.match(/routing_pending/g)).toHaveLength(1);
  });

  it('the guard\'s marker tells 286 from 284 and 285: only 286\'s function names the verdict \'exempt\', comments included', () => {
    // The guard searches pg_get_functiondef(), which keeps the body's comments.
    expect(rawFn(SQL_286, CHECK, 'fn_idle_check')).toContain("'exempt'::text");
    expect(rawFn(SQL_287, CHECK, 'fn_idle_check')).toContain("'exempt'::text");
    for (const [label, sql] of [['284', SQL_284], ['285', SQL_285]]) {
      expect(rawFn(sql, CHECK, 'fn_idle_check'), label).not.toContain("'exempt'::text");
    }
  });
});

describe('migration 287: safe to apply by hand and by RESPOK\'s migrator', () => {
  it('only conversation_idle_check(), SECURITY INVOKER with a pinned search_path, service_role only', () => {
    const functions = [...CODE_287.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]);
    expect(functions).toEqual(['public.conversation_idle_check']);
    expect(CODE_287).not.toMatch(/SECURITY DEFINER/i);
    expect(CODE_287.match(/SECURITY INVOKER\nSET search_path = public, pg_temp/g)).toHaveLength(1);
    const f = 'public.conversation_idle_check(uuid)';
    expect(CODE_287).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC;`);
    const acl = CODE_287.slice(CODE_287.indexOf('DO $acl$'), CODE_287.indexOf('END $acl$'));
    for (const line of [`REVOKE ALL ON FUNCTION ${f} FROM anon;`, `REVOKE ALL ON FUNCTION ${f} FROM authenticated;`,
      `GRANT EXECUTE ON FUNCTION ${f} TO service_role;`]) {
      expect(acl, line).toContain(line);
    }
    expect(CODE_287).not.toMatch(/GRANT [^;]* TO (anon|authenticated|PUBLIC)\b/);
  });

  it('lock_timeout set first and reset last; the 286 guard runs before the function is replaced', () => {
    const statements = CODE_287.split('\n').filter((l) => l.trim());
    expect(statements[0]).toBe("SET lock_timeout = '5s';");
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;');
    const guard = CODE_287.indexOf('DO $guard$');
    expect(guard).toBeGreaterThan(CODE_287.indexOf("SET lock_timeout = '5s';"));
    expect(guard).toBeLessThan(CODE_287.indexOf('CREATE OR REPLACE FUNCTION'));
    const block = CODE_287.slice(guard, CODE_287.indexOf('END $guard$'));
    expect(block).toContain("to_regprocedure('public.conversation_idle_check(uuid)') IS NULL");
    expect(block).toContain("position('''exempt''::text' in pg_get_functiondef(to_regprocedure('public.conversation_idle_check(uuid)'))) = 0");
    expect(block).toContain("RAISE EXCEPTION '287 needs 286");
  });

  it('no transaction statement of its own (migrate-database.sh applies it; the dry run wraps it)', () => {
    expect(SQL_287.split('\n').filter((l) => /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(l))).toEqual([]);
  });

  it('writes no data: no table changed, nothing dropped, deleted, inserted or updated, no index built', () => {
    expect(STATEMENTS_287).not.toMatch(/\b(DROP|TRUNCATE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE)\b/i);
    expect(STATEMENTS_287).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
    expect(STATEMENTS_287).not.toMatch(/billing|ledger|archive/i);
  });

  it('the function\'s comment is 286\'s, naming the pre-chat wait and migration 287', () => {
    const comments = [...CODE_287.matchAll(/COMMENT ON (FUNCTION|COLUMN) ([^\s(]+)[^]*?IS\n\s+'((?:[^']|'')*)';/g)].map((m) => ({ on: m[2], text: m[3] }));
    expect(comments.map((c) => c.on)).toEqual(['public.conversation_idle_check']);
    const [comment] = comments;
    expect(comment.text).toMatch(/a pre-chat wait counts as routing only while nobody holds the conversation, migration 287/);
    expect(comment.text).toMatch(/Migrations 284, 285, 286, 287\.$/);
    const c286 = /COMMENT ON FUNCTION public\.conversation_idle_check\(uuid\) IS\n\s+'((?:[^']|'')*)';/.exec(code(SQL_286))![1];
    expect(comment.text.startsWith(c286.slice(0, c286.indexOf('(needs_reply')))).toBe(true);
  });

  it('the header says how it is applied: by hand on WebYar before the merge, by RESPOK\'s migrator on push, after a dry run on both', () => {
    // As prose: the comment markers dropped and the lines joined, so a rewrap changes nothing.
    const header = SQL_287.slice(0, SQL_287.indexOf("SET lock_timeout = '5s';"))
      .split('\n').map((l) => l.replace(/^--\s?/, '')).join(' ').replace(/\s+/g, ' ');
    expect(header).toMatch(/Applied by hand on WebYar BEFORE the merge/);
    expect(header).toMatch(/By its migrator on RESPOK, on push\./);
    expect(header).toMatch(/It closes nothing at once on WebYar: there \(2026-10-27\) the 2 flagged conversations read needs_reply/);
    expect(header).toMatch(/the same dry run \(inside BEGIN … ROLLBACK, [^)]*\) runs there too before the merge/);
    expect(header).not.toMatch(/nothing at once on production/);
  });
});
