-- Lock down auto-action tables explicitly. Service role bypasses RLS,
-- so this just makes the "no public read/write" intent explicit and
-- silences the RLS-enabled-no-policy linter.

CREATE POLICY "auto_action_definitions_no_public_access"
  ON public.auto_action_definitions
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "auto_action_events_no_public_access"
  ON public.auto_action_events
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- Pin search_path on the trigger function.
CREATE OR REPLACE FUNCTION public.touch_auto_action_definitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;