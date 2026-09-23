-- ============================================================
-- 207 — DESKTOP APP (WINDOWS) PLATFORM SETTINGS
--
-- A platform-wide singleton, service_role-only: it is read and written
-- exclusively by the Express backend (Super Admin → Desktop app, and the
-- public GET /api/platform/desktop-app the desktop app reads on launch).
-- Nothing here is reachable from the browser with an anon/authenticated
-- key, so no RLS-facing GRANTs are issued.
--
--  * desktop_app_settings — where the Windows app looks for updates
--    (electron-updater generic feed: the URL must serve the installer and
--    latest.yml), which channel it follows, the minimum version the
--    platform still supports, and runtime tuning (realtime on/off and the
--    polling intervals used as a fallback / safety net) plus feature
--    switches.
--
-- Defaults reproduce the values the desktop app used before this table
-- existed, so applying this file changes nothing until an operator edits a
-- value in Super Admin.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.desktop_app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Updates -------------------------------------------------------------
  update_feed_url text DEFAULT 'https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download',
  update_channel text NOT NULL DEFAULT 'stable',     -- stable | beta
  latest_version text,
  minimum_supported_version text,
  download_url text,
  release_notes text,
  auto_update_enabled boolean NOT NULL DEFAULT true,
  update_check_interval_minutes integer NOT NULL DEFAULT 240,

  -- Behaviour -----------------------------------------------------------
  realtime_enabled boolean NOT NULL DEFAULT true,
  -- Used when realtime is down (or disabled above).
  poll_interval_seconds integer NOT NULL DEFAULT 15,
  -- Safety-net polling while realtime is connected.
  poll_interval_realtime_seconds integer NOT NULL DEFAULT 120,
  calls_enabled boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.desktop_app_settings TO service_role;
ALTER TABLE public.desktop_app_settings ENABLE ROW LEVEL SECURITY;

-- Platform-wide singleton: two competing rows would make settings appear to
-- revert depending on which one an unordered read returned.
CREATE UNIQUE INDEX IF NOT EXISTS desktop_app_settings_singleton_idx
  ON public.desktop_app_settings ((true));

-- Guarded so the file can be applied twice: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_settings_channel_chk') THEN
    ALTER TABLE public.desktop_app_settings
      ADD CONSTRAINT desktop_app_settings_channel_chk
      CHECK (update_channel IN ('stable', 'beta'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_settings_check_interval_chk') THEN
    ALTER TABLE public.desktop_app_settings
      ADD CONSTRAINT desktop_app_settings_check_interval_chk
      CHECK (update_check_interval_minutes BETWEEN 15 AND 1440);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_settings_poll_interval_chk') THEN
    ALTER TABLE public.desktop_app_settings
      ADD CONSTRAINT desktop_app_settings_poll_interval_chk
      CHECK (poll_interval_seconds BETWEEN 5 AND 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'desktop_app_settings_poll_realtime_chk') THEN
    ALTER TABLE public.desktop_app_settings
      ADD CONSTRAINT desktop_app_settings_poll_realtime_chk
      CHECK (poll_interval_realtime_seconds BETWEEN 15 AND 900);
  END IF;
END $$;

-- Seed the single row so the admin screen and the public endpoint read real
-- values from the first request. The singleton index makes a re-run a no-op.
INSERT INTO public.desktop_app_settings (update_channel)
SELECT 'stable'
WHERE NOT EXISTS (SELECT 1 FROM public.desktop_app_settings);
