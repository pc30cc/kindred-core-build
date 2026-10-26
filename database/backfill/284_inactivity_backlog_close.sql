-- 284 backlog — the one-time, silent close of the widget conversations that
-- were already quiet when the inactivity close shipped (owner, 2026-10-24:
-- closed once, by hand, after the owner has seen the list). Not a migration:
-- no runner applies it (it lives in database/backfill/, which
-- scripts/migrate-database.sh never reads). It is run with psql, as postgres,
-- on each database, AFTER migration 284 (which leaves the Super Admin's
-- switch off on a database with live conversations) and AFTER the owner's
-- go for the commit:
--   WebYar: webyar-postgres (container oqzy9q4ovntam9jgf7nxzqun), database webyar;
--   RESPOK: respok-postgres (container k6pnithcamskd4trrpo6jabv), after its
--           migrator (app 40) applied 284.
--
-- What it closes: every live (open, pending, resolved), non-spam widget
-- conversation whose conversation_idle_check() verdict is 'due', however long
-- it has been quiet (the timer's 30-day bound does not apply here), through
-- conversation_close_if_idle(id, updated_at, 'backlog'): status closed, the
-- close markers (closed_source 'inactivity_backlog') and the two thread-end
-- stamps, updated_at untouched, and ONE timeline event each. Silent: no
-- visitor line (the function refuses one), no realtime frame, no push, no
-- e-mail, no counter bumped. What the team still owes (needs_reply, a
-- handoff, routing, a call, a callback, a guidance request) is never closed:
-- it is listed, by reason, for the team to answer or resolve; the timer then
-- closes it N hours after that. The list has no message text and no contact
-- data. Run the dry run again at any time to list such rows.
--
-- The steps, per brand, on vps-50cc1602, each from that brand's own host
-- folder (the two CSVs never share one), set once in the shell:
--   WebYar: C=oqzy9q4ovntam9jgf7nxzqun D=webyar H=/root/webyar-migrate-284
--   RESPOK: C=k6pnithcamskd4trrpo6jabv H=/root/respok-migrate-284
--           D=<the database RESPOK's backend's DATABASE_URL names>
-- $H holds the repo's database/ folder (database/migrations/284 and this
-- file in database/backfill/; CLAUDE.md, Migrations), then the dumps and the
-- CSV. Only database/ (for the dry run) or this file and the reviewed CSV
-- (for the commit) go into the container, as /tmp/m284, and /tmp/m284 is
-- removed after each step, as CLAUDE.md's procedure removes it: the dumps
-- (visitor data) never enter the container.
--   0. A dump first, as before 275-283:
--        docker exec $C pg_dump -U postgres -Fc \
--          -t public.conversations -t public.conversation_events \
--          -t public.chat_routing_state -t public.widget_platform_settings $D \
--          > $H/pre-backlog.dump
--   1. The dry run (the default): the counts by verdict and by workspace,
--      one row per conversation, the due ids written to the CSV `out`, then
--      every due row closed inside the transaction, the checks below, and
--      ROLLBACK. Nothing is changed:
--        docker exec $C mkdir -p /tmp/m284
--        docker cp $H/database $C:/tmp/m284/
--        docker exec $C psql -X -U postgres -d $D \
--          -v ON_ERROR_STOP=1 -v out=/tmp/m284/backlog.csv \
--          -f /tmp/m284/database/backfill/284_inactivity_backlog_close.sql
--        docker cp $C:/tmp/m284/backlog.csv $H/backlog.csv
--        docker exec $C rm -rf /tmp/m284
--      The CSV is one conversation id per line; it stays on the server (the
--      owner's knowledge base gets the counts only). The `out` and `ids`
--      paths are read by psql as given: no spaces in them.
--   2. After the owner's go, the commit, with the CSV the owner reviewed for
--      that database, copied into the container with this file alone:
--        docker exec $C mkdir -p /tmp/m284/database/backfill
--        docker cp $H/database/backfill/284_inactivity_backlog_close.sql $C:/tmp/m284/database/backfill/
--        docker cp $H/backlog.csv $C:/tmp/m284/backlog.csv
--        docker exec $C psql -X -U postgres -d $D \
--          -v ON_ERROR_STOP=1 -v commit=1 -v ids=/tmp/m284/backlog.csv \
--          -f /tmp/m284/database/backfill/284_inactivity_backlog_close.sql
--        docker exec $C rm -rf /tmp/m284
--      It closes those ids only, each checked again (one that became owed or
--      active since is skipped and printed), makes the same checks, turns
--      widget_platform_settings.inactivity_close_enabled on in the same
--      transaction (unless -v enable=0), COMMITs, and prints the counts and
--      the time. Note them for the CLAUDE.md ledger. It stops before it
--      changes anything when the file is missing or empty, when an id is not
--      in this database (another brand's CSV, the wrong container, or a
--      conversation deleted since the dry run: dry-run again, owner reviews), or
--      when it would close nothing and still turn the switch on (every id
--      already closed or owed since: turn the switch on in the Super Admin's
--      widget settings instead).
-- Any failed check stops the file (ON_ERROR_STOP) and nothing is kept.
-- The transaction row-locks each conversation it closes until it ends: a
-- visitor message to one of them waits that long (a second or two).

\set ON_ERROR_STOP on
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?enable}
\else
  \set enable 1
\endif
\if :commit
  \if :{?ids}
  \else
    \echo '284 backlog: the commit closes the reviewed ids only: pass -v ids=<the backlog CSV>'
    DO $noids$ BEGIN RAISE EXCEPTION '284 backlog: no -v ids'; END $noids$;
  \endif
  -- psql does not stop on a failed backquote command, even with
  -- ON_ERROR_STOP: a file missing from the container (/tmp/m284 is removed
  -- after each step) would read as no id at all, and the commit would
  -- close nothing and still turn the switch on, leaving the backlog to the
  -- timer (a line and a card each) and to nobody past 30 days. So the file
  -- is checked first, and the checks below refuse a commit of no id.
  \set ids_ok `test -r :'ids' && test -s :'ids' && echo 1 || echo 0`
  \if :ids_ok
    -- One id per line (a comma or a space also separates them); read by psql.
    \set reviewed_ids `cat :'ids'`
  \else
    \echo '284 backlog:' :'ids' 'is missing or empty here (copy the reviewed CSV into the container first).'
    \echo 'When the dry run found nothing due, there is nothing to commit: turn the switch on in the Super Admin''s widget settings instead.'
    DO $noids$ BEGIN RAISE EXCEPTION '284 backlog: the reviewed ids file is missing or empty'; END $noids$;
  \endif
\else
  \set reviewed_ids ''
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
-- For the checks below (a dry run must close every due row; a commit that
-- turns the switch on must close something).
SELECT set_config('backlog_284.commit', :'commit', true) AS commit_mode,
       set_config('backlog_284.enable', :'enable', true) AS enable_mode \gset

DO $pre$
BEGIN
  IF to_regprocedure('public.conversation_close_if_idle(uuid, timestamptz, text, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '284 backlog: migration 284 is not applied on this database';
  END IF;
END $pre$;

-- Every live, non-spam widget conversation and its verdict now (the App
-- Review demo's seeded threads aside: conversation_idle_check never closes them).
CREATE TEMP TABLE backlog_284 ON COMMIT DROP AS
SELECT c.id,
       c.workspace_id,
       c.status::text AS status,
       c.updated_at,
       chk.verdict,
       chk.idle_hours,
       chk.last_exchange_at,
       floor(extract(epoch FROM now() - chk.last_exchange_at) / 3600)::integer AS quiet_hours,
       chk.closed_outcome
  FROM public.conversations c
  CROSS JOIN LATERAL public.conversation_idle_check(c.id) chk
 WHERE c.status IN ('open', 'pending', 'resolved')
   AND c.is_spam = false
   AND lower(btrim(coalesce(c.metadata->>'channel', ''))) IN ('', 'widget')
   AND coalesce(c.metadata->>'app_review_seed', '') <> 'true';

\echo '── Live widget conversations by verdict (due: closed by this run; the others the team owes or are recent)'
SELECT verdict, count(*) AS conversations, min(quiet_hours) AS quiet_h_min, max(quiet_hours) AS quiet_h_max
  FROM backlog_284
 GROUP BY verdict
 ORDER BY verdict = 'due' DESC, verdict;

\echo '── By workspace and verdict'
SELECT workspace_id, verdict, count(*) AS conversations
  FROM backlog_284
 GROUP BY workspace_id, verdict
 ORDER BY workspace_id, verdict = 'due' DESC, verdict;

\echo '── Each conversation (no message text, no contact data)'
SELECT workspace_id, id, status, verdict, quiet_hours, closed_outcome
  FROM backlog_284
 ORDER BY verdict = 'due' DESC, verdict, workspace_id, quiet_hours DESC NULLS LAST;

\if :commit
\else
  \if :{?out}
    -- The due ids, for the owner's review and then the commit.
    \pset format csv
    \pset tuples_only on
    \o :out
    SELECT id FROM backlog_284 WHERE verdict = 'due' ORDER BY workspace_id, id;
    \o
    \pset tuples_only off
    \pset format aligned
    \echo 'Due ids written to' :'out'
  \endif
\endif

-- What this run closes: the due rows (dry run), or the reviewed ids (commit),
-- each judged again by conversation_close_if_idle.
CREATE TEMP TABLE reviewed_284 (id uuid PRIMARY KEY) ON COMMIT DROP;
\if :commit
INSERT INTO reviewed_284 (id)
SELECT DISTINCT x::uuid
  FROM regexp_split_to_table(btrim(:'reviewed_ids'), '[\s,]+') AS x
 WHERE x <> '';
\else
INSERT INTO reviewed_284 (id) SELECT id FROM backlog_284 WHERE verdict = 'due';
\endif

CREATE TEMP TABLE before_284 ON COMMIT DROP AS
SELECT r.id,
       c.updated_at,
       (SELECT count(*) FROM public.conversation_messages m WHERE m.conversation_id = r.id) AS messages
  FROM reviewed_284 r
  LEFT JOIN public.conversations c ON c.id = r.id;

CREATE TEMP TABLE closed_284 ON COMMIT DROP AS
SELECT b.id AS conversation_id, b.updated_at AS expected_updated_at, r.*
  FROM before_284 b
  CROSS JOIN LATERAL public.conversation_close_if_idle(b.id, b.updated_at, 'backlog') r;

\echo '── The closes (closed), and what was skipped (became owed or active since, or is no longer live)'
SELECT outcome, from_status, closed_outcome, count(*) AS conversations
  FROM closed_284
 GROUP BY outcome, from_status, closed_outcome
 ORDER BY outcome <> 'closed', outcome, from_status, closed_outcome;

\echo '── Skipped ids'
SELECT conversation_id, outcome FROM closed_284 WHERE NOT closed ORDER BY outcome, conversation_id;

\echo '── Checks: every listed id closed or skipped by name, no visitor line, one timeline event each, updated_at unchanged'
SELECT (SELECT count(*) FROM reviewed_284) AS listed,
       (SELECT count(*) FROM closed_284 WHERE closed) AS closed,
       (SELECT count(*) FROM closed_284 WHERE NOT closed) AS skipped,
       (SELECT count(*) FROM closed_284 WHERE line_id IS NOT NULL) AS visitor_lines,
       (SELECT count(*) FROM public.conversation_events e JOIN closed_284 k ON k.event_id = e.id
         WHERE e.payload->>'source' = 'inactivity_backlog') AS timeline_events;

DO $check$
DECLARE
  v_due integer;
  v_closed integer;
  v_events integer;
  v_extra_events integer;
BEGIN
  SELECT count(*) INTO v_closed FROM closed_284 WHERE closed;
  IF current_setting('backlog_284.commit', true) = '1' THEN
    -- The commit: the reviewed list is not empty, and each id it names was
    -- judged (closed, or skipped by name).
    IF NOT EXISTS (SELECT 1 FROM reviewed_284) THEN
      RAISE EXCEPTION '284 backlog: the reviewed list names no conversation';
    END IF;
    IF (SELECT count(*) FROM closed_284) <> (SELECT count(*) FROM reviewed_284) THEN
      RAISE EXCEPTION '284 backlog: % listed, % judged', (SELECT count(*) FROM reviewed_284), (SELECT count(*) FROM closed_284);
    END IF;
    -- Every id is this database's: another brand's CSV, or a stale one,
    -- would close nothing here and still turn the switch on.
    IF EXISTS (SELECT 1 FROM closed_284 WHERE outcome = 'not_found') THEN
      RAISE EXCEPTION '284 backlog: % reviewed ids are not in this database (wrong database or CSV)',
        (SELECT count(*) FROM closed_284 WHERE outcome = 'not_found')
        USING HINT = 'Another brand''s CSV or the wrong container, or conversations deleted since the dry run: run the dry run again and have the owner review its list.';
    END IF;
    -- A commit that closes nothing (every id already closed, or owed since)
    -- does not turn the switch on: the Super Admin does, by choice.
    IF v_closed = 0 AND current_setting('backlog_284.enable', true)::boolean THEN
      RAISE EXCEPTION '284 backlog: the reviewed ids closed nothing, so the switch stays as it is'
        USING HINT = 'Turn the switch on in the Super Admin''s widget settings instead, or run the dry run again for a new list.';
    END IF;
  ELSE
    -- The dry run: every due row closes (nothing else holds them here).
    SELECT count(*) INTO v_due FROM backlog_284 WHERE verdict = 'due';
    IF v_closed <> v_due THEN
      RAISE EXCEPTION '284 backlog: % due, % closed', v_due, v_closed;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM closed_284 WHERE line_id IS NOT NULL) THEN
    RAISE EXCEPTION '284 backlog: a visitor line was written';
  END IF;
  IF EXISTS (
    SELECT 1 FROM closed_284 k JOIN before_284 b ON b.id = k.conversation_id
     WHERE k.closed
       AND (SELECT count(*) FROM public.conversation_messages m WHERE m.conversation_id = k.conversation_id) <> b.messages
  ) THEN
    RAISE EXCEPTION '284 backlog: a message was written into a closed conversation';
  END IF;
  SELECT count(*) INTO v_events
    FROM public.conversation_events e JOIN closed_284 k ON k.event_id = e.id AND k.closed
   WHERE e.conversation_id = k.conversation_id
     AND e.actor_type = 'system'
     AND e.payload->>'source' = 'inactivity_backlog'
     AND e.payload->>'to' = 'closed';
  SELECT count(*) INTO v_extra_events
    FROM public.conversation_events e JOIN closed_284 k ON k.conversation_id = e.conversation_id AND k.closed
   WHERE e.payload->>'source' = 'inactivity_backlog'
     AND e.id IS DISTINCT FROM k.event_id
     AND e.created_at = now();
  IF v_events <> v_closed OR v_extra_events <> 0 THEN
    RAISE EXCEPTION '284 backlog: % closes, % timeline events (% more)', v_closed, v_events, v_extra_events;
  END IF;
  IF EXISTS (
    SELECT 1 FROM closed_284 k JOIN public.conversations c ON c.id = k.conversation_id
     WHERE k.closed AND (c.status <> 'closed' OR c.updated_at IS DISTINCT FROM k.expected_updated_at)
  ) THEN
    RAISE EXCEPTION '284 backlog: a closed conversation is not closed, or its updated_at moved';
  END IF;
END $check$;

SELECT count(*) FILTER (WHERE closed) AS closed_count,
       count(*) FILTER (WHERE NOT closed) AS skipped_count,
       now() AS run_at
  FROM closed_284 \gset

\if :commit
  \if :enable
    -- The timer starts now, for every workspace (the Super Admin's switch).
    UPDATE public.widget_platform_settings SET inactivity_close_enabled = true;
  \endif
  COMMIT;
  \echo '── COMMITTED at' :'run_at' '— closed' :closed_count ', skipped' :skipped_count
  SELECT (SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1) AS inactivity_close_enabled;
\else
  ROLLBACK;
  \echo 'Dry run: rolled back, nothing changed. After the owner''s go: -v commit=1 -v ids=<the CSV>.'
\endif
