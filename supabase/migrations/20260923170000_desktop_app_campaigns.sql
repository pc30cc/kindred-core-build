-- ============================================================
-- 208 — DESKTOP APP (WINDOWS) CAMPAIGNS: ADS AND ANNOUNCEMENTS
--
-- Super Admin → Desktop app → Ads & announcements. One row is one
-- creative the Windows app shows:
--
--   kind = 'ad'            a promotion card in one or more placements
--                          (under the inbox list, the colleagues list,
--                          the contacts list, the empty chat pane, the
--                          top of Settings).
--   kind = 'announcement'  a notice in the banner strip at the top of the
--                          app (maintenance, new feature, warning), with a
--                          severity, optionally dismissible.
--
-- Targeting: `target_plans` holds billing plan slugs; empty means every
-- plan. `starts_at` / `ends_at` bound the schedule; `active` is the switch.
-- Texts are per locale ({ fa: {title, body, cta_label}, en: {...}, tr: {...} })
-- with English as the fallback, like the mobile promotions.
--
-- service_role only: read and written by the Express backend. Live usage
-- counts and one-off broadcasts are NOT stored here (they live in memory).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.desktop_app_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'ad',                    -- ad | announcement
  name text NOT NULL DEFAULT '',                      -- internal label for admins
  placements text[] NOT NULL DEFAULT ARRAY['inbox_list']::text[],
  target_plans text[] NOT NULL DEFAULT ARRAY[]::text[],
  text jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_url text,
  cta_url text,
  severity text NOT NULL DEFAULT 'info',              -- info | success | warning | critical
  dismissible boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.desktop_app_campaigns TO service_role;
ALTER TABLE public.desktop_app_campaigns ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS desktop_app_campaigns_active_idx
  ON public.desktop_app_campaigns (active, priority DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_campaigns_kind_chk') THEN
    ALTER TABLE public.desktop_app_campaigns
      ADD CONSTRAINT desktop_app_campaigns_kind_chk CHECK (kind IN ('ad', 'announcement'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_campaigns_severity_chk') THEN
    ALTER TABLE public.desktop_app_campaigns
      ADD CONSTRAINT desktop_app_campaigns_severity_chk CHECK (severity IN ('info', 'success', 'warning', 'critical'));
  END IF;
END $$;
