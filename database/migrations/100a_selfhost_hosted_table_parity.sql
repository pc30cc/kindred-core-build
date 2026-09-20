-- ============================================================
-- 100a — THE HOSTED TABLES THIS CHAIN USES AND NEVER CREATED
--
-- Seven tables are written to, altered and read by migrations in this chain
-- and by the server, and not one of them is created here. Six exist in the
-- hosted chain; `billing_payments` exists in neither and has never existed
-- anywhere in this repository.
--
--   workspace_usage_counters   first used by 016a (inside a function body)
--   call_center_settings       first used by 101 (ALTER, then UPDATE)
--   user_notification_prefs    first used by 136 (ALTER)
--   platform_branding          first used by 104
--   billing_payments           first used by 105
--   platform_settings          first used by 152
--   plan_change_log            first used by 154
--
-- 101 is where a real install stopped:
--
--   psql:101_call_widget_presentation_contract.sql:5:
--     ERROR:  relation "public.call_center_settings" does not exist
--
-- 016a got through only because its reference sits inside a plpgsql body,
-- which resolves at call time — so that one was never a broken install, it
-- was a broken call minute, raised at whoever happened to end a call first.
--
-- WHY IT SURVIVED THIS LONG
--
-- Two reasons, and the second is the one worth fixing.
--
-- The job that applies this chain end to end needs a database and a runner,
-- and this account's CI has neither: every workflow run in the repository,
-- on main included, fails in about three seconds without producing a log.
--
-- And `src/test/integration/authStubSchema.ts` created three of these six —
-- call_center_settings, platform_branding, billing_payments — as stubs
-- before each suite, so the integration tests passed against a schema no
-- deployment could ever have. Those stubs are deleted in the same commit as
-- this file: a test fixture that invents a missing table does not find the
-- missing table, it hides it.
--
-- `100a_`, not `200_`: filename order is what applies this chain, and a
-- table has to exist before the migration that alters it. 016a already sets
-- the precedent for a letter suffix. Nothing here can disturb a deployed
-- database, because no deployment has ever reached 101.
--
-- SHAPES are the hosted ones, column for column, so that one server reads
-- both deployments. `billing_payments` has no hosted original, so it is
-- reconstructed from what 105 requires of it — every column 105 alters or
-- constrains, with the types 105 expects to find.
-- ============================================================

-- ---------- workspace_usage_counters ----------
-- Per-workspace, per-period meters. 016a's plpgsql adds call minutes to a
-- row of this table every time a call ends.
CREATE TABLE IF NOT EXISTS public.workspace_usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period text NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
  messages_count integer NOT NULL DEFAULT 0,
  ai_requests_count integer NOT NULL DEFAULT 0,
  ai_credits_used integer NOT NULL DEFAULT 0,
  ai_credits_balance integer NOT NULL DEFAULT 0,
  visitors_count integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  conversations_count integer NOT NULL DEFAULT 0,
  email_sent_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, period)
);

-- 016a's counter update is an INSERT ... ON CONFLICT on exactly this pair.
CREATE INDEX IF NOT EXISTS idx_workspace_usage_counters_workspace
  ON public.workspace_usage_counters (workspace_id);

-- ---------- call_center_settings ----------
CREATE TABLE IF NOT EXISTS public.call_center_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  public_key text UNIQUE,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  widget_position text NOT NULL DEFAULT 'bottom-right',
  widget_theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_name text,
  avatar_storage_path text,
  avatar_url text,
  voice_enabled boolean NOT NULL DEFAULT true,
  video_enabled boolean NOT NULL DEFAULT true,
  callback_enabled boolean NOT NULL DEFAULT true,
  pre_call_form_enabled boolean NOT NULL DEFAULT true,
  pre_call_form_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  business_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  offline_behavior text NOT NULL DEFAULT 'callback',
  recording_enabled boolean NOT NULL DEFAULT false,
  recording_consent_required boolean NOT NULL DEFAULT true,
  routing_mode text NOT NULL DEFAULT 'broadcast',
  default_department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- platform_branding ----------
-- One row, platform-wide. PlatformBrandingGate reads favicon_url and
-- pwa_icon_url from it at runtime; both are null on a fresh install, which
-- is why the static files in public/ are what actually ships until an
-- operator sets them.
CREATE TABLE IF NOT EXISTS public.platform_branding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logo_url text,
  favicon_url text,
  pwa_icon_url text,
  primary_color text DEFAULT '#3B82F6'::text,
  secondary_color text DEFAULT '#1E40AF'::text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ---------- platform_settings ----------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_mode text NOT NULL DEFAULT 'multi_language',
  default_locale text NOT NULL DEFAULT 'en',
  panel_default_locale text NOT NULL DEFAULT 'en',
  widget_default_locale text NOT NULL DEFAULT 'en',
  fallback_locale text NOT NULL DEFAULT 'en',
  active_locales text[] NOT NULL DEFAULT '{en}'::text[],
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT platform_settings_site_mode_check
    CHECK (site_mode = ANY (ARRAY['single_language'::text, 'multi_language'::text]))
);

-- ---------- plan_change_log ----------
CREATE TABLE IF NOT EXISTS public.plan_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  old_plan_id uuid REFERENCES public.billing_plans(id),
  new_plan_id uuid REFERENCES public.billing_plans(id),
  change_type text NOT NULL DEFAULT 'upgrade',
  changed_by uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- billing_payments ----------
-- No hosted original to copy. This is what 105 requires: it widens `amount`
-- and `refund_amount` to bigint (so they must exist and be integral), adds
-- `payment_intent_id` with its own FK, and constrains `action_type` and
-- `billing_interval` — so those two must exist for the CHECK to attach to.
-- `payment_intent_id` is deliberately NOT declared here: 103 creates
-- billing_payment_intents and 105 adds the column with the reference, and
-- duplicating it would mean two places to keep true.
CREATE TABLE IF NOT EXISTS public.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  amount bigint NOT NULL DEFAULT 0,
  refund_amount bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'IRR',
  status text NOT NULL DEFAULT 'paid',
  provider_name text,
  provider_payment_id text,
  purchase_type text,
  action_type text,
  plan_id uuid REFERENCES public.billing_plans(id),
  plan_name_snapshot text,
  billing_interval text,
  paid_at timestamptz,
  invoice_number text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_workspace
  ON public.billing_payments (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_provider_payment
  ON public.billing_payments (provider_name, provider_payment_id)
  WHERE provider_name IS NOT NULL AND provider_payment_id IS NOT NULL;

-- ---------- user_notification_prefs ----------
-- 136 runs `ALTER TABLE public.user_notification_prefs ADD COLUMN IF NOT
-- EXISTS push_scope ...`, where the IF NOT EXISTS guards the column and not
-- the relation. Creating the table here, before 136, is what makes that
-- statement mean what it was written to mean.
--
-- `user_id` references `public.profiles(id)`, not `auth.users(id)`: 026 made
-- profiles the free-standing identity root of this chain, and a new FK to
-- auth.users would put back exactly the dependency 026 removed. 198 sets the
-- same precedent for its own `created_by`.
CREATE TABLE IF NOT EXISTS public.user_notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  disable_all boolean NOT NULL DEFAULT false,

  push_when_online boolean NOT NULL DEFAULT true,
  push_when_offline boolean NOT NULL DEFAULT true,
  push_visitor_browsing boolean NOT NULL DEFAULT false,
  play_sound boolean NOT NULL DEFAULT true,

  email_unread_messages boolean NOT NULL DEFAULT true,
  email_transcripts boolean NOT NULL DEFAULT false,
  email_user_ratings boolean NOT NULL DEFAULT true,
  email_paid_invoices boolean NOT NULL DEFAULT true,
  email_weekly_summary boolean NOT NULL DEFAULT false,
  email_product_updates boolean NOT NULL DEFAULT false,

  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start text NULL,
  quiet_hours_end text NULL,
  quiet_hours_timezone text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_notification_prefs_unique UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_user
  ON public.user_notification_prefs (user_id);

-- A row belongs to the user named in it. The workspace column scopes a
-- preference, it does not share it.
ALTER TABLE public.user_notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_select_own_notif_prefs" ON public.user_notification_prefs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_insert_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_insert_own_notif_prefs" ON public.user_notification_prefs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_update_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_update_own_notif_prefs" ON public.user_notification_prefs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users_delete_own_notif_prefs" ON public.user_notification_prefs;
CREATE POLICY "users_delete_own_notif_prefs" ON public.user_notification_prefs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notification_prefs TO service_role;

-- ---------- row security ----------
-- Every one of these is reached through the Express service-role boundary,
-- never from a browser: five are platform- or billing-scoped and the sixth,
-- call_center_settings, is written by the Super Admin and read by the widget
-- endpoint on the server's behalf. RLS on with no policies is the same
-- posture 039 and 042 take, and 000 now guarantees the roles arrive with no
-- implicit grant to fall back on.
ALTER TABLE public.workspace_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_center_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_branding        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_change_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments         ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_usage_counters TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_center_settings     TO service_role;
GRANT SELECT, INSERT, UPDATE          ON public.platform_branding       TO service_role;
GRANT SELECT, INSERT, UPDATE          ON public.platform_settings       TO service_role;
GRANT SELECT, INSERT                  ON public.plan_change_log         TO service_role;
GRANT SELECT, INSERT, UPDATE          ON public.billing_payments        TO service_role;

-- ---------- in-migration proof ----------
DO $verify$
DECLARE
  t text;
  missing text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_usage_counters', 'call_center_settings', 'platform_branding',
    'platform_settings', 'plan_change_log', 'billing_payments',
    'user_notification_prefs'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION '100a: still missing %', array_to_string(missing, ', ');
  END IF;

  -- The four columns 105 alters or constrains. If any is absent, 105 fails
  -- on a CHECK with nothing to attach to rather than on a missing relation,
  -- which is a harder error to read.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'billing_payments'
      AND column_name IN ('amount', 'refund_amount', 'action_type', 'billing_interval')
    HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION '100a: billing_payments is missing a column 105 needs';
  END IF;

  RAISE NOTICE '100a: the six hosted tables this chain uses now exist in it';
END
$verify$;
