-- Per-user availability preferences (operator presence schedule).
CREATE TABLE IF NOT EXISTS public.user_availability_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  force_offline BOOLEAN NOT NULL DEFAULT false,
  available_when_using_app BOOLEAN NOT NULL DEFAULT true,
  schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  weekly_schedule JSONB NOT NULL DEFAULT '{
    "mon":{"enabled":true,"intervals":[{"from":"09:00","to":"18:00"}]},
    "tue":{"enabled":true,"intervals":[{"from":"09:00","to":"18:00"}]},
    "wed":{"enabled":true,"intervals":[{"from":"09:00","to":"18:00"}]},
    "thu":{"enabled":true,"intervals":[{"from":"09:00","to":"18:00"}]},
    "fri":{"enabled":true,"intervals":[{"from":"09:00","to":"18:00"}]},
    "sat":{"enabled":true,"intervals":[]},
    "sun":{"enabled":false,"intervals":[]}
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_availability_prefs_user_ws_unique
  ON public.user_availability_prefs (user_id, COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS user_availability_prefs_user_idx
  ON public.user_availability_prefs (user_id);

ALTER TABLE public.user_availability_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users select own availability" ON public.user_availability_prefs;
CREATE POLICY "users select own availability"
  ON public.user_availability_prefs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users insert own availability" ON public.user_availability_prefs;
CREATE POLICY "users insert own availability"
  ON public.user_availability_prefs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update own availability" ON public.user_availability_prefs;
CREATE POLICY "users update own availability"
  ON public.user_availability_prefs
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users delete own availability" ON public.user_availability_prefs;
CREATE POLICY "users delete own availability"
  ON public.user_availability_prefs
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Inline updated_at trigger function (scoped to this table)
CREATE OR REPLACE FUNCTION public.user_availability_prefs_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_availability_prefs_updated_at ON public.user_availability_prefs;
CREATE TRIGGER user_availability_prefs_updated_at
  BEFORE UPDATE ON public.user_availability_prefs
  FOR EACH ROW
  EXECUTE FUNCTION public.user_availability_prefs_set_updated_at();