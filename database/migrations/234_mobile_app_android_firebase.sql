-- ============================================================
-- THE ANDROID APP'S FIREBASE CLIENT CONFIGURATION
--
-- Hosted twin: supabase/migrations/20260928150000_mobile_app_android_firebase.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).
--
-- Push on Android needs the app to start Firebase with the project's client
-- identifiers — the four values of the `google-services.json` Firebase gives
-- for the package. Until now they could only be baked into a build, and no
-- published APK carried them, so no Android phone ever registered for push.
-- They are set here instead, in Super Admin → Mobile App → Android →
-- Identity, and read by the app from GET /api/mobile-app/config
-- (`firebase`), which keeps them and starts Firebase with them from then on:
--
--   • android_firebase_app_id      — mobilesdk_app_id, `1:<number>:android:<hex>`
--   • android_firebase_api_key     — the client API key, `AIza…`
--   • android_firebase_project_id  — project_info.project_id
--   • android_firebase_sender_id   — project_info.project_number
--
-- These are client identifiers, not credentials: every APK built with them
-- carries them in the clear, and Firebase restricts what they can do. The
-- server's FCM service account — the key that can actually send — stays in
-- the server environment (FIREBASE_SERVICE_ACCOUNT_JSON) and is never
-- stored here.
--
-- Additive and idempotent; nullable with no default, so applying this file
-- changes nothing until someone fills them in.
-- ============================================================

ALTER TABLE public.mobile_app_settings
  ADD COLUMN IF NOT EXISTS android_firebase_app_id text,
  ADD COLUMN IF NOT EXISTS android_firebase_api_key text,
  ADD COLUMN IF NOT EXISTS android_firebase_project_id text,
  ADD COLUMN IF NOT EXISTS android_firebase_sender_id text;
