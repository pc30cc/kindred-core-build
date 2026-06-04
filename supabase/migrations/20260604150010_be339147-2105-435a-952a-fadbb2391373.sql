ALTER TABLE public.platform_call_center_settings
  ADD COLUMN IF NOT EXISTS callback_show_when_online boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS callback_min_seconds_between_requests integer NOT NULL DEFAULT 600,
  ADD COLUMN IF NOT EXISTS callback_max_per_ip_per_hour integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS callback_require_contact boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS callback_min_message_length integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_honeypot_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS callback_min_form_seconds integer NOT NULL DEFAULT 3;