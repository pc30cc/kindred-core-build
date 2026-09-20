-- ============================================================
-- 195 — NATIVE MOBILE APP (iOS) + PUSH PLATFORM SETTINGS
--
-- Two platform-wide singletons, both service_role-only: they are read and
-- written exclusively by the Express backend (Super Admin → Mobile App and
-- Super Admin → Notifications). Nothing here is reachable from the browser
-- with an anon/authenticated key, so no RLS-facing GRANTs are issued.
--
--  * mobile_app_settings  — the single source of truth for everything the
--    native iOS shell and an App Store submission need: identity, build,
--    capabilities, privacy strings, App Store Connect metadata, export
--    compliance and release policy. `npm run ios:runtime-config` and the
--    readiness checks in server/services/mobileApp/* read this row; nothing
--    about the web build depends on it.
--
--  * push_platform_settings — platform-wide notification POLICY (defaults
--    for new users, APNs delivery semantics, iOS categories/actions and the
--    per-event copy templates). Credentials are NOT here: the FCM service
--    account stays in the server environment (server/services/push/fcm.ts),
--    which is why this table can be edited from an admin UI at all.
--
-- Both tables ship with defaults that reproduce today's hardcoded behaviour
-- exactly, so applying this file changes nothing until an operator edits a
-- value in Super Admin.
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
