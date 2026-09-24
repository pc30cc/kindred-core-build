-- ============================================================
-- 211 — DESKTOP APP (macOS) PLATFORM SETTINGS, AND PER-PLATFORM TARGETING
--
-- Super Admin → macOS app. A platform-wide singleton, service_role-only like
-- desktop_app_settings (207): read and written by the Express backend only
-- (Super Admin, and the public GET /api/platform/macos-app the Mac app reads
-- on launch and every hour). No RLS-facing GRANTs are issued.
--
--  * macos_app_settings — everything the platform decides for the Mac app:
--      updates   Sparkle appcast, channel, latest / minimum / blocked
--                versions, the DMG link, release notes, automatic checks
--                and downloads and how often;
--      runtime   realtime on/off and the polling that covers for it;
--      features  switches for each section of the app (calls, video,
--                email, visitors, call center, colleagues, contacts, voice
--                notes, attachments) — ANDed with the workspace's plan, so
--                they can only take something away, never grant it;
--      system    what the app may do on the Mac: the menu bar item, opening
--                at login, the Dock badge, system notifications;
--      defaults  language, appearance and window behaviour for a first
--                launch (an operator's own choices always win);
--      maintenance  a notice that covers the app, per locale;
--      links     support, status page, privacy and terms.
--
--  * desktop_app_campaigns.platforms — which desktop apps an ad or
--    announcement is for ('windows', 'macos'); empty means both, which is
--    what every existing row keeps meaning.
--
-- Defaults reproduce what the Mac app did before this table existed, so
-- applying this file changes nothing until an operator edits a value.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.macos_app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Updates (Sparkle) ---------------------------------------------------
  appcast_url text DEFAULT 'https://raw.githubusercontent.com/pc30cc/mac-os/main/appcast.xml',
  update_channel text NOT NULL DEFAULT 'stable',          -- stable | beta
  latest_version text,
  minimum_supported_version text,
  blocked_versions text[] NOT NULL DEFAULT ARRAY[]::text[],
  download_url text,
  release_notes text,
  auto_update_enabled boolean NOT NULL DEFAULT true,
  auto_download_enabled boolean NOT NULL DEFAULT true,
  update_check_interval_minutes integer NOT NULL DEFAULT 240,

  -- Runtime -------------------------------------------------------------
  realtime_enabled boolean NOT NULL DEFAULT true,
  poll_interval_seconds integer NOT NULL DEFAULT 15,
  poll_interval_realtime_seconds integer NOT NULL DEFAULT 120,

  -- Features (ANDed with the workspace plan) -----------------------------
  calls_enabled boolean NOT NULL DEFAULT true,
  video_calls_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  visitors_enabled boolean NOT NULL DEFAULT true,
  call_center_enabled boolean NOT NULL DEFAULT true,
  colleagues_enabled boolean NOT NULL DEFAULT true,
  contacts_enabled boolean NOT NULL DEFAULT true,
  voice_notes_enabled boolean NOT NULL DEFAULT true,
  attachments_enabled boolean NOT NULL DEFAULT true,

  -- System integration ----------------------------------------------------
  menu_bar_extra_enabled boolean NOT NULL DEFAULT true,
  launch_at_login_enabled boolean NOT NULL DEFAULT true,
  dock_badge_enabled boolean NOT NULL DEFAULT true,
  notifications_enabled boolean NOT NULL DEFAULT true,

  -- First-launch defaults -------------------------------------------------
  default_language text NOT NULL DEFAULT 'system',        -- system | fa | en | tr
  default_appearance text NOT NULL DEFAULT 'system',      -- system | light | dark
  default_close_to_menu_bar boolean NOT NULL DEFAULT true,
  default_launch_at_login boolean NOT NULL DEFAULT false,

  -- Maintenance -----------------------------------------------------------
  maintenance_enabled boolean NOT NULL DEFAULT false,
  maintenance_message jsonb NOT NULL DEFAULT '{}'::jsonb, -- { fa, en, tr }
  maintenance_until timestamptz,

  -- Links -----------------------------------------------------------------
  support_url text,
  status_page_url text,
  privacy_url text,
  terms_url text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.macos_app_settings TO service_role;
ALTER TABLE public.macos_app_settings ENABLE ROW LEVEL SECURITY;

-- Platform-wide singleton, as desktop_app_settings.
CREATE UNIQUE INDEX IF NOT EXISTS macos_app_settings_singleton_idx
  ON public.macos_app_settings ((true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_channel_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_channel_chk CHECK (update_channel IN ('stable', 'beta'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_check_interval_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_check_interval_chk CHECK (update_check_interval_minutes BETWEEN 15 AND 1440);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_poll_interval_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_poll_interval_chk CHECK (poll_interval_seconds BETWEEN 5 AND 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_poll_realtime_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_poll_realtime_chk CHECK (poll_interval_realtime_seconds BETWEEN 15 AND 900);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_language_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_language_chk CHECK (default_language IN ('system', 'fa', 'en', 'tr'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'macos_app_settings_appearance_chk') THEN
    ALTER TABLE public.macos_app_settings
      ADD CONSTRAINT macos_app_settings_appearance_chk CHECK (default_appearance IN ('system', 'light', 'dark'));
  END IF;
END $$;

INSERT INTO public.macos_app_settings (update_channel)
SELECT 'stable'
WHERE NOT EXISTS (SELECT 1 FROM public.macos_app_settings);

-- Per-platform targeting for ads and announcements ------------------------

ALTER TABLE public.desktop_app_campaigns
  ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_campaigns_platforms_chk') THEN
    ALTER TABLE public.desktop_app_campaigns
      ADD CONSTRAINT desktop_app_campaigns_platforms_chk
      CHECK (platforms <@ ARRAY['windows', 'macos']::text[]);
  END IF;
END $$;
