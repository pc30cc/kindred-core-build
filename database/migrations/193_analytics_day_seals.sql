-- 193 — Analytics day seals: durability for the in-process analytics buffer.
--
-- ── The problem ──────────────────────────────────────────────────
--
-- Phase 1 buffers analytics rows in the backend process and flushes them to
-- Parquet on a timer (server/services/analytics/writer.ts). Rows held in
-- that buffer do not survive SIGTERM, a container restart, a crash, an OOM
-- kill, a deploy, or a long S3 outage. A tracking endpoint that already
-- answered `ok` must not lose the event it accepted.
--
-- ── The approach ─────────────────────────────────────────────────
--
-- Not a queue, not a spool, not a new service — a SEAL.
--
-- PostgreSQL already holds every analytics row: Phase 1 dual-writes, so
-- `visitor_page_views`, `web_analytics_events` and `visitor_sessions` are
-- the durable copy. The buffer therefore never needed to be durable; it
-- needed to be RECONSTRUCTIBLE. Once a UTC day is over, one pass rebuilds
-- that workspace-day from PostgreSQL, writes the canonical Parquet objects,
-- and records the day as SEALED here.
--
-- Live objects are the speed layer: they make today's data queryable within
-- seconds. The seal is the batch layer: it replaces that day's objects with
-- a complete, canonical set derived from the durable source. Anything the
-- buffer lost is restored by the rebuild, because the rebuild never reads
-- the buffer.
--
-- That also settles two things a plain spool would not:
--   * it compacts a day's many small live objects into few large ones;
--   * it is the mechanism by which a privacy erasure reaches the lake —
--     anonymize in PostgreSQL, unseal the affected days, and the next pass
--     rewrites them (server/services/analytics/sealing.ts).
--
-- ── What this does NOT cover ─────────────────────────────────────
--
-- The rebuild reads PostgreSQL. Under `writeMode: 's3_only'` PostgreSQL
-- would no longer receive the rows, so the source of the rebuild would be
-- gone and this mechanism would stop providing any guarantee. That is one
-- of the reasons `s3_only` remains phase-locked: cutting the write path
-- over requires a genuine durable spool, which is Phase 3 work and is not
-- built here.
--
-- NON-DESTRUCTIVE: creates one bookkeeping table. No existing table is
-- altered or dropped; no analytics or visitor row is deleted.

CREATE TABLE IF NOT EXISTS public.analytics_day_seals (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  /** The UTC day this row describes — the same grain the object layout partitions by. */
  day date NOT NULL,
  /**
   * When the day was last rebuilt from PostgreSQL and its objects replaced.
   * NULL means the day is still served entirely by live (speed-layer)
   * objects and has not yet been made canonical.
   */
  sealed_at timestamptz,
  /** Rows the sealing pass wrote. Compared against PostgreSQL to verify the seal. */
  row_count bigint NOT NULL DEFAULT 0,
  objects_written bigint NOT NULL DEFAULT 0,
  /** Rows PostgreSQL held for this day when it was sealed — the verification number. */
  source_row_count bigint NOT NULL DEFAULT 0,
  /** A seal is only trusted when the written rows matched the source rows exactly. */
  verified boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);

-- The sealing pass asks one question: "which past days are not yet sealed?"
CREATE INDEX IF NOT EXISTS idx_analytics_day_seals_unsealed
  ON public.analytics_day_seals (day)
  WHERE sealed_at IS NULL;

-- The sealing pass and the day rebuild both scan `visitor_sessions` by
-- (workspace, started_at). The table has indexes on `workspace_id` and on
-- `(workspace_id, last_seen_at DESC)` but none on `started_at`, so without
-- this every cycle degenerates into a repeated per-workspace scan. Added
-- here rather than in the Phase 1 migration because sealing is what makes
-- the access pattern recurring.
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_workspace_started
  ON public.visitor_sessions (workspace_id, started_at);

ALTER TABLE public.analytics_day_seals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.analytics_day_seals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_day_seals TO service_role;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'analytics_day_seals' AND policyname = 'service role only'
  ) THEN
    CREATE POLICY "service role only" ON public.analytics_day_seals
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

/**
 * Record the outcome of one sealing pass.
 *
 * Upsert rather than insert-or-fail: sealing is idempotent by construction
 * (the rebuild writes deterministic object keys and replaces whatever was
 * there), so re-sealing a day is always allowed and always safe. A failed
 * pass bumps `attempts` and records the error WITHOUT marking the day
 * sealed, so the next cycle retries it.
 */
CREATE OR REPLACE FUNCTION public.record_analytics_day_seal(
  _workspace_id uuid,
  _day date,
  _row_count bigint,
  _objects bigint,
  _source_row_count bigint,
  _verified boolean,
  _error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.analytics_day_seals AS s (
    workspace_id, day, sealed_at, row_count, objects_written,
    source_row_count, verified, attempts, last_error, updated_at
  )
  VALUES (
    _workspace_id, _day,
    CASE WHEN _error IS NULL THEN now() ELSE NULL END,
    COALESCE(_row_count, 0), COALESCE(_objects, 0),
    COALESCE(_source_row_count, 0), COALESCE(_verified, false),
    CASE WHEN _error IS NULL THEN 0 ELSE 1 END,
    _error, now()
  )
  ON CONFLICT (workspace_id, day) DO UPDATE SET
    sealed_at = CASE WHEN _error IS NULL THEN now() ELSE s.sealed_at END,
    row_count = CASE WHEN _error IS NULL THEN COALESCE(_row_count, 0) ELSE s.row_count END,
    objects_written = CASE WHEN _error IS NULL THEN COALESCE(_objects, 0) ELSE s.objects_written END,
    source_row_count = CASE WHEN _error IS NULL THEN COALESCE(_source_row_count, 0) ELSE s.source_row_count END,
    verified = CASE WHEN _error IS NULL THEN COALESCE(_verified, false) ELSE s.verified END,
    attempts = CASE WHEN _error IS NULL THEN 0 ELSE s.attempts + 1 END,
    last_error = _error,
    updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

/**
 * Mark days unsealed so the next pass rebuilds them.
 *
 * The erasure hook: after a privacy subject is anonymized in PostgreSQL,
 * the analytics objects for the days they were active still hold the old
 * values. Unsealing those days makes the next sealing pass rewrite them
 * from the (now anonymized) source.
 */
CREATE OR REPLACE FUNCTION public.unseal_analytics_days(
  _workspace_id uuid,
  _from date,
  _to date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _affected integer;
BEGIN
  UPDATE public.analytics_day_seals
  SET sealed_at = NULL, verified = false, attempts = 0, last_error = NULL, updated_at = now()
  WHERE workspace_id = _workspace_id
    AND day >= _from
    AND day <= _to;
  GET DIAGNOSTICS _affected = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'unsealed', _affected);
END;
$$;

REVOKE ALL ON FUNCTION public.record_analytics_day_seal(uuid, date, bigint, bigint, bigint, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unseal_analytics_days(uuid, date, date) FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.record_analytics_day_seal(uuid, date, bigint, bigint, bigint, boolean, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.unseal_analytics_days(uuid, date, date) TO service_role;
  END IF;
END $$;

DO $verify$
BEGIN
  IF to_regclass('public.analytics_day_seals') IS NULL THEN
    RAISE EXCEPTION 'analytics_day_seals: table missing';
  END IF;
  IF to_regprocedure('public.record_analytics_day_seal(uuid, date, bigint, bigint, bigint, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'analytics_day_seals: record_analytics_day_seal missing';
  END IF;
  IF to_regprocedure('public.unseal_analytics_days(uuid, date, date)') IS NULL THEN
    RAISE EXCEPTION 'analytics_day_seals: unseal_analytics_days missing';
  END IF;
END
$verify$;
