
CREATE OR REPLACE FUNCTION public.enforcement_rules_protect_builtin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_builtin THEN
    IF NEW.slug          IS DISTINCT FROM OLD.slug          THEN RAISE EXCEPTION 'cannot rename builtin rule slug'; END IF;
    IF NEW.trigger_type  IS DISTINCT FROM OLD.trigger_type  THEN RAISE EXCEPTION 'cannot change builtin rule trigger_type'; END IF;
    IF NEW.condition_json IS DISTINCT FROM OLD.condition_json THEN RAISE EXCEPTION 'cannot change builtin rule condition_json'; END IF;
    IF NEW.actions_json  IS DISTINCT FROM OLD.actions_json  THEN RAISE EXCEPTION 'cannot change builtin rule actions_json'; END IF;
    IF NEW.is_builtin    IS DISTINCT FROM OLD.is_builtin    THEN RAISE EXCEPTION 'cannot toggle is_builtin'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
