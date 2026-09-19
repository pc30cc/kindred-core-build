/**
 * Saved replies have to exist in both database chains, and the route has to
 * say so when they do not.
 *
 * The table lived only in `supabase/migrations` — the hosted chain — for as
 * long as nothing but the web console asked for it. The iOS composer's
 * shortcuts button changed that: against a database built from
 * `database/migrations`, it reached a table that was not there, and what the
 * operator saw was a network error. "Something went wrong, try again" is the
 * wrong answer to "this deployment never installed the feature", because the
 * retry it invites can never succeed.
 *
 * Two things are guarded here. That the self-host chain carries the table,
 * with the same permissions the hosted one grants. And that every handler
 * recognises Postgres's `42P01` — undefined_table — and answers 501 rather
 * than 500, so a client can tell the difference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const SELF_HOST_DIR = 'database/migrations';
const ROUTE = 'server/routes/cannedResponses.ts';

/** Every self-host migration, concatenated — the table may move file later. */
function selfHostChain(): string {
  return readdirSync(SELF_HOST_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(`${SELF_HOST_DIR}/${f}`, 'utf8'))
    .join('\n');
}

describe('canned_responses exists in the self-host chain', () => {
  const chain = selfHostChain();

  it('creates the table', () => {
    // `\b` matters: without it this also matches `canned_responses_anything`,
    // so the guard passed against a chain that had renamed the table away.
    expect(chain).toMatch(/CREATE TABLE IF NOT EXISTS public\.canned_responses\b/);
  });

  it('references profiles, not auth.users', () => {
    // The self-host chain repointed identity to `public.profiles` in
    // migration 026. Laying down an `auth.users` constraint here only to
    // rewrite it would be a longer road to the same place.
    const table = chain.slice(chain.indexOf('CREATE TABLE IF NOT EXISTS public.canned_responses'));
    const createdBy = table.slice(table.indexOf('created_by'), table.indexOf('locale'));
    expect(createdBy).toMatch(/REFERENCES public\.profiles\(id\)/);
    expect(createdBy).not.toMatch(/auth\.users/);
  });

  it('grants the same four permissions the hosted chain grants', () => {
    for (const policy of [
      'Members can view canned responses',
      'Members can create own canned responses',
      'Author or admin can update canned responses',
      'Author or admin can delete canned responses',
    ]) {
      expect(chain).toContain(policy);
    }
  });

  it('lets any workspace member read, not only the author', () => {
    // The whole design in one line: saved replies belong to the workspace.
    // `created_by` decides who may edit one, never who may see it.
    // The CREATE, not the DROP IF EXISTS that precedes it — the file
    // re-asserts its policies so a re-run cannot leave a stale one behind.
    const create = chain.slice(
      chain.indexOf('CREATE POLICY "Members can view canned responses"'),
    );
    const using = create.slice(create.indexOf('USING'), create.indexOf(';'));
    expect(using).toMatch(/is_workspace_member\(workspace_id, auth\.uid\(\)\)/);
    expect(using).not.toMatch(/created_by/);
  });

  it('keeps one shortcut per language per workspace', () => {
    expect(chain).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS canned_responses_workspace_locale_shortcut_uniq[\s\S]*?\(workspace_id, locale, lower\(shortcut\)\)/,
    );
  });

  it('does not require pg_trgm, which a self-host role may not be able to create', () => {
    const chainText = chain;
    // The trigram indexes are allowed, but only behind a check for the
    // extension — never a bare CREATE EXTENSION that would fail the whole
    // migration on a locked-down database.
    const i = chainText.indexOf('canned_responses_title_trgm_idx');
    expect(i).toBeGreaterThan(-1);
    const before = chainText.slice(Math.max(0, i - 800), i);
    expect(before).toMatch(/pg_extension WHERE extname = 'pg_trgm'/);
  });
});

describe('the route tells "not installed" apart from "broken"', () => {
  const route = readFileSync(ROUTE, 'utf8');

  it('recognises Postgres undefined_table', () => {
    expect(route).toMatch(/error\?\.code === '42P01'/);
  });

  it('answers 501, not 500', () => {
    const fn = route.slice(route.indexOf('function respondNotInstalled'));
    expect(fn.slice(0, 300)).toMatch(/status\(501\)/);
    expect(fn.slice(0, 300)).toMatch(/FEATURE_NOT_INSTALLED/);
  });

  it('checks it everywhere the table is touched', () => {
    // Five handlers and three pre-write lookups. A handler that skips the
    // check reports a missing table as a 500, or — worse, for the lookups —
    // as "Canned response not found", which sends whoever sees it looking
    // for a deleted row that never existed.
    const touches = route.match(/from\('canned_responses'\)/g) ?? [];
    const guards = route.match(/isMissingTable\(/g) ?? [];
    expect(touches.length).toBeGreaterThanOrEqual(8);
    // One definition plus one guard per touch.
    expect(guards.length).toBeGreaterThanOrEqual(touches.length + 1);
  });

  it('the iOS client has a name for it', () => {
    const api = readFileSync('ios/WebyarNative/Sources/Core/Networking/APIClient.swift', 'utf8');
    expect(api).toMatch(/var isFeatureMissing: Bool/);
    expect(api).toMatch(/status == 501/);

    // And the picker uses it, rather than showing an offline banner with a
    // Try again button that cannot ever work.
    const picker = readFileSync(
      'ios/WebyarNative/Sources/Features/Chat/CannedResponsePicker.swift',
      'utf8',
    );
    expect(picker).toMatch(/case \.failed\(let error\) where error\.isFeatureMissing/);
  });
});
