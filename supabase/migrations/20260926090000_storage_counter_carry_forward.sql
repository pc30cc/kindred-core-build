-- Hosted mirror of database/migrations/220_storage_counter_carry_forward.sql.
-- 220: workspace storage occupancy survives month rollover, whoever creates
-- the month's counter row — and the occupancy already lost is restored.
--
-- storage_bytes is CUMULATIVE occupancy (docs/STORAGE_COUNTER_ARCHITECTURE.md):
-- a stored byte counts until the file is deleted, and each new
-- workspace_usage_counters row (one per workspace per month) must start from
-- the previous month's value. apply_storage_usage_log() did that seeding, but
-- only when ITS OWN insert created the month's row. Every other counter —
-- messages, conversations, visitors, AI requests, call minutes — writes the
-- same row and usually gets there first, with storage_bytes at its default 0.
-- From then on the month counted only its own uploads, the next month seeded
-- from that, and the loss was permanent: an active workspace's storage usage
-- fell back to roughly one month's uploads every month, so the storage_gb
-- limit (enforced on chat attachments and channel media) was under-enforced.
--
-- 1. A BEFORE INSERT trigger on workspace_usage_counters seeds storage_bytes
--    from the latest earlier period on EVERY new row, whichever writer
--    creates it. On an INSERT that turns into ON CONFLICT the seeded value is
--    simply discarded: no writer's DO UPDATE reads EXCLUDED.storage_bytes.
-- 2. apply_storage_usage_log() inserts only its delta and lets the trigger add
--    the seed: the same GREATEST(seed + delta, 0) as before for a row it
--    creates, without seeding twice. Replaced only where it exists — a
--    database without the hosted storage producer never wrote storage_bytes.
-- 3. Lost occupancy is restored. Nothing counted storage before the producer
--    was installed, so a workspace's FIRST month with storage_bytes > 0 is
--    correct as stored (every earlier row was 0, so there was no seed to
--    lose). From the next month on, the producer applied exactly the sized,
--    successful upload/delete rows of storage_usage_logs, one by one. So the
--    true occupancy is that first month's value plus the net of those rows
--    since — which is what the producer would hold today had no seed been
--    lost. Where that exceeds the newest row, the difference is added.
--    Idempotent: once restored, the same computation finds nothing to add, so
--    a second application (the hosted chain runs the same migration) is a
--    no-op. It only ever adds bytes the producer itself counted.
--
-- Atomic: the trigger and the producer change must land together, or a row
-- created in between would be seeded twice.

BEGIN;

-- CREATE TRIGGER briefly blocks writes to the counters table, which every
-- message and visitor touches. Fail fast rather than queue writers behind a
-- long-running transaction; the migration can simply run again.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.workspace_usage_counters_seed_storage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prior bigint;
BEGIN
  SELECT c.storage_bytes
    INTO v_prior
    FROM public.workspace_usage_counters c
   WHERE c.workspace_id = NEW.workspace_id
     AND c.period < NEW.period
   ORDER BY c.period DESC
   LIMIT 1;

  NEW.storage_bytes := GREATEST(COALESCE(v_prior, 0) + COALESCE(NEW.storage_bytes, 0), 0);
  RETURN NEW;
END;
$$;

-- A trigger fires as the table's owner; nobody needs to call this directly.
REVOKE ALL ON FUNCTION public.workspace_usage_counters_seed_storage() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.workspace_usage_counters_seed_storage() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.workspace_usage_counters_seed_storage() FROM authenticated';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_usage_counters_seed_storage ON public.workspace_usage_counters;
CREATE TRIGGER trg_workspace_usage_counters_seed_storage
  BEFORE INSERT ON public.workspace_usage_counters
  FOR EACH ROW EXECUTE FUNCTION public.workspace_usage_counters_seed_storage();

DO $migration$
BEGIN
  IF to_regprocedure('public.apply_storage_usage_log()') IS NULL
     OR to_regclass('public.storage_usage_logs') IS NULL THEN
    RETURN; -- no storage producer here: storage_bytes was never written
  END IF;

  -- The producer: same checks, same upsert, minus its own (now duplicate)
  -- seed. CREATE OR REPLACE keeps its existing grants.
  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.apply_storage_usage_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_delta  bigint := 0;
BEGIN
  -- Ignore failed ops, non-upload/delete ops, and rows missing file_size.
  IF NEW.success IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  IF NEW.file_size IS NULL OR NEW.file_size <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.operation = 'upload' THEN
    v_delta := NEW.file_size;
  ELSIF NEW.operation = 'delete' THEN
    v_delta := -NEW.file_size;
  ELSE
    RETURN NEW;
  END IF;

  -- A new month's row is seeded with the prior period's occupancy by
  -- trg_workspace_usage_counters_seed_storage (migration 220), whichever
  -- writer creates it, so only the delta is inserted here.
  INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
  VALUES (NEW.workspace_id, v_period, v_delta)
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET storage_bytes = GREATEST(public.workspace_usage_counters.storage_bytes + v_delta, 0),
        updated_at = now();

  RETURN NEW;
END;
$body$;
$fn$;

  -- Restore lost occupancy (see 3. above). The newest row gets the missing
  -- difference ADDED, so an upload committed while this runs is kept.
  WITH first_month AS (
    SELECT DISTINCT ON (c.workspace_id) c.workspace_id, c.period, c.storage_bytes
      FROM public.workspace_usage_counters c
     WHERE c.storage_bytes > 0
       AND c.period ~ '^[0-9]{4}-[0-9]{2}$'
     ORDER BY c.workspace_id, c.period
  ),
  since AS (
    SELECT f.workspace_id,
           f.storage_bytes
             + COALESCE((
                 SELECT sum(CASE WHEN l.operation = 'upload' THEN l.file_size ELSE -l.file_size END)
                   FROM public.storage_usage_logs l
                  WHERE l.workspace_id = f.workspace_id
                    AND l.success
                    AND l.file_size > 0
                    AND l.operation IN ('upload', 'delete')
                    AND l.created_at >= ((f.period || '-01')::date + interval '1 month')::timestamp AT TIME ZONE 'UTC'
               ), 0) AS occupancy
      FROM first_month f
  ),
  newest AS (
    SELECT DISTINCT ON (c.workspace_id) c.workspace_id, c.period, c.storage_bytes
      FROM public.workspace_usage_counters c
     ORDER BY c.workspace_id, c.period DESC
  )
  UPDATE public.workspace_usage_counters c
     SET storage_bytes = c.storage_bytes + (s.occupancy - n.storage_bytes),
         updated_at = now()
    FROM since s
    JOIN newest n ON n.workspace_id = s.workspace_id
   WHERE c.workspace_id = n.workspace_id
     AND c.period = n.period
     AND s.occupancy > n.storage_bytes;
END;
$migration$;

COMMIT;
