-- Visitor Intelligence: optional raw IP storage (workspace-level toggle).
-- Default OFF so privacy-safe behavior is preserved on existing workspaces.
-- When enabled, server may persist the raw client IP on visitor_sessions.ip_raw
-- (still only ever returned to owner/admin via role-gated APIs).

ALTER TABLE public.widget_settings
  ADD COLUMN IF NOT EXISTS store_raw_ip boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.widget_settings.store_raw_ip IS
  'Privacy toggle. When TRUE, the server stores the raw visitor IP on visitor_sessions.ip_raw (still only exposed to owner/admin roles). Default FALSE — only the salted ip_hash is stored.';

ALTER TABLE public.visitor_sessions
  ADD COLUMN IF NOT EXISTS ip_raw text;

COMMENT ON COLUMN public.visitor_sessions.ip_raw IS
  'Optional raw client IP. Populated only when widget_settings.store_raw_ip = true for the workspace. Never returned to non-admin roles.';
