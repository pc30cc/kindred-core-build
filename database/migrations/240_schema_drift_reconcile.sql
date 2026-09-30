-- Schema drift reconcile: columns the server reads and writes that no
-- migration in either chain created.
--
-- The production database has every column below (added outside the
-- migration chains), so the code works there. A database built from the
-- migrations alone does not, and the failures are silent:
--
--   * widget_settings.offline_message — server/services/widget/availability.ts
--     selects it together with business_hours / offline_mode /
--     availability_labels / live_chat_enabled. PostgREST rejects the whole
--     select (42703), the error is dropped, and the widget runs with no
--     business hours, no offline mode and default labels.
--   * widget_settings.placeholder_text / show_logo / fab_label / fab_scale /
--     fab_icon — written by PATCH /api/widget-settings; saving any of them
--     failed.
--   * visitor_sessions.geo_* — server/services/geo/index.ts writes the
--     resolved location and visitors/networkProfile.ts reads it back; the
--     write failed, so every request re-resolved and nothing was stored.
--
-- Two columns go the other way — defined by this chain's own migrations but
-- absent from production — and are re-asserted here so the next time this
-- chain is applied the database catches up:
--   * widget_settings.show_powered_by — written by PATCH /api/widget-settings
--     and read by the widget config (routes/widget.ts).
--   * call_center_settings.widget_template_id — read and written by the call
--     widget routes.
--
-- Definitions are copied from the production catalog. ADD COLUMN IF NOT
-- EXISTS makes this a no-op wherever a column already exists.

ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS offline_message text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS placeholder_text text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS show_logo boolean DEFAULT true;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_label text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_scale integer DEFAULT 100;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_icon text DEFAULT 'chat'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_icon_color text DEFAULT '#ffffff'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_text_color text DEFAULT '#ffffff'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_shape text DEFAULT 'circle'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_animation boolean DEFAULT true;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_chat_label text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_help_label text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS fab_help_icon text DEFAULT 'help_circle'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS greeting_message text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS secondary_color text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS theme text DEFAULT 'modern'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS mobile_behavior text DEFAULT 'bottom_sheet'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS widget_language text DEFAULT 'auto'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS default_mode text DEFAULT 'chat'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS support_mode text DEFAULT 'human_first'::text;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS auto_open_delay integer DEFAULT 0;
ALTER TABLE public.widget_settings ADD COLUMN IF NOT EXISTS show_powered_by boolean DEFAULT true;

ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_country_code text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_country_name text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_region text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_city text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_latitude double precision;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_longitude double precision;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_timezone text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_accuracy_level text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_source_provider text;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_is_fallback boolean;
ALTER TABLE public.visitor_sessions ADD COLUMN IF NOT EXISTS geo_resolved_at timestamptz;

ALTER TABLE public.call_center_settings ADD COLUMN IF NOT EXISTS widget_template_id text NOT NULL DEFAULT 'default'::text;
