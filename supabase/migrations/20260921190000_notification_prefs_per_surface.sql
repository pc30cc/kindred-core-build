-- ============================================================
-- ONE SET OF NOTIFICATION PREFERENCES PER OPERATOR, PER SURFACE
--
-- `user_notification_prefs` held one row per operator, and both surfaces
-- wrote to it: the browser's Settings → Notifications page and the phone
-- app's. So an operator who turned push off on their phone — because the
-- phone is the thing that wakes them at night — turned the browser off too,
-- and an operator who narrowed the browser to "only threads assigned to me"
-- narrowed the phone with it. They are not the same choice. The phone is
-- carried; the browser is sat in front of.
--
-- So the row gains a surface. 'web' is the browser; 'mobile' is the app, on
-- whichever phone — an operator with an iPhone and an Android tablet is one
-- person with one idea of what their phone should do, and splitting further
-- would be a setting nobody asked for.
--
-- Nothing changes for anybody at the moment of the split: every row that
-- exists is copied to the other surface, so both start out saying exactly
-- what the single row said.
-- ============================================================

-- ---------- 1. which surface a row speaks for ----------
--
-- 'web' by default: every row that exists today was written through the
-- browser's page or by an app posting to the same endpoint, and the browser
-- is the older surface of the two.
ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web';

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS user_notification_prefs_platform_check;

ALTER TABLE public.user_notification_prefs
  ADD CONSTRAINT user_notification_prefs_platform_check
  CHECK (platform IN ('web', 'mobile'));

-- ---------- 2. one row per operator, workspace and surface ----------
--
-- The old constraint was `UNIQUE (user_id, workspace_id)`, which did not
-- constrain the rows it was written for: `workspace_id` is NULL on every
-- account-level row, Postgres treats NULLs as distinct in a unique index, so
-- an operator could hold any number of "global" rows and the route would
-- read whichever `maybeSingle()` happened to return. An expression index
-- over a sentinel closes that at the same time as it adds the surface.
DO $dedupe$
BEGIN
  -- Only ever runs where duplicates already exist. Newest wins: it is the one
  -- the operator last saved, and the one the route was most likely reading.
  DELETE FROM public.user_notification_prefs a
  USING public.user_notification_prefs b
  WHERE a.user_id = b.user_id
    AND a.platform = b.platform
    AND a.workspace_id IS NOT DISTINCT FROM b.workspace_id
    AND (a.updated_at, a.id) < (b.updated_at, b.id);
END
$dedupe$;

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS user_notification_prefs_unique;
DROP INDEX IF EXISTS public.user_notification_prefs_unique;

CREATE UNIQUE INDEX IF NOT EXISTS user_notification_prefs_unique
  ON public.user_notification_prefs (
    user_id,
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    platform
  );

-- ---------- 3. nobody loses a setting on the way through ----------
--
-- Every existing row is also the mobile row, so the phone keeps saying what
-- it said yesterday. Without this the split would silently reset every
-- operator's phone to the defaults, which is exactly the kind of change that
-- is noticed at 3am.
INSERT INTO public.user_notification_prefs (
  user_id, workspace_id, platform,
  disable_all, push_scope, push_preview, push_internal_notes,
  push_when_online, push_when_offline, push_visitor_browsing, play_sound,
  email_unread_messages, email_transcripts, email_user_ratings,
  email_paid_invoices, email_weekly_summary, email_product_updates,
  quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone
)
SELECT
  user_id, workspace_id, 'mobile',
  disable_all, push_scope, push_preview, push_internal_notes,
  push_when_online, push_when_offline, push_visitor_browsing, play_sound,
  email_unread_messages, email_transcripts, email_user_ratings,
  email_paid_invoices, email_weekly_summary, email_product_updates,
  quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone
FROM public.user_notification_prefs
WHERE platform = 'web'
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_user_platform
  ON public.user_notification_prefs (user_id, platform);

-- ---------- proof ----------
--
-- The two things the server now depends on: that a row can say which surface
-- it is for, and that an operator cannot hold two rows for the same one.
DO $verify$
DECLARE
  has_platform boolean;
  unique_covers_platform boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_notification_prefs'
      AND column_name = 'platform'
  ) INTO has_platform;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_notification_prefs'
      AND indexname = 'user_notification_prefs_unique'
      AND indexdef LIKE '%platform%'
  ) INTO unique_covers_platform;

  IF NOT has_platform THEN
    RAISE EXCEPTION 'notification prefs per surface: user_notification_prefs.platform is missing';
  END IF;
  IF NOT unique_covers_platform THEN
    RAISE EXCEPTION 'notification prefs per surface: the unique index does not cover platform';
  END IF;

  RAISE NOTICE 'ok: preferences are per operator, per surface';
END
$verify$;
