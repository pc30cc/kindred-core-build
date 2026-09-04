-- Live Monitoring — cluster-wide ticker lease.
-- The alerting and realtime-failover-health tickers now read from a
-- per-process, per-replica in-memory collector (see
-- server/services/observability/collector/) instead of a shared Postgres
-- table. With multiple API replicas, letting every replica evaluate alert
-- rules / failover health independently every tick would produce
-- inconsistent alert_events rows and flapping failover decisions, since
-- each replica only sees its own local slice of traffic.
--
-- This lease (same pattern as ai_billing_recovery_lease, migration 075)
-- makes exactly ONE replica run a given named ticker per cycle, and
-- expires on its own if that replica dies mid-cycle.
CREATE TABLE IF NOT EXISTS public.observability_ticker_lease (
  name text PRIMARY KEY,
  owner text,
  acquired_at timestamptz,
  expires_at timestamptz,
  last_finished_at timestamptz,
  passes bigint NOT NULL DEFAULT 0
);

GRANT ALL ON public.observability_ticker_lease TO service_role;
ALTER TABLE public.observability_ticker_lease ENABLE ROW LEVEL SECURITY;
-- No policy on purpose: only service_role (which bypasses RLS) may touch it.

INSERT INTO public.observability_ticker_lease (name) VALUES ('alerting'), ('failover_health')
ON CONFLICT (name) DO NOTHING;

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

  INSERT INTO public.observability_ticker_lease (name) VALUES (_name)
  ON CONFLICT (name) DO NOTHING;

  -- Row lock serializes competing replicas; the winner is whoever finds the
  -- lease free or expired.
  UPDATE public.observability_ticker_lease
     SET owner = _owner,
         acquired_at = now(),
         expires_at = now() + make_interval(secs => _ttl_seconds),
         passes = passes + 1
   WHERE name = _name
     AND (owner IS NULL OR expires_at IS NULL OR expires_at <= now())
  RETURNING true INTO _acquired;

  RETURN COALESCE(_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.observability_release_ticker_lease(_name text, _owner text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _released boolean := false;
BEGIN
  UPDATE public.observability_ticker_lease
     SET owner = NULL,
         expires_at = NULL,
         last_finished_at = now()
   WHERE name = _name AND owner = _owner
  RETURNING true INTO _released;
  RETURN COALESCE(_released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.observability_try_acquire_ticker_lease(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.observability_release_ticker_lease(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observability_try_acquire_ticker_lease(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.observability_release_ticker_lease(text, text) TO service_role;
