CREATE OR REPLACE FUNCTION public.widget_platform_settings_validate_phase1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.typing_rate_limit_window_ms < 250 OR NEW.typing_rate_limit_window_ms > 60000 THEN
    RAISE EXCEPTION 'typing_rate_limit_window_ms must be between 250 and 60000';
  END IF;
  IF NEW.typing_rate_limit_max_events < 1 OR NEW.typing_rate_limit_max_events > 100 THEN
    RAISE EXCEPTION 'typing_rate_limit_max_events must be between 1 and 100';
  END IF;
  RETURN NEW;
END;
$$;