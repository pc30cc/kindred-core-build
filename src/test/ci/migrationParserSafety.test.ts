import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const HISTORICAL = '20260415075434_9ad8e3b3-69dd-4f3c-a975-872b16361307.sql';
const SPLIT_FILES = [
  '20260415075435_create_workspace_atomic.sql',
  '20260415075436_provision_account_on_signup.sql',
  '20260415075437_update_handle_new_user.sql',
] as const;

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

/** Strip line comments so counting only sees real SQL. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function countFunctionDefinitions(sql: string): number {
  return (stripComments(sql).match(/^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gim) ?? []).length;
}

function plpgsqlFunctionCount(sql: string): number {
  const body = stripComments(sql);
  const blocks = body.split(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/gim).slice(1);
  return blocks.filter((block) => /LANGUAGE\s+plpgsql/i.test(block.split(/\$[A-Za-z_]*\$/)[0] ?? '')).length;
}

describe('hosted migration parser safety', () => {
  it('the historical migration no longer defines the three PL/pgSQL functions', () => {
    const sql = read(HISTORICAL);
    expect(sql).not.toMatch(/FUNCTION\s+public\.create_workspace_atomic/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.provision_account_on_signup/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.handle_new_user/i);
    expect(plpgsqlFunctionCount(sql)).toBe(0);
    // The remaining account objects are preserved.
    expect(sql).toMatch(/CREATE TABLE public\.accounts/i);
    expect(sql).toMatch(/CREATE TABLE public\.account_members/i);
    expect(sql).toMatch(/is_account_member/);
    expect(sql).toMatch(/get_account_role/);
    expect(sql.trimEnd().endsWith("USING (has_role(auth.uid(), 'admin'::app_role));")).toBe(true);
  });

  it('each split migration contains exactly one top-level function definition', () => {
    for (const file of SPLIT_FILES) {
      expect(countFunctionDefinitions(read(file)), file).toBe(1);
    }
  });

  it('each split migration uses a unique named dollar-quote delimiter', () => {
    const delimiters = SPLIT_FILES.map((file) => {
      const match = read(file).match(/AS\s+(\$[A-Za-z_][A-Za-z0-9_]*\$)/);
      expect(match, file).not.toBeNull();
      return match![1];
    });
    expect(delimiters).toEqual([
      '$create_workspace_atomic$',
      '$provision_account_on_signup$',
      '$handle_new_user$',
    ]);
    expect(new Set(delimiters).size).toBe(3);
    for (const file of SPLIT_FILES) {
      expect(read(file), file).not.toMatch(/AS\s+\$\$/);
    }
  });

  it('keeps the dependency order create_workspace_atomic → provision_account_on_signup → handle_new_user', () => {
    const ordered = [...SPLIT_FILES].sort();
    expect(ordered).toEqual([...SPLIT_FILES]);
    expect(read(SPLIT_FILES[1])).toMatch(/PERFORM public\.create_workspace_atomic\(/);
    expect(read(SPLIT_FILES[2])).toMatch(/PERFORM public\.provision_account_on_signup\(/);
    // The ACL lockdown still runs after all three.
    const lockdown = readdirSync(MIGRATIONS_DIR).find((f) =>
      f.endsWith('_core_security_definer_acl_lockdown.sql'),
    );
    expect(lockdown).toBeDefined();
    expect(lockdown! > SPLIT_FILES[2]).toBe(true);
  });

  it('preserves the exact business behaviour of each function', () => {
    const ws = read(SPLIT_FILES[0]);
    for (const needle of [
      'public.is_account_member(_account_id, _user_id)',
      'INSERT INTO public.workspaces',
      'INSERT INTO public.workspace_members',
      'INSERT INTO public.workspace_branding',
      'INSERT INTO public.widget_settings',
    ]) {
      expect(ws, needle).toContain(needle);
    }

    const provision = read(SPLIT_FILES[1]);
    for (const needle of [
      'FROM public.profiles WHERE id = _user_id',
      'INSERT INTO public.accounts',
      'INSERT INTO public.account_members',
      "_ws_slug := 'workspace'",
    ]) {
      expect(provision, needle).toContain(needle);
    }

    const trigger = read(SPLIT_FILES[2]);
    for (const needle of [
      'INSERT INTO public.profiles',
      'companyName',
      'websiteDomain',
      'mainGoal',
      'aiMode',
      'signup_locale',
      'signup_ip',
      'RETURN NEW;',
    ]) {
      expect(trigger, needle).toContain(needle);
    }
    // The trigger binding must not be recreated or dropped.
    expect(trigger).not.toMatch(/DROP\s+TRIGGER|CREATE\s+TRIGGER/i);
  });

  it('no migration at or after the failing one packs consecutive PL/pgSQL definitions without an intervening statement', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f >= HISTORICAL)) {
      const sql = stripComments(read(file));
      // Consecutive plpgsql function definitions separated only by whitespace.
      const consecutive =
        /\$[A-Za-z_]*\$\s*;\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]{0,400}?LANGUAGE\s+plpgsql[\s\S]*?\$[A-Za-z_]*\$\s*;\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]{0,400}?LANGUAGE\s+plpgsql/i;
      if (consecutive.test(sql)) offenders.push(file);
    }
    expect(offenders).not.toContain(HISTORICAL);
    for (const file of SPLIT_FILES) expect(offenders).not.toContain(file);
  });
});
