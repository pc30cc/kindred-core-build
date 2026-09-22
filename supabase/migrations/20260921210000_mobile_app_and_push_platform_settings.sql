-- ============================================================
-- THE TWO SINGLETONS THE HOSTED CHAIN NEVER LEARNED ABOUT
--
-- `mobile_app_settings` and `push_platform_settings` were added to the
-- self-host chain (195, 196) and applied to the hosted project by hand. They
-- were never mirrored here — so they exist in production and in every
-- self-hosted install, and a FRESH hosted deploy would have neither.
--
-- That is not an abstract gap. `server/services/mobileApp/*` reads the first
-- on every readiness check and `npm run ios:runtime-config`; the second is
-- read by `services/push/platformSettings.ts` before every notification is
-- composed, and by the whole of Super Admin → Notifications. A new hosted
-- environment would answer 404 to both and the admin console would show two
-- broken pages.
--
-- Found by replaying the whole hosted chain into an empty database and
-- diffing its tables against production: 319 relations against 308, and
-- these two were the only ones production had that the chain did not create.
-- (The thirteen the other way are the Live Monitoring tables this platform
-- deliberately dropped; their readers already latch the missing relation and
-- fall back, which is why nothing broke.)
--
-- Everything below is copied verbatim from 195 and 196, and every statement
-- is idempotent — applying it where the tables already exist changes
-- nothing.
-- ============================================================

-- ── Native app (iOS) settings ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mobile_app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity ------------------------------------------------------------
  app_name text NOT NULL DEFAULT 'Webyar',
  display_name text NOT NULL DEFAULT 'Webyar',
  bundle_id text NOT NULL DEFAULT 'com.webyar.app',
  apple_team_id text,
  apple_team_name text,
  apple_app_id text,              -- App Store Connect numeric "Apple ID"
  app_sku text,
  primary_language text NOT NULL DEFAULT 'en',

  -- Build ---------------------------------------------------------------
  marketing_version text NOT NULL DEFAULT '1.0.0',
  build_number integer NOT NULL DEFAULT 1,
  minimum_os_version text NOT NULL DEFAULT '14.0',
  device_family text NOT NULL DEFAULT 'iphone',      -- iphone | universal
  orientations text[] NOT NULL DEFAULT ARRAY['portrait']::text[],
  requires_full_screen boolean NOT NULL DEFAULT false,
  supports_dark_mode boolean NOT NULL DEFAULT true,
  url_scheme text,
  associated_domains text[] NOT NULL DEFAULT ARRAY[]::text[],
  build_configuration text NOT NULL DEFAULT 'Release',
  automatic_signing boolean NOT NULL DEFAULT true,
  provisioning_profile text,

  -- Capabilities / entitlements ------------------------------------------
  cap_push_notifications boolean NOT NULL DEFAULT true,
  cap_background_remote_notifications boolean NOT NULL DEFAULT true,
  cap_background_fetch boolean NOT NULL DEFAULT false,
  cap_associated_domains boolean NOT NULL DEFAULT false,
  cap_app_groups boolean NOT NULL DEFAULT false,
  app_group_id text,
  cap_keychain_sharing boolean NOT NULL DEFAULT false,
  cap_sign_in_with_apple boolean NOT NULL DEFAULT false,
  cap_camera boolean NOT NULL DEFAULT true,
  cap_microphone boolean NOT NULL DEFAULT true,
  cap_photo_library boolean NOT NULL DEFAULT true,
  cap_location boolean NOT NULL DEFAULT false,
  cap_face_id boolean NOT NULL DEFAULT false,

  -- Privacy strings (Info.plist NS*UsageDescription) ----------------------
  usage_camera text NOT NULL DEFAULT 'Webyar needs camera access so you can capture and send photos or videos in a conversation.',
  usage_microphone text NOT NULL DEFAULT 'Webyar needs microphone access so you can record and send voice messages to your customers.',
  usage_photo_library text NOT NULL DEFAULT 'Webyar needs photo library access so you can send images and videos in a conversation.',
  usage_photo_library_add text,
  usage_location text,
  usage_face_id text,
  usage_tracking text,

  -- Privacy / data policy --------------------------------------------------
  att_enabled boolean NOT NULL DEFAULT false,      -- App Tracking Transparency
  collects_data boolean NOT NULL DEFAULT true,
  uses_idfa boolean NOT NULL DEFAULT false,
  third_party_sdks jsonb NOT NULL DEFAULT '["Firebase Cloud Messaging"]'::jsonb,
  -- Apple privacy manifest (PrivacyInfo.xcprivacy): accessed API reasons +
  -- collected data types + tracking domains.
  privacy_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- App Store "App Privacy" nutrition labels.
  data_collection jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Store listing / legal URLs --------------------------------------------
  privacy_policy_url text,
  terms_url text,
  support_url text,
  marketing_url text,
  copyright text,
  primary_category text NOT NULL DEFAULT 'BUSINESS',
  secondary_category text,
  age_rating text NOT NULL DEFAULT '4+',
  contains_third_party_content boolean NOT NULL DEFAULT false,

  -- App Review -------------------------------------------------------------
  review_contact_name text,
  review_contact_email text,
  review_contact_phone text,
  review_notes text,
  demo_account_required boolean NOT NULL DEFAULT true,
  demo_account_username text,
  -- Deliberately NO demo password column: Apple's demo password belongs in
  -- App Store Connect, not in this database. The UI says so.
  demo_account_notes text,
  account_deletion_supported boolean NOT NULL DEFAULT true,
  account_deletion_url text,

  -- Export compliance (ITSAppUsesNonExemptEncryption) ---------------------
  uses_encryption boolean NOT NULL DEFAULT true,
  encryption_exempt boolean NOT NULL DEFAULT true,   -- HTTPS-only → exempt
  encryption_notes text,

  -- Release ---------------------------------------------------------------
  release_type text NOT NULL DEFAULT 'manual',       -- manual | automatic | scheduled
  phased_release boolean NOT NULL DEFAULT true,
  testflight_group text,
  release_notes text,

  -- Operator-acknowledged checklist items (key → {done, at, by}).
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.mobile_app_settings TO service_role;
ALTER TABLE public.mobile_app_settings ENABLE ROW LEVEL SECURITY;

-- Platform-wide singleton: two competing rows would make settings appear to
-- revert depending on which one an unordered read returned.
CREATE UNIQUE INDEX IF NOT EXISTS mobile_app_settings_singleton_idx
  ON public.mobile_app_settings ((true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_device_family_chk') THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_device_family_chk
      CHECK (device_family IN ('iphone', 'universal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_release_type_chk') THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_release_type_chk
      CHECK (release_type IN ('manual', 'automatic', 'scheduled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_build_number_chk') THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_build_number_chk
      CHECK (build_number >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_settings_age_rating_chk') THEN
    ALTER TABLE public.mobile_app_settings
      ADD CONSTRAINT mobile_app_settings_age_rating_chk
      CHECK (age_rating IN ('4+', '9+', '12+', '17+'));
  END IF;
END $$;

-- ── Push / notification platform policy ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Master switch. Off → dispatch is a no-op even with credentials present.
  push_enabled boolean NOT NULL DEFAULT true,

  -- Defaults applied to a user who has never touched their own prefs.
  default_scope text NOT NULL DEFAULT 'all',          -- all|assigned|mentions|none
  default_preview boolean NOT NULL DEFAULT true,
  default_internal_notes boolean NOT NULL DEFAULT true,
  default_sound boolean NOT NULL DEFAULT true,
  default_quiet_hours_enabled boolean NOT NULL DEFAULT false,
  default_quiet_hours_start text NOT NULL DEFAULT '22:00',
  default_quiet_hours_end text NOT NULL DEFAULT '08:00',
  default_quiet_hours_timezone text,
  mention_bypasses_quiet_hours boolean NOT NULL DEFAULT true,

  -- APNs delivery semantics (server/services/push/fcm.ts).
  apns_priority integer NOT NULL DEFAULT 10,
  apns_ttl_seconds integer NOT NULL DEFAULT 86400,
  interruption_level text NOT NULL DEFAULT 'active',  -- passive|active|time-sensitive|critical
  relevance_score numeric(3,2) NOT NULL DEFAULT 0.50,
  mutable_content boolean NOT NULL DEFAULT true,
  thread_id_strategy text NOT NULL DEFAULT 'conversation', -- conversation|workspace|none
  collapse_enabled boolean NOT NULL DEFAULT true,
  badge_enabled boolean NOT NULL DEFAULT true,
  sound_name text NOT NULL DEFAULT 'default',
  critical_alerts_enabled boolean NOT NULL DEFAULT false,
  critical_alert_volume numeric(3,2) NOT NULL DEFAULT 0.70,
  provisional_authorization boolean NOT NULL DEFAULT false,
  android_channel_id text NOT NULL DEFAULT 'webyar_messages',

  -- Guard rails.
  throttle_per_user_per_minute integer NOT NULL DEFAULT 20,
  dispatch_log_retention_days integer NOT NULL DEFAULT 30,

  -- iOS notification categories + their action buttons, and the per-event
  -- copy templates keyed by event type then locale.
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  templates jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.push_platform_settings TO service_role;
ALTER TABLE public.push_platform_settings ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS push_platform_settings_singleton_idx
  ON public.push_platform_settings ((true));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_platform_settings_scope_chk') THEN
    ALTER TABLE public.push_platform_settings
      ADD CONSTRAINT push_platform_settings_scope_chk
      CHECK (default_scope IN ('all', 'assigned', 'mentions', 'none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_platform_settings_interruption_chk') THEN
    ALTER TABLE public.push_platform_settings
      ADD CONSTRAINT push_platform_settings_interruption_chk
      CHECK (interruption_level IN ('passive', 'active', 'time-sensitive', 'critical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_platform_settings_thread_chk') THEN
    ALTER TABLE public.push_platform_settings
      ADD CONSTRAINT push_platform_settings_thread_chk
      CHECK (thread_id_strategy IN ('conversation', 'workspace', 'none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_platform_settings_priority_chk') THEN
    ALTER TABLE public.push_platform_settings
      ADD CONSTRAINT push_platform_settings_priority_chk
      CHECK (apns_priority IN (1, 5, 10));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_platform_settings_ttl_chk') THEN
    ALTER TABLE public.push_platform_settings
      ADD CONSTRAINT push_platform_settings_ttl_chk
      CHECK (apns_ttl_seconds BETWEEN 0 AND 2419200);
  END IF;
END $$;

-- The dispatch log gains the delivery detail the admin Notifications screen
-- shows per row (which device/platform, and why a send was suppressed).
ALTER TABLE public.push_dispatch_log
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS suppressed_reason text;

-- Delivery diagnostics are read "latest first, per workspace"; the existing
-- created_at index alone makes the workspace filter a full scan.
CREATE INDEX IF NOT EXISTS idx_push_dispatch_log_workspace_created
  ON public.push_dispatch_log (workspace_id, created_at DESC);


-- ── From 196: the in-app promotions the same settings row drives ──

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
