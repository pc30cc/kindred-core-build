
-- User notification preferences (per-user, optionally scoped to a workspace)
CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Master switch
  disable_all boolean NOT NULL DEFAULT false,

  -- Push / browser notifications
  push_when_online boolean NOT NULL DEFAULT true,
  push_when_offline boolean NOT NULL DEFAULT true,
  push_visitor_browsing boolean NOT NULL DEFAULT false,
  play_sound boolean NOT NULL DEFAULT true,

  -- Email notifications
  email_unread_messages boolean NOT NULL DEFAULT true,
  email_transcripts boolean NOT NULL DEFAULT false,
  email_user_ratings boolean NOT NULL DEFAULT true,
  email_paid_invoices boolean NOT NULL DEFAULT true,
  email_weekly_summary boolean NOT NULL DEFAULT false,
  email_product_updates boolean NOT NULL DEFAULT false,

  -- Quiet hours (24h, user local timezone)
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start text NULL,  -- HH:MM
  quiet_hours_end text NULL,    -- HH:MM
  quiet_hours_timezone text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_notification_prefs_unique UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_user
  ON public.user_notification_prefs (user_id);

ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_select_own_notif_prefs"
  ON public.user_notification_prefs
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_insert_own_notif_prefs"
  ON public.user_notification_prefs
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_update_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_update_own_notif_prefs"
  ON public.user_notification_prefs
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_delete_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_delete_own_notif_prefs"
  ON public.user_notification_prefs
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_user_notification_prefs()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_user_notification_prefs ON public.user_notification_prefs;
CREATE TRIGGER trg_touch_user_notification_prefs
  BEFORE UPDATE ON public.user_notification_prefs
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_user_notification_prefs();
