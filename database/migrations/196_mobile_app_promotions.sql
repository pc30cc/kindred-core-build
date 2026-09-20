-- ============================================================
-- 196 — IN-APP PROMOTIONS FOR THE NATIVE APP (iOS)
--
-- Adds the creative and the pacing rules for first-party promotional content
-- shown inside the iOS app to the existing `mobile_app_settings` singleton.
-- Same table, same service_role-only posture: written from Super Admin →
-- Mobile App → Promotions, read by the Express backend when the app asks what
-- to show.
--
-- WHAT THIS IS NOT: an ad network. No SDK, no auction, no device identifier,
-- no impression beacon. The platform writes the words and the picture; the
-- app draws them. That is the difference between this and something that
-- would need App Tracking Transparency (guideline 5.1.2) and a privacy
-- manifest entry for tracking.
--
-- WHO SEES ONE is not decided here. That is a plan question, answered by
-- `mobile_promo_banner` and `mobile_promo_fullscreen` in the capability
-- registry, so a Free plan can carry promotions while every paid plan does
-- not — or any other arrangement an operator configures in Super Admin →
-- Plans.
--
-- Every column ships off or empty, so applying this file changes nothing
-- until somebody writes a creative and a plan turns it on.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  -- The platform master switch. Off means no promotion is served to anyone,
  -- whatever the plans say.
  ADD COLUMN IF NOT EXISTS ads_enabled boolean NOT NULL DEFAULT false,

  -- `{ "cta_url": "...", "image_url": "...",
  --    "text": { "en": { "title": "", "body": "", "cta_label": "" },
  --              "fa": { ... }, "tr": { ... } } }`
  --
  -- The text is per locale because the app is trilingual and a promotion in
  -- the wrong language is worse than none.
  ADD COLUMN IF NOT EXISTS ads_banner jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ads_fullscreen jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Pacing. The full-screen promotion is the intrusive one, so it is the one
  -- these bound: never twice within the interval, never more than the daily
  -- cap, and never during the first few launches of the app.
  ADD COLUMN IF NOT EXISTS ads_min_interval_minutes integer NOT NULL DEFAULT 360,
  ADD COLUMN IF NOT EXISTS ads_max_per_day integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS ads_start_after_launches integer NOT NULL DEFAULT 2,

  -- A promotion whose button leaves the app for a page where a subscription
  -- can be bought needs Apple's External Purchase Link Entitlement
  -- (guidelines 3.1.1 and 3.1.3). Until a human confirms that is in order,
  -- the backend serves the creative with its link stripped rather than
  -- trusting whatever URL was typed.
  ADD COLUMN IF NOT EXISTS ads_external_link_acknowledged boolean NOT NULL DEFAULT false;

-- Guarded so the file can be applied twice: `ADD CONSTRAINT` has no
-- `IF NOT EXISTS`, and a migration that only runs once is a migration waiting
-- to break a re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_ads_interval_sane'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_ads_interval_sane
        CHECK (ads_min_interval_minutes BETWEEN 0 AND 10080);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_ads_cap_sane'
  ) THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_ads_cap_sane
        CHECK (ads_max_per_day BETWEEN 0 AND 20);
  END IF;
END $$;

COMMENT ON COLUMN public.mobile_app_settings.ads_enabled IS
  'Platform master switch for first-party in-app promotions on iOS. Plans decide who sees them.';
COMMENT ON COLUMN public.mobile_app_settings.ads_external_link_acknowledged IS
  'A human has confirmed any external promotion link complies with App Store guidelines 3.1.1/3.1.3. Without it the backend strips the link.';
