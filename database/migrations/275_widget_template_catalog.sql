-- 275 — Chat widget templates: the Super Admin's catalog per edition, each
-- workspace's choice and its template options; KB article feedback gains a
-- neutral answer.
--
-- 1. widget_edition_settings: one row per edition (iran, international), like
--    billing_settings (259). `chat_templates` is Super Admin → Widget
--    settings → Widget templates: which of the chat widget templates the
--    edition ships (shared/widgetTemplates.ts `offered`) workspaces may wear,
--    their display names per dashboard language, their order, their option
--    defaults, and the default one:
--      {"default": "default",
--       "items": {"default": {"enabled": true, "order": 0, "name": {"fa": "…"}},
--                 "t1": {"enabled": true, "order": 1, "name": {"en": "…"},
--                        "options": {"navStyle": "vb", "navMode": "active"}}}}
--    Which ids, options and values exist is decided by the code
--    (shared/chatTemplateCatalog.ts), and the write route
--    (PUT /api/admin/widget-catalog) accepts only those, so a new template
--    needs no migration. An edition without a row, and a template missing
--    from `items`, read as the code's defaults: only the edition's default
--    template enabled, i.e. the widget exactly as it is today. Display names
--    live only here (dashboard-only, never in the widget config): template
--    ids and file names are neutral and permanent.
-- 2. widget_settings.widget_template_id: the workspace's choice (Widget →
--    Appearance). NULL (every row today) = the catalog's default. A choice the
--    Super Admin disables later is kept and worn again once re-enabled;
--    meanwhile its visitors get the default. The check only keeps it a short
--    slug (the shape server/services/widget/presentationAssets.ts accepts).
--    widget_settings.widget_template_options: the workspace's template
--    options (bottom-menu style, topics, ask examples), one flat object
--    validated by the code; `{}` = the catalog's defaults.
-- 3. kb_article_feedback.rating also accepts 'neutral' (a third answer the
--    help article's feedback row can give).
--
-- widget_edition_settings is server-only: service_role alone may read or write
-- it. No row is seeded. Re-runnable: every step is guarded or a no-op the
-- second time, so a statement stopped by lock_timeout is simply run again.
-- Dry run: the file inside BEGIN … ROLLBACK. Drops no data; touches no
-- archive schema or table.

-- ─── 1. The Super Admin's catalog, per edition ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_edition_settings (
  edition         text PRIMARY KEY,
  chat_templates  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_edition_settings_edition_check') THEN
    ALTER TABLE public.widget_edition_settings
      ADD CONSTRAINT widget_edition_settings_edition_check CHECK (edition IN ('iran', 'international'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_edition_settings_chat_templates_check') THEN
    ALTER TABLE public.widget_edition_settings
      ADD CONSTRAINT widget_edition_settings_chat_templates_check
      CHECK (jsonb_typeof(chat_templates) = 'object' AND octet_length(chat_templates::text) <= 16384);
  END IF;
END $$;

COMMENT ON TABLE public.widget_edition_settings IS
  'Super Admin widget settings per edition (iran, international). chat_templates: the chat widget template catalog (enabled, display names, order, option defaults, default). Server-only. Migration 275.';

DO $$
BEGIN
  ALTER TABLE public.widget_edition_settings ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.widget_edition_settings FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.widget_edition_settings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.widget_edition_settings FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.widget_edition_settings TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'widget_edition_settings' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.widget_edition_settings
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $$;

-- ─── 2. The workspace's choice and options ────────────────────────────────
-- One statement: widget_settings is read on every widget request, so its
-- ACCESS EXCLUSIVE lock is queued for once (not once per column and check),
-- and the columns never exist without their checks. Both columns are
-- metadata-only additions (NULL, a constant default); the checks scan a
-- table of one row per workspace.
DO $$
BEGIN
  ALTER TABLE public.widget_settings
    ADD COLUMN IF NOT EXISTS widget_template_id text,
    ADD COLUMN IF NOT EXISTS widget_template_options jsonb NOT NULL DEFAULT '{}'::jsonb;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_settings_widget_template_id_check') THEN
    ALTER TABLE public.widget_settings
      ADD CONSTRAINT widget_settings_widget_template_id_check
      CHECK (widget_template_id IS NULL OR widget_template_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_settings_widget_template_options_check') THEN
    ALTER TABLE public.widget_settings
      ADD CONSTRAINT widget_settings_widget_template_options_check
      CHECK (jsonb_typeof(widget_template_options) = 'object' AND octet_length(widget_template_options::text) <= 8192);
  END IF;
END $$;

COMMENT ON COLUMN public.widget_settings.widget_template_id IS
  'The chat widget template the workspace chose (Widget → Appearance); NULL = the catalog''s default. Worn only while the Super Admin keeps it enabled (widget_edition_settings.chat_templates) and the plan allows widget_appearance. Migration 275.';
COMMENT ON COLUMN public.widget_settings.widget_template_options IS
  'The workspace''s chat widget template options (navStyle, navMode, topics, askExamples), validated by shared/chatTemplateCatalog.ts; {} = the catalog''s defaults. Migration 275.';

-- ─── 3. KB article feedback: a neutral answer ─────────────────────────────
-- One statement (drop and re-add together), so the table is never without
-- its check; skipped once the check already accepts 'neutral'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'kb_article_feedback_rating_chk'
       AND conrelid = 'public.kb_article_feedback'::regclass
       AND pg_get_constraintdef(oid) LIKE '%neutral%'
  ) THEN
    ALTER TABLE public.kb_article_feedback DROP CONSTRAINT IF EXISTS kb_article_feedback_rating_chk;
    ALTER TABLE public.kb_article_feedback
      ADD CONSTRAINT kb_article_feedback_rating_chk CHECK (rating IN ('up', 'neutral', 'down'));
  END IF;
END $$;
