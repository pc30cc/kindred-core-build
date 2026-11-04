// @vitest-environment node
/**
 * Migration 295 in real PostgreSQL (PGlite): two members of a workspace
 * hidden from each other (server/services/teamVisibility.ts).
 *
 * Over a minimal workspace_members (its unique (workspace_id, user_id), which
 * the foreign keys name), 295's file as-is. Proven: one row per pair (the
 * order CHECK), both ends must be members of that workspace, a pair goes with
 * either membership, a second run changes nothing, and the file writes no
 * data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const M295 = readFileSync('database/migrations/295_workspace_member_hidden_pairs.sql', 'utf8');

const WS = randomUUID();
const OTHER_WS = randomUUID();
const [LOW, HIGH] = [randomUUID(), randomUUID()].sort();
const STRANGER = randomUUID();

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.workspace_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      user_id uuid NOT NULL,
      CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id)
    );
  `);
  await db.query('INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $5)',
    [WS, LOW, HIGH, OTHER_WS, STRANGER]);
  await db.exec(M295);
});

afterAll(async () => { await db.close(); });

const insert = (a: string, b: string, ws = WS) =>
  db.query('INSERT INTO public.workspace_member_hidden_pairs (workspace_id, user_a, user_b) VALUES ($1, $2, $3)', [ws, a, b]);

describe('migration 295 — workspace_member_hidden_pairs', () => {
  it('writes no data', async () => {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.workspace_member_hidden_pairs');
    expect(rows[0].n).toBe(0);
  });

  it('turns row level security on (server-only)', async () => {
    const { rows } = await db.query<{ on: boolean }>(
      `SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.workspace_member_hidden_pairs'::regclass`);
    expect(rows[0].on).toBe(true);
  });

  it('keeps one row per pair: user_a < user_b', async () => {
    await expect(insert(HIGH, LOW)).rejects.toThrow(/workspace_member_hidden_pairs_ordered/);
    await expect(insert(LOW, LOW)).rejects.toThrow(/workspace_member_hidden_pairs_ordered/);
    await insert(LOW, HIGH);
    await expect(insert(LOW, HIGH)).rejects.toThrow(/workspace_member_hidden_pairs_pkey/);
  });

  it('takes only two members of that workspace', async () => {
    const [a, b] = [LOW, STRANGER].sort();
    await expect(insert(a, b)).rejects.toThrow(/member_fkey/);
  });

  it('a second run changes nothing', async () => {
    await db.exec(M295);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.workspace_member_hidden_pairs');
    expect(rows[0].n).toBe(1);
  });

  it('a pair goes with either membership', async () => {
    await db.query('DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2', [WS, HIGH]);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.workspace_member_hidden_pairs');
    expect(rows[0].n).toBe(0);
  });
});
