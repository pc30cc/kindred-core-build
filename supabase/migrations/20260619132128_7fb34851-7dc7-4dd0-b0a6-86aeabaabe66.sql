
-- ─── Canonical producer for workspace_usage_counters.storage_bytes ───
-- Single writer: trigger on storage_usage_logs.
-- Only success=true rows with a non-null file_size affect the counter.
-- Cumulative semantics preserved across month rollovers via carry-forward seed.

CREATE OR REPLACE FUNCTION public.apply_storage_usage_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_delta  bigint := 0;
  v_seed   bigint := 0;
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

  -- Carry-forward seed: most recent prior period's storage_bytes for this workspace.
  SELECT storage_bytes
    INTO v_seed
    FROM public.workspace_usage_counters
   WHERE workspace_id = NEW.workspace_id
     AND period < v_period
   ORDER BY period DESC
   LIMIT 1;

  IF v_seed IS NULL THEN
    v_seed := 0;
  END IF;

  INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
  VALUES (NEW.workspace_id, v_period, GREATEST(v_seed + v_delta, 0))
  ON CONFLICT (workspace_id, period) DO UPDATE
    SET storage_bytes = GREATEST(public.workspace_usage_counters.storage_bytes + v_delta, 0),
        updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_storage_usage_logs_apply ON public.storage_usage_logs;
CREATE TRIGGER trg_storage_usage_logs_apply
  AFTER INSERT ON public.storage_usage_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_storage_usage_log();

COMMENT ON FUNCTION public.apply_storage_usage_log() IS
  'Canonical producer for workspace_usage_counters.storage_bytes. SOLE writer. Increments on successful uploads with file_size, decrements on successful deletes with file_size. Seeds new monthly rows from the prior period to preserve cumulative occupancy across rollover.';
