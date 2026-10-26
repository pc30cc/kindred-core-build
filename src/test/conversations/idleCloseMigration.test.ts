/**
 * Migration 284 (database/migrations/284_conversation_inactivity_close.sql),
 * read as text: the promises a reviewer checks by eye, pinned. Its behaviour
 * on a real database is src/test/integration/conversationIdleClose284.pg.test.ts.
 *
 *   - the CONCURRENTLY build the header gives for the hand-run is the index
 *     the file's own DO block builds (same columns, same predicate);
 *   - the bounds are shared/inactivityClose.ts's, and Core's gs_active bound
 *     (runtime.js activeNow, 48 h) is the longest window;
 *   - the live statuses are the server's (visitorConversations.ts,
 *     conversationLifecycle.ts);
 *   - the close writes exactly the close markers and the two thread-end
 *     stamps: never updated_at, never the AI's hold or routing's state; the
 *     race reopen removes every marker;
 *   - no SECURITY DEFINER; every function is in the ACL block (service_role
 *     only); lock_timeout is set at the top and reset at the end; nothing is
 *     dropped, deleted or truncated.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOSED_KEYS,
  INACTIVITY_CLOSE_DEFAULT_HOURS,
  INACTIVITY_CLOSE_MAX_HOURS,
  INACTIVITY_CLOSE_MAX_UNTOUCHED_DAYS,
  INACTIVITY_CLOSE_MIN_HOURS,
  INACTIVITY_CLOSE_RACE_GRACE_SECONDS,
} from '../../../shared/inactivityClose';
import { LIVE_CONVERSATION_STATUSES } from '../../../server/services/widget/visitorConversations';
import { INBOUND_REUSABLE_STATUSES, threadEndPatch } from '../../../server/services/conversationLifecycle';

const SQL = readFileSync('database/migrations/284_conversation_inactivity_close.sql', 'utf8');
/** The SQL without its comment lines. */
const CODE = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One function's body, between its dollar-quote tags. */
function body(tag: string): string {
  const start = CODE.indexOf(`AS $${tag}$`);
  const end = CODE.indexOf(`$${tag}$;`, start + 1);
  expect(start, tag).toBeGreaterThan(-1);
  expect(end, tag).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

/** The SQL without its string literals (a message naming DROP INDEX is no DROP). */
const STATEMENTS = CODE.replace(/'(?:[^']|'')*'/g, "''");

/** The top-level arguments of the first jsonb_build_object( … ) in `expr`. */
function objectArgs(expr: string): string[] {
  const start = expr.indexOf('jsonb_build_object(');
  expect(start).toBeGreaterThan(-1);
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr.slice(start + 'jsonb_build_object('.length)) {
    if (ch === '(') depth++;
    if (ch === ')' && depth-- === 0) break;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  args.push(current.trim());
  return args;
}

/** Its keys: every other argument, unquoted. */
function objectKeys(expr: string): string[] {
  return objectArgs(expr).filter((_, i) => i % 2 === 0).map((k) => k.replace(/^'|'$/g, ''));
}

describe('284: the index', () => {
  it('the header\'s CONCURRENTLY build is the DO block\'s, on the same live predicate', () => {
    const header = /--\s+CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_live_updated_idx\n--\s+(ON [^\n]+)\n--\s+(WHERE [^\n]+);/.exec(SQL);
    expect(header).not.toBeNull();
    const block = /CREATE INDEX conversations_live_updated_idx (ON [^\n]+)\n\s+(WHERE [^;]+);/.exec(CODE);
    expect(block).not.toBeNull();
    expect(norm(block![1])).toBe(norm(header![1]));
    expect(norm(block![2])).toBe(norm(header![2]));
    expect(norm(header![2])).toBe("WHERE status IN ('open', 'pending', 'resolved') AND is_spam = false");
    // An invalid index of that name stops the file.
    expect(CODE).toMatch(/indisvalid[\s\S]*RAISE EXCEPTION '284: conversations_live_updated_idx is invalid/);
  });
});

describe('284: the bounds and the statuses are the code\'s', () => {
  it('1–48, 24 by default, the 60 s grace (capped at 600), the 30-day bound; Core\'s gs_active bound is the longest window', () => {
    expect([INACTIVITY_CLOSE_MIN_HOURS, INACTIVITY_CLOSE_MAX_HOURS, INACTIVITY_CLOSE_DEFAULT_HOURS]).toEqual([1, 48, 24]);
    const between = `BETWEEN ${INACTIVITY_CLOSE_MIN_HOURS} AND ${INACTIVITY_CLOSE_MAX_HOURS}`;
    expect(CODE).toContain(`CHECK (inactivity_close_hours IS NULL OR inactivity_close_hours ${between})`);
    expect(CODE).toContain(`CHECK (inactivity_close_default_hours ${between})`);
    expect(CODE).toContain(`inactivity_close_default_hours integer NOT NULL DEFAULT ${INACTIVITY_CLOSE_DEFAULT_HOURS}`);
    // Every clamp in the functions.
    const clamps = [...CODE.matchAll(/least\((\d+), greatest\((\d+), coalesce\([^)]*, (\d+)\)\)\)/g)];
    expect(clamps.length).toBeGreaterThanOrEqual(2);
    for (const c of clamps) expect([Number(c[1]), Number(c[2]), Number(c[3])]).toEqual([48, 1, 24]);
    expect(body('fn_reopen_idle')).toContain(`coalesce(p_grace_seconds, ${INACTIVITY_CLOSE_RACE_GRACE_SECONDS}), 0), 600)`);
    expect(CODE).toContain(`p_grace_seconds integer DEFAULT ${INACTIVITY_CLOSE_RACE_GRACE_SECONDS}`);
    expect(body('fn_idle_due')).toContain(`c.updated_at >= now() - interval '${INACTIVITY_CLOSE_MAX_UNTOUCHED_DAYS} days'`);
    // runtime.js activeNow: a resolved conversation stays the visitor's current one 48 h.
    const runtime = readFileSync('public/widget/runtime.js', 'utf8');
    const bound = /< (\d+) \* 3600000\)/.exec(runtime.slice(runtime.indexOf('function activeNow') >= 0 ? runtime.indexOf('function activeNow') : 0));
    expect(bound, 'activeNow\'s bound').not.toBeNull();
    expect(Number(bound![1])).toBe(INACTIVITY_CLOSE_MAX_HOURS);
  });

  it('the live statuses are LIVE_CONVERSATION_STATUSES and INBOUND_REUSABLE_STATUSES', () => {
    expect([...LIVE_CONVERSATION_STATUSES]).toEqual([...INBOUND_REUSABLE_STATUSES]);
    // Every conversation-status list (the calls', callbacks' and queue
    // entries' own states aside).
    const lists = [...CODE.matchAll(/(?:status|'closed_from') (?:NOT )?IN \(([^)]*)\)/g)].map((m) => m[1].replace(/'/g, '').split(/,\s*/))
      .filter((l) => l.includes('open'));
    expect(lists.length).toBeGreaterThanOrEqual(5);
    for (const l of lists) expect(l).toEqual([...LIVE_CONVERSATION_STATUSES]);
  });
});

describe('284: what the close writes', () => {
  const close = body('fn_close_idle');
  const update = /UPDATE public\.conversations cv\s+SET ([\s\S]*?)\s+WHERE cv\.id = p_conversation_id;/.exec(close)?.[1] ?? '';

  it('one UPDATE of conversations: status and metadata, never updated_at', () => {
    expect(update).not.toBe('');
    expect(close.match(/UPDATE public\.conversations/g)).toHaveLength(1);
    expect(update).not.toMatch(/updated_at\s*=/);
    expect(close).not.toMatch(/UPDATE public\.chat_routing_state|chat_routing_skip|audit_log/);
  });

  it('exactly the close markers and the two thread-end stamps, none of the AI\'s hold or routing\'s keys', () => {
    expect([...objectKeys(update)].sort()).toEqual([...CLOSED_KEYS, 'routing_thread_ended_at', 'ai_thread_reset_at'].sort());
    // The metadata is the old one merged with that object, nothing else.
    expect(norm(update)).toMatch(/^status = 'closed', metadata = coalesce\(cv\.metadata, '\{\}'::jsonb\) \|\| jsonb_build_object\(/);
    expect(update.match(/jsonb_build_object\(/g)).toHaveLength(2);
    const stamps = Object.keys(threadEndPatch('x')).filter((k) => k === 'routing_thread_ended_at' || k === 'ai_thread_reset_at');
    expect(stamps.sort()).toEqual(['ai_thread_reset_at', 'routing_thread_ended_at']);
    const held = Object.keys(threadEndPatch('x')).filter((k) => !(stamps as string[]).includes(k));
    expect(held).toEqual(expect.arrayContaining(['ai_state', 'managed_by_ai', 'ai_managed_by_ai', 'ai_handoff_requested', 'human_takeover_at', 'routing_pending', 'routing_department_only']));
    for (const key of held) expect(update, key).not.toContain(`'${key}'`);
    // closed_prev_stamps keeps exactly the two stamps as they were.
    expect(norm(/'closed_prev_stamps', (jsonb_build_object\([^)]*\))/.exec(update)![1]))
      .toBe("jsonb_build_object( 'routing_thread_ended_at', v_meta->'routing_thread_ended_at', 'ai_thread_reset_at', v_meta->'ai_thread_reset_at')");
  });

  it('the line is forced to the system\'s (no internal, no name), and only the timer writes one', () => {
    expect(close).toContain("- 'internal')");
    expect(norm(close)).toContain("jsonb_build_object('kind', 'conversation_closed', 'by', 'system', 'closed_reason', 'inactivity', 'status', 'closed', 'agent_id', NULL, 'agent_name', NULL)");
    expect(close).toContain("IF p_source = 'timer' AND p_line_body IS NOT NULL THEN");
    expect(close).toContain("RAISE EXCEPTION 'conversation_close_if_idle: the backlog close writes no visitor line'");
  });

  it('the race reopen removes every marker and puts the two stamps back', () => {
    const reopen = body('fn_reopen_idle');
    const removed = [...reopen.matchAll(/- '([a-z_]+)'/g)].map((m) => m[1]);
    expect(removed.filter((k) => k.startsWith('closed_')).sort()).toEqual([...CLOSED_KEYS].sort());
    expect(removed).toEqual(expect.arrayContaining(['routing_thread_ended_at', 'ai_thread_reset_at']));
    expect(reopen).toContain("v_prev->'routing_thread_ended_at'");
    expect(reopen).toContain("v_prev->'ai_thread_reset_at'");
  });
});

describe('284: safe to apply by hand and by RESPOK\'s migrator', () => {
  const functions = [...CODE.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)\(([^)]*)\)/g)].map((m) => m[1]);

  it('no SECURITY DEFINER, every function SECURITY INVOKER with a pinned search_path, and in the ACL block', () => {
    expect(CODE).not.toMatch(/SECURITY DEFINER/i);
    expect(functions.sort()).toEqual([
      'public.conversation_close_if_idle', 'public.conversation_idle_check', 'public.conversation_idle_due',
      'public.conversation_inbox_counters', 'public.conversation_message_turn', 'public.conversation_reopen_after_idle_close',
    ]);
    expect(CODE.match(/SECURITY INVOKER\nSET search_path = public, pg_temp/g)).toHaveLength(functions.length);
    const acl = CODE.slice(CODE.indexOf('DO $acl$'), CODE.indexOf('END $acl$'));
    for (const f of functions) expect(acl, f).toContain(`'${f}(`);
    expect(acl).toContain("REVOKE ALL ON FUNCTION %s FROM PUBLIC");
    expect(acl).toContain("REVOKE ALL ON FUNCTION %s FROM anon");
    expect(acl).toContain("REVOKE ALL ON FUNCTION %s FROM authenticated");
    expect(acl).toContain("GRANT EXECUTE ON FUNCTION %s TO service_role");
  });

  it('lock_timeout set first and reset last; nothing dropped, deleted or truncated; the switch set off only where the column is added', () => {
    const statements = CODE.split('\n').filter((l) => l.trim());
    expect(statements[0]).toBe("SET lock_timeout = '5s';");
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;');
    expect(STATEMENTS).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(STATEMENTS).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(STATEMENTS).not.toMatch(/billing|ledger|archive/i);
    const updates = [...CODE.matchAll(/UPDATE public\.widget_platform_settings/g)];
    expect(updates).toHaveLength(1);
    const addColumn = CODE.indexOf('ADD COLUMN inactivity_close_enabled boolean NOT NULL DEFAULT true;');
    expect(addColumn).toBeGreaterThan(-1);
    expect(updates[0].index).toBeGreaterThan(addColumn);
    expect(CODE.slice(addColumn, updates[0].index)).not.toContain('END IF');
    // The checks: NOT VALID, then validated by a statement of their own.
    for (const c of ['widget_settings_inactivity_close_hours_check', 'widget_platform_settings_inactivity_close_default_hours_check', 'conversation_ratings_subject_check']) {
      expect(CODE, c).toMatch(new RegExp(`ADD CONSTRAINT ${c}\\s+CHECK [^;]+NOT VALID;`));
      expect(CODE, c).toContain(`VALIDATE CONSTRAINT ${c};`);
    }
  });

  it('the rating\'s subject: operator by default, operator or ai', () => {
    expect(CODE).toContain("ADD COLUMN IF NOT EXISTS subject text NOT NULL DEFAULT 'operator';");
    expect(CODE).toContain("CHECK (subject IN ('operator', 'ai')) NOT VALID");
  });
});
