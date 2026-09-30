-- Public self-signup on/off switch (Super Admin → Core settings → Signup).
--
-- Self-host mirror: database/migrations/238_signup_enabled.sql
-- (functionally identical; registered in
-- src/test/integration/migrationMirrorParity.test.ts).

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS signup_enabled boolean NOT NULL DEFAULT true;
