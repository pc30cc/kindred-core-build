/**
 * Migration 285 (database/migrations/285_inactivity_close_app_review_workspace.sql),
 * read as text: its conversation_idle_check() is 284's, word for word, but
 * for the App Review condition, which now covers the whole workspace
 * (ws_appreview) and not only the seeded threads. Its behaviour on a real
 * database is src/test/integration/conversationIdleClose285.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL_284 = readFileSync('database/migrations/284_conversation_inactivity_close.sql', 'utf8');
const SQL_285 = readFileSync('database/migrations/285_inactivity_close_app_review_workspace.sql', 'utf8');
/** The SQL without its comment lines. */
const code = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const CODE_285 = code(SQL_285);

/** conversation_idle_check()'s definition, comments dropped. */
function idleCheck(sql: string): string {
  const c = code(sql);
  const start = c.indexOf('CREATE OR REPLACE FUNCTION public.conversation_idle_check(p_conversation_id uuid)');
  const end = c.indexOf('$fn_idle_check$;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return c.slice(start, end + '$fn_idle_check$;'.length);
}

describe('migration 285: the App Review workspace is never closed for quiet', () => {
  it('its conversation_idle_check() is 284\'s but for the App Review condition', () => {
    const seedOnly = "  IF c.metadata->>'app_review_seed' = 'true' THEN";
    const workspace = "  IF c.metadata->>'app_review_seed' = 'true'\n"
      + "     OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id AND w.slug = 'ws_appreview') THEN";
    const before = idleCheck(SQL_284);
    expect(before.split(seedOnly)).toHaveLength(2);
    expect(idleCheck(SQL_285)).toBe(before.replace(seedOnly, workspace));
  });

  it('the slug is the one migrations 248/249 give the demo workspace', () => {
    for (const file of ['248_app_review_account.sql', '249_app_review_seed_compact.sql']) {
      expect(readFileSync(`database/migrations/${file}`, 'utf8'), file).toContain('ws_appreview');
    }
  });

  it('only that function, service_role only; lock_timeout set first and reset last; nothing dropped, deleted or updated', () => {
    expect([...CODE_285.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)/g)].map((m) => m[1])).toEqual(['public.conversation_idle_check']);
    expect(CODE_285).not.toMatch(/SECURITY DEFINER/);
    expect(CODE_285).toContain('REVOKE ALL ON FUNCTION public.conversation_idle_check(uuid) FROM PUBLIC;');
    expect(CODE_285).toContain('GRANT EXECUTE ON FUNCTION public.conversation_idle_check(uuid) TO service_role;');
    expect(CODE_285).not.toMatch(/GRANT [^;]* TO (anon|authenticated|PUBLIC)\b/);
    const statements = CODE_285.split('\n').filter((l) => l.trim());
    expect(statements[0]).toBe("SET lock_timeout = '5s';");
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;');
    const outsideStrings = CODE_285.replace(/'(?:[^']|'')*'/g, "''");
    expect(outsideStrings).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(outsideStrings).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
  });
});
