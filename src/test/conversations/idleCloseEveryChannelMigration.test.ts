/**
 * Migration 286 (database/migrations/286_inactivity_close_every_channel.sql),
 * read as text: each function is its predecessor's, word for word, but for
 * the changes the owner's decision needs (2026-10-26: the inactivity close on
 * every chat channel):
 *
 *   - conversation_message_turn() is 284's but for the media rule (an empty
 *     body with a non-empty metadata.attachments array has content);
 *   - conversation_idle_check() is 285's without the channel and
 *     platform-support test, and with the App Review verdict renamed
 *     'exempt' and widened to the support threads that account opens;
 *   - conversation_idle_due() is 284's without the widget-only filter.
 *
 * And the file is safe to run by hand and by RESPOK's migrator: lock_timeout
 * first and last, the 285 guard before anything, no data written, the three
 * functions service_role's only. Its behaviour on a real database is
 * src/test/integration/conversationIdleClose286.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOT_PROVIDER_IDS } from '../../../shared/channels/botProviders';

const SQL_284 = readFileSync('database/migrations/284_conversation_inactivity_close.sql', 'utf8');
const SQL_285 = readFileSync('database/migrations/285_inactivity_close_app_review_workspace.sql', 'utf8');
const SQL_286 = readFileSync('database/migrations/286_inactivity_close_every_channel.sql', 'utf8');
/** The SQL without its comment lines. */
const code = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const CODE_286 = code(SQL_286);
/** The SQL without its string literals (a message naming DROP is no DROP). */
const STATEMENTS_286 = CODE_286.replace(/'(?:[^']|'')*'/g, "''");

/** One function's definition (CREATE … through its closing dollar tag), comments dropped. */
function fn(sql: string, signature: string, tag: string): string {
  const c = code(sql);
  const start = c.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
  const end = c.indexOf(`$${tag}$;`, start);
  expect(start, signature).toBeGreaterThan(-1);
  expect(end, signature).toBeGreaterThan(start);
  return c.slice(start, end + `$${tag}$;`.length);
}

/** `text` with `from` (found exactly once) replaced by `to`. */
function once(text: string, from: string, to: string): string {
  expect(text.split(from), from).toHaveLength(2);
  return text.replace(from, () => to);
}

const TURN = 'conversation_message_turn(p_sender_type text, p_body text, p_metadata jsonb)';
const CHECK = 'conversation_idle_check(p_conversation_id uuid)';
const DUE = 'conversation_idle_due(p_limit integer DEFAULT 50)';

describe('migration 286: each function is its predecessor\'s but for the stated changes', () => {
  it('conversation_message_turn() is 284\'s but for the media rule', () => {
    const attachmentId = "         AND coalesce(p_metadata->'attachment_id', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '\"\"'::jsonb) THEN NULL\n";
    const withMedia = "         AND coalesce(p_metadata->'attachment_id', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '\"\"'::jsonb)\n"
      + "         AND NOT (jsonb_typeof(p_metadata->'attachments') IS NOT DISTINCT FROM 'array'\n"
      + "                  AND p_metadata->'attachments' <> '[]'::jsonb) THEN NULL\n";
    expect(fn(SQL_286, TURN, 'fn_turn')).toBe(once(fn(SQL_284, TURN, 'fn_turn'), attachmentId, withMedia));
  });

  it('conversation_idle_check() is 285\'s without the channel test, the App Review verdict \'exempt\' and its support threads', () => {
    const channelTest = "  IF lower(btrim(coalesce(c.metadata->>'channel', ''))) NOT IN ('', 'widget')\n"
      + "     OR EXISTS (SELECT 1 FROM public.platform_support_threads p WHERE p.conversation_id = c.id) THEN\n"
      + "    RETURN QUERY SELECT 'not_widget'::text, NULL::integer, NULL::timestamptz, NULL::timestamptz, NULL::text;\n"
      + '    RETURN;\n'
      + '  END IF;\n';
    const appReview285 = "  IF c.metadata->>'app_review_seed' = 'true'\n"
      + "     OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id AND w.slug = 'ws_appreview') THEN\n"
      + "    RETURN QUERY SELECT 'not_widget'::text,";
    const appReview286 = "  IF c.metadata->>'app_review_seed' = 'true'\n"
      + "     OR EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = c.workspace_id AND w.slug = 'ws_appreview')\n"
      + '     OR EXISTS (\n'
      + '       SELECT 1 FROM public.platform_support_threads p\n'
      + '        WHERE p.conversation_id = c.id\n'
      + "          AND (EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p.user_id AND lower(pr.email) = 'apple@webyar.ai')\n"
      + "               OR EXISTS (SELECT 1 FROM public.workspaces sw WHERE sw.id = p.source_workspace_id AND sw.slug = 'ws_appreview'))\n"
      + '     ) THEN\n'
      + "    RETURN QUERY SELECT 'exempt'::text,";
    const expected = once(once(fn(SQL_285, CHECK, 'fn_idle_check'), channelTest, ''), appReview285, appReview286);
    expect(fn(SQL_286, CHECK, 'fn_idle_check')).toBe(expected);
    // No channel is named in the decision any more, and no verdict 'not_widget' is produced.
    expect(fn(SQL_286, CHECK, 'fn_idle_check')).not.toMatch(/metadata->>'channel'/);
    expect(CODE_286).not.toContain("'not_widget'");
  });

  it('conversation_idle_due() is 284\'s without the widget-only channel filter (the seed filter, the bounds, the switch and the verdict stay)', () => {
    const widgetOnly = "     AND (c.metadata->>'channel' IS NULL OR c.metadata->>'channel' = 'widget')\n";
    const due = fn(SQL_286, DUE, 'fn_idle_due');
    expect(due).toBe(once(fn(SQL_284, DUE, 'fn_idle_due'), widgetOnly, ''));
    for (const kept of ["AND coalesce(c.metadata->>'app_review_seed', '') <> 'true'", "c.updated_at >= now() - interval '30 days'",
      "c.updated_at < now() - interval '1 hour'", 'IF NOT coalesce(v_enabled, false) THEN', "AND chk.verdict = 'due'"]) {
      expect(due, kept).toContain(kept);
    }
  });

  it('285\'s App Review conditions are all still there, and the slug and the account are migration 248\'s', () => {
    const check = fn(SQL_286, CHECK, 'fn_idle_check');
    expect(check).toContain("c.metadata->>'app_review_seed' = 'true'");
    expect(check).toContain("w.id = c.workspace_id AND w.slug = 'ws_appreview'");
    const seed = readFileSync('database/migrations/248_app_review_account.sql', 'utf8');
    expect(seed).toContain("c_email       constant text := 'apple@webyar.ai';");
    expect(seed).toContain("c_slug        constant text := 'ws_appreview';");
  });
});

describe('migration 286: safe to apply by hand and by RESPOK\'s migrator', () => {
  it('only the three functions, SECURITY INVOKER with a pinned search_path, service_role only', () => {
    const functions = [...CODE_286.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(/g)].map((m) => m[1]);
    expect(functions).toEqual(['public.conversation_message_turn', 'public.conversation_idle_check', 'public.conversation_idle_due']);
    expect(CODE_286).not.toMatch(/SECURITY DEFINER/i);
    expect(CODE_286.match(/SECURITY INVOKER\nSET search_path = public, pg_temp/g)).toHaveLength(3);
    const acl = CODE_286.slice(CODE_286.indexOf('DO $acl$'), CODE_286.indexOf('END $acl$'));
    for (const f of ['public.conversation_message_turn(text, text, jsonb)', 'public.conversation_idle_check(uuid)', 'public.conversation_idle_due(integer)']) {
      expect(acl, f).toContain(`'${f}'`);
    }
    for (const line of ['REVOKE ALL ON FUNCTION %s FROM PUBLIC', 'REVOKE ALL ON FUNCTION %s FROM anon',
      'REVOKE ALL ON FUNCTION %s FROM authenticated', 'GRANT EXECUTE ON FUNCTION %s TO service_role']) {
      expect(acl, line).toContain(line);
    }
    expect(CODE_286).not.toMatch(/GRANT [^;]* TO (anon|authenticated|PUBLIC)\b/);
  });

  it('lock_timeout set first and reset last; the 285 guard runs before anything is replaced', () => {
    const statements = CODE_286.split('\n').filter((l) => l.trim());
    expect(statements[0]).toBe("SET lock_timeout = '5s';");
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;');
    const guard = CODE_286.indexOf('DO $guard$');
    expect(guard).toBeGreaterThan(CODE_286.indexOf("SET lock_timeout = '5s';"));
    expect(guard).toBeLessThan(CODE_286.indexOf('CREATE OR REPLACE FUNCTION'));
    const block = CODE_286.slice(guard, CODE_286.indexOf('END $guard$'));
    expect(block).toContain("position('ws_appreview' in pg_get_functiondef(to_regprocedure('public.conversation_idle_check(uuid)')))");
    expect(block).toContain("RAISE EXCEPTION '286 needs 285");
  });

  it('writes no data: no table changed, nothing dropped, deleted, inserted or updated, no index built', () => {
    expect(STATEMENTS_286).not.toMatch(/\b(DROP|TRUNCATE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE)\b/i);
    expect(STATEMENTS_286).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
    expect(STATEMENTS_286).not.toMatch(/billing|ledger|archive/i);
  });

  it('the comments of the functions and the two settings speak of every chat channel', () => {
    const comments = [...CODE_286.matchAll(/COMMENT ON (FUNCTION|COLUMN) ([^\s(]+)[^]*?IS\n\s+'((?:[^']|'')*)';/g)].map((m) => ({ on: m[2], text: m[3] }));
    expect(comments.map((c) => c.on)).toEqual([
      'public.conversation_message_turn', 'public.conversation_idle_check', 'public.conversation_idle_due',
      'public.widget_settings.inactivity_close_hours', 'public.widget_platform_settings.inactivity_close_enabled',
    ]);
    for (const c of comments) expect(c.text, c.on).toMatch(/Migrations? [\d, ]*286\./);
    const names: Record<string, string> = { telegram: 'Telegram', bale: 'Bale', whatsapp: 'WhatsApp', instagram: 'Instagram', x: 'X' };
    for (const c of comments.filter((x) => x.on !== 'public.conversation_message_turn')) {
      expect(c.text, c.on).toMatch(/every chat channel|any chat channel/);
      expect(c.text, c.on).not.toMatch(/\bwidget conversations?\b/);
    }
    for (const c of comments.filter((x) => /idle_check|inactivity_close_hours|inactivity_close_enabled/.test(x.on))) {
      for (const provider of BOT_PROVIDER_IDS) expect(c.text, `${c.on}: ${provider}`).toContain(names[provider]);
      expect(c.text, c.on).toContain('platform support');
    }
  });
});
