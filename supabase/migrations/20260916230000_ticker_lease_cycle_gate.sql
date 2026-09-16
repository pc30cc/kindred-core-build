-- 192 — Ticker lease: gate a CYCLE, not just concurrency.
--
-- Disk IO finding. 123_observability_ticker_lease.sql introduced the lease
-- with the stated contract "exactly ONE replica runs a given named ticker per
-- cycle". Measured against production, that is not what it does.
--
-- observability_release_ticker_lease() clears owner and expires_at the moment
-- a pass finishes, and observability_try_acquire_ticker_lease() grants the
-- lease to anyone who finds it free:
--
--     WHERE owner IS NULL OR expires_at IS NULL OR expires_at <= now()
--
-- With two API replicas ticking on the same period but offset in wall-clock
-- time, replica A runs at t=0 and releases at t≈0.3s; replica B ticks at
-- t=30 and finds the lease free, so it runs a SECOND, fully duplicate pass.
-- The lease prevents SIMULTANEOUS execution and nothing else. Measured on
-- the live database: the 'alerting' ticker (TICK_MS = 60s) completed 2 passes
-- per minute, and 'failover_health' (TICK_MS = 30s) completed 4 — every
-- ticker, and every write it performs, running at exactly 2x its intended
-- rate for as long as two replicas have been up.
--
-- last_finished_at was already being recorded by the release function on
-- every pass. It was simply never read. This migration makes the acquire
-- predicate consult it:
--
--   a replica may start a cycle only if the previous cycle finished at least
--   min_interval_seconds ago
--
-- which converts the lease from a mutual-exclusion lock into a fleet-wide
-- rate limit on cycle STARTS. Replica count then stops being a multiplier:
-- N replicas produce one pass per period, not N.
--
-- The gate lives in the TABLE, not in the function signature, on purpose:
--
--   * The signature stays frozen, so this migration is safe to apply in
--     either order relative to the code deploy. An overload (adding a
--     defaulted 4th argument) would leave a 3-argument PostgREST payload
--     matching two candidates, and dropping the 3-argument form would break
--     every replica still running the old build mid-rollout.
--   * It takes effect the moment the migration lands — no deploy required.
--   * An operator can retune a ticker's cadence in production with an UPDATE,
--     without shipping code.
--
-- min_interval_seconds = 0 preserves the pre-migration behaviour exactly, so
-- any lease this migration does not know about is unaffected.
--
-- Crash recovery is unchanged and still correct: last_finished_at only ever
-- advances on a CLEAN finish (the release call). A replica that dies
-- mid-pass leaves last_finished_at stale, so the next tick passes the gate
-- as soon as the TTL expires the abandoned lease — the gate can never wedge
-- a ticker shut.

ALTER TABLE public.observability_ticker_lease
  ADD COLUMN IF NOT EXISTS min_interval_seconds integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.observability_ticker_lease.min_interval_seconds IS
  'Fleet-wide minimum seconds between cycle STARTS for this ticker. 0 disables the gate. Set to ~85% of the caller''s TICK_MS so ordinary timer jitter never skips a legitimate cycle.';

-- Seeded at ~85% of each ticker's TICK_MS. The headroom matters: gating at
-- exactly TICK_MS would drop a cycle whenever setInterval fires a few
-- milliseconds early relative to the previous pass's completion timestamp,
-- which over hours turns into a visibly slower effective cadence.
--
--   alerting           TICK_MS  60s      -> 51
--   failover_health    TICK_MS  30s      -> 25
--   seo_rank_tracking  TICK_MS  15m      -> 765
--   gmail_watch_renewal TICK_MS  6h      -> 18360
--
-- server/services/observability/tickerLease.ts carries the same table as
-- TICKER_CYCLE_SECONDS and a test asserts the two stay in step.
INSERT INTO public.observability_ticker_lease (name, min_interval_seconds) VALUES
    ('alerting', 51),
    ('failover_health', 25),
    ('seo_rank_tracking', 765),
    ('gmail_watch_renewal', 18360)
ON CONFLICT (name) DO UPDATE SET min_interval_seconds = EXCLUDED.min_interval_seconds;

CREATE OR REPLACE FUNCTION public.observability_try_acquire_ticker_lease(
  _name text,
  _owner text,
  _ttl_seconds integer DEFAULT 120
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _acquired boolean := false;
BEGIN
  IF _name IS NULL OR length(_name) = 0 THEN
    RAISE EXCEPTION 'ticker_lease_name_required';
  END IF;
  IF _owner IS NULL OR length(_owner) = 0 THEN
    RAISE EXCEPTION 'ticker_lease_owner_required';
  END IF;
  IF _ttl_seconds IS NULL OR _ttl_seconds < 30 OR _ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'ticker_lease_ttl_out_of_range';
  END IF;

  -- Bootstrap only. The original unconditional INSERT ... ON CONFLICT DO
  -- NOTHING entered the write path on every single acquire attempt, including
  -- the overwhelming majority where the row has existed since migration 123.
  -- Probing the primary key first keeps the steady state a read.
  IF NOT EXISTS (SELECT 1 FROM public.observability_ticker_lease WHERE name = _name) THEN
    INSERT INTO public.observability_ticker_lease (name) VALUES (_name)
    ON CONFLICT (name) DO NOTHING;
  END IF;

  -- Row lock serializes competing replicas; the winner is whoever finds the
  -- lease free or expired AND is far enough past the previous cycle. A
  -- replica denied by the gate matches zero rows and therefore writes
  -- nothing at all — losing a race stays as cheap as it was before.
  UPDATE public.observability_ticker_lease
     SET owner = _owner,
         acquired_at = now(),
         expires_at = now() + make_interval(secs => _ttl_seconds),
         passes = passes + 1
   WHERE name = _name
     AND (owner IS NULL OR expires_at IS NULL OR expires_at <= now())
     AND (
       COALESCE(min_interval_seconds, 0) <= 0
       OR last_finished_at IS NULL
       OR last_finished_at <= now() - make_interval(secs => COALESCE(min_interval_seconds, 0))
     )
  RETURNING true INTO _acquired;

  RETURN COALESCE(_acquired, false);
END;
$$;

REVOKE ALL ON FUNCTION public.observability_try_acquire_ticker_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observability_try_acquire_ticker_lease(text, text, integer) TO service_role;
