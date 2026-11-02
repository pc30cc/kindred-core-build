// @vitest-environment node
/**
 * Migration 294 in real PostgreSQL (PGlite): the call in the chat
 * (docs/operations/TEAM_CALLS.md, "The call in the chat").
 *
 * team_messages is 239's table as-is (its CREATE TABLE and primary key) over
 * a minimal call_sessions, then 294's file as-is on top. Proven: the column
 * and its foreign key (ON DELETE SET NULL), one line per call (NULLs many),
 * the server's write (ON CONFLICT (call_session_id) DO NOTHING) inserting
 * once and then nothing, a second run changing nothing, a dry run leaving no
 * trace, and that the file writes no data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const M239 = readFileSync('database/migrations/239_selfhost_hosted_parity.sql', 'utf8');
const M294 = readFileSync('database/migrations/294_team_call_chat_records.sql', 'utf8');

/** The one statement of 239 that starts with `prefix`. */
function statement(prefix: string): string {
  const start = M239.indexOf(prefix);
  if (start < 0) throw new Error(`migration 239 has no "${prefix}"`);
  return M239.slice(start, M239.indexOf(';\n', start) + 1);
}

const WS = randomUUID();
const A = randomUUID();
const B = randomUUID();

let db: PGlite;

async function base(target: PGlite): Promise<void> {
  await target.exec(`
    CREATE TABLE public.call_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      entry_source text NOT NULL DEFAULT 'chat',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await target.exec(statement('CREATE TABLE IF NOT EXISTS public.team_messages ('));
  await target.exec('ALTER TABLE ONLY public.team_messages ADD CONSTRAINT team_messages_pkey PRIMARY KEY (id);');
}

async function call(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.call_sessions (workspace_id, entry_source) VALUES ($1, 'team_call') RETURNING id`, [WS]);
  return rows[0].id;
}

async function message(callId: string | null, body = 'hi'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.team_messages (workspace_id, sender_id, recipient_id, body, call_session_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [WS, A, B, body, callId]);
  return rows[0].id;
}

/** The server's write (teamCallChat.ts: upsert, onConflict call_session_id, ignoreDuplicates). */
async function writeLine(callId: string): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO public.team_messages (workspace_id, sender_id, recipient_id, body, read_at, created_at, call_session_id)
     VALUES ($1, $2, $3, '📞', NULL, now() - interval '1 minute', $4)
     ON CONFLICT (call_session_id) DO NOTHING RETURNING id`, [WS, A, B, callId]);
  return rows.length;
}

async function catalog(target: PGlite) {
  const { rows } = await target.query<{ conname: string; contype: string; def: string }>(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.team_messages'::regclass ORDER BY conname`);
  const { rows: cols } = await target.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'team_messages' AND column_name = 'call_session_id'`);
  return { constraints: rows, column: cols[0] ?? null };
}

beforeAll(async () => {
  db = new PGlite();
  await base(db);
  await db.query(`INSERT INTO public.team_messages (workspace_id, sender_id, recipient_id, body) VALUES ($1, $2, $3, 'before 294')`, [WS, A, B]);
  await db.exec(M294);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('294', () => {
  it('adds a nullable uuid column, with no default, referencing call_sessions ON DELETE SET NULL, unique', async () => {
    const { constraints, column } = await catalog(db);
    expect(column).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });
    expect(constraints).toEqual([
      { conname: 'team_messages_call_session_id_fkey', contype: 'f', def: 'FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE SET NULL' },
      { conname: 'team_messages_call_session_id_key', contype: 'u', def: 'UNIQUE (call_session_id)' },
      { conname: 'team_messages_pkey', contype: 'p', def: 'PRIMARY KEY (id)' },
    ]);
  });

  it('leaves the messages before it as they were (no call)', async () => {
    const { rows } = await db.query(`SELECT body, call_session_id FROM public.team_messages WHERE body = 'before 294'`);
    expect(rows).toEqual([{ body: 'before 294', call_session_id: null }]);
  });

  it('members\' messages stay many (NULL), a call has one line', async () => {
    await message(null);
    await message(null);
    const id = await call();
    await message(id, 'line');
    await expect(message(id, 'second line')).rejects.toThrow(/team_messages_call_session_id_key/);
  });

  it('the server\'s write inserts the line once, then nothing', async () => {
    const id = await call();
    expect(await writeLine(id)).toBe(1);
    expect(await writeLine(id)).toBe(0);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.team_messages WHERE call_session_id = $1`, [id]);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('a line names a real call only, and a call removed leaves its line as an ordinary message', async () => {
    await expect(message(randomUUID())).rejects.toThrow(/team_messages_call_session_id_fkey/);
    const id = await call();
    const line = await message(id, 'kept');
    await db.query('DELETE FROM public.call_sessions WHERE id = $1', [id]);
    const { rows } = await db.query(`SELECT body, call_session_id FROM public.team_messages WHERE id = $1`, [line]);
    expect(rows).toEqual([{ body: 'kept', call_session_id: null }]);
  });

  it('is safe to run twice', async () => {
    const before = await catalog(db);
    await db.exec(M294);
    expect(await catalog(db)).toEqual(before);
  });

  it('a dry run (BEGIN … ROLLBACK) leaves no trace', async () => {
    const fresh = new PGlite();
    try {
      await base(fresh);
      await fresh.exec(`BEGIN;\n${M294}\nROLLBACK;`);
      const { column, constraints } = await catalog(fresh);
      expect(column).toBeNull();
      expect(constraints.map((c) => c.conname)).toEqual(['team_messages_pkey']);
    } finally {
      await fresh.close();
    }
  });

  it('writes no data and opens no transaction of its own', () => {
    // Its foreign key's ON DELETE is not a write.
    const sql = M294.replace(/--[^\n]*/g, '').replace(/ON DELETE SET NULL/g, '');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
  });
});
