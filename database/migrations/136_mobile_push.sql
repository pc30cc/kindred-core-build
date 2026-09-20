-- ============================================================
-- NATIVE PUSH NOTIFICATIONS (FCM → APNs/iOS + Android)
--
-- Two tables, both service_role-only: they are read and written exclusively
-- by the Express backend (server/services/push/*). No RLS-facing exposure is
-- added, so no anon/authenticated GRANTs are issued.
--
--  * mobile_push_devices — one row per (user, device install). The FCM token
--    is the transport address, `device_id` is the stable install identity.
--    Token rotation UPSERTs the row instead of piling up duplicates, and a
--    token that reappears under a different user is re-owned (never left
--    pointing at the previous operator after logout/login).
--
--  * push_dispatch_log — idempotency + lightweight observability. The UNIQUE
--    key (workspace, user, dedupe_key) is what makes provider retries and
--    duplicate webhook callbacks produce at most ONE visible notification.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mobile_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  push_token text NOT NULL,
  device_id text NOT NULL,
  device_name text,
  app_version text,
  enabled boolean NOT NULL DEFAULT true,
  permission_status text,
  disabled_reason text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.mobile_push_devices TO service_role;
ALTER TABLE public.mobile_push_devices ENABLE ROW LEVEL SECURITY;

-- One row per install per user; one token can only ever belong to one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_push_devices_user_device
  ON public.mobile_push_devices (user_id, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_push_devices_token
  ON public.mobile_push_devices (push_token);
CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_active
  ON public.mobile_push_devices (user_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.push_dispatch_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  conversation_id uuid,
  message_id uuid,
  notification_type text NOT NULL,
  dedupe_key text NOT NULL,
  device_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'attempted',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.push_dispatch_log TO service_role;
ALTER TABLE public.push_dispatch_log ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_push_dispatch_log_dedupe
  ON public.push_dispatch_log (workspace_id, user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_push_dispatch_log_created
  ON public.push_dispatch_log (created_at DESC);

-- Server-enforced push policy, alongside the existing notification prefs.
--   push_scope: 'all' | 'assigned' | 'mentions' | 'none'
--   push_preview: false → privacy mode ("New message in Webyar")
ALTER TABLE public.user_notification_prefs
  ADD COLUMN IF NOT EXISTS push_scope text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS push_preview boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS push_internal_notes boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_notification_prefs_push_scope_check') THEN
    ALTER TABLE public.user_notification_prefs
      ADD CONSTRAINT user_notification_prefs_push_scope_check
      CHECK (push_scope IN ('all', 'assigned', 'mentions', 'none'));
  END IF;
END $$;
