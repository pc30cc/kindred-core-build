-- 294 — The call in the chat: every colleague call leaves one line in the two
-- members' team chat (owner, 2026-11-02: "when a call is made or ended, why
-- isn't it recorded in the chat? or a missed call"; docs/operations/
-- TEAM_CALLS.md, "The call in the chat").
--
-- 1. team_messages.call_session_id: the colleague call (a call_sessions row,
--    entry_source 'team_call') a line stands for; NULL for every message a
--    member wrote. ON DELETE SET NULL: a call row removed later leaves its
--    line as an ordinary message (its body, `📞`/`📹`, still reads).
-- 2. team_messages_call_session_id_key: UNIQUE (call_session_id), so a call
--    has at most one line (NULLs stay many). The server writes the line once,
--    when the call reaches its end (server/services/calls/teamCallChat.ts,
--    from teamCallLifecycle.ts announceTeamCall), with
--    ON CONFLICT (call_session_id) DO NOTHING: a second attempt does nothing.
--    The constraint's index also serves the foreign key's ON DELETE.
--
-- It writes no data and backfills nothing: calls before it leave no line.
-- The column has no default, so no row is rewritten. team_messages holds the
-- team chat only (a few rows per member), so the unique index is built in
-- place, not CONCURRENTLY, and the lock lasts a moment. The foreign key also
-- takes a SHARE ROW EXCLUSIVE lock on call_sessions for that moment (no row
-- to check: the column is new), so calls' writes wait at most as long; the
-- lock_timeout below bounds the wait, and a run that times out is run again
-- (each statement commits on its own, and both are re-runnable). The table
-- keeps its RLS, policies and grants; nothing is granted here.
--
-- Rollout: applied by hand on WebYar BEFORE the merge of the code that uses
-- it (CLAUDE.md, Migrations): a dry run of this file inside BEGIN … ROLLBACK
-- first; by its migrator on RESPOK, on push. The code also runs without it
-- (the line is then not written, which only logs, and the team-chat reads
-- fall back to the columns they had, every `call` null), so the order is
-- safe either way. Needs 016a (call_sessions) and 239 (team_messages).
-- Re-runnable: a second run finds the column and the constraint and changes
-- nothing. It opens no transaction of its own and touches no archive schema
-- or table. Like 284 to 293, it sets lock_timeout 5s itself.

SET lock_timeout = '5s';

-- ─── 1. The call a line stands for ───────────────────────────────────────
ALTER TABLE public.team_messages
  ADD COLUMN IF NOT EXISTS call_session_id uuid
    REFERENCES public.call_sessions(id) ON DELETE SET NULL;

-- ─── 2. One line per call ────────────────────────────────────────────────
DO $m294$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.team_messages'::regclass
       AND conname = 'team_messages_call_session_id_key'
  ) THEN
    ALTER TABLE public.team_messages
      ADD CONSTRAINT team_messages_call_session_id_key UNIQUE (call_session_id);
  END IF;
END
$m294$;

COMMENT ON COLUMN public.team_messages.call_session_id IS
  'The colleague call (call_sessions, entry_source team_call) this line stands for, written once by the server at the call''s end; NULL for every message a member wrote. Unique: one line per call.';
