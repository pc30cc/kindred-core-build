-- ─────────────────────────────────────────────────────────────────────
-- analytics_day_seals stops recording anything it is not asked to recall.
--
-- The table has one job: answer "which past workspace-days are already
-- canonical?", so the sealing pass does not rebuild a day twice. The only
-- column any code reads is `sealed_at` — verified by the single SELECT in
-- server/services/analytics/sealing.ts, which asks for
-- `workspace_id, day, sealed_at` and nothing else.
--
-- Everything else the function wrote was write-only:
--
--   attempts          a retry counter nothing increments against
--   last_error        the vendor's error string, kept for a card that is gone
--   row_count         \
--   objects_written    |  fed the Cutover Readiness checklist, which was
--   source_row_count   |  removed along with the rest of the analytics
--   verified          /   self-history
--
-- Analytics keeps no history of itself, so it stops writing these. The
-- columns are NOT dropped and no row is deleted: existing values stay
-- exactly as they are, readable by anyone who wants to look at what the
-- old build recorded. They simply stop accumulating.
--
-- The error argument is retained, because it carries CONTROL FLOW rather
-- than a message: a failed rebuild must not mark the day sealed, or the
-- next cycle would skip a day that was never made canonical. The function
-- still branches on it; it just no longer stores it.
-- ─────────────────────────────────────────────────────────────────────

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
  -- A failed rebuild records nothing at all: with no row, or with the
  -- previous row's sealed_at untouched, the next cycle retries the day.
  IF _error IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'sealed', false);
  END IF;

  INSERT INTO public.analytics_day_seals AS s (workspace_id, day, sealed_at, updated_at)
  VALUES (_workspace_id, _day, now(), now())
  ON CONFLICT (workspace_id, day) DO UPDATE SET
    sealed_at  = now(),
    updated_at = now();

  RETURN jsonb_build_object('ok', true, 'sealed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_analytics_day_seal(uuid, date, bigint, bigint, bigint, boolean, text)
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.record_analytics_day_seal(uuid, date, bigint, bigint, bigint, boolean, text)
      TO service_role;
  END IF;
END $$;
