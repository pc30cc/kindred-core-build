-- ── 060: Knowledge Base article feedback (thumbs up / down) ─────────────
CREATE TABLE IF NOT EXISTS public.kb_article_feedback (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  article_id          uuid NOT NULL REFERENCES public.knowledge_base_articles(id) ON DELETE CASCADE,
  visitor_session_id  uuid REFERENCES public.visitor_sessions(id) ON DELETE SET NULL,
  rating              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.kb_article_feedback
    ADD CONSTRAINT kb_article_feedback_rating_chk CHECK (rating IN ('up','down'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_article_feedback_unique_vote
  ON public.kb_article_feedback (article_id, visitor_session_id)
  WHERE visitor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_article_feedback_article
  ON public.kb_article_feedback (article_id, rating);
CREATE INDEX IF NOT EXISTS idx_kb_article_feedback_workspace
  ON public.kb_article_feedback (workspace_id, created_at DESC);

GRANT SELECT ON public.kb_article_feedback TO authenticated;
GRANT ALL ON public.kb_article_feedback TO service_role;

ALTER TABLE public.kb_article_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view KB article feedback" ON public.kb_article_feedback;
CREATE POLICY "Members can view KB article feedback"
  ON public.kb_article_feedback FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role manages KB article feedback" ON public.kb_article_feedback;
CREATE POLICY "Service role manages KB article feedback"
  ON public.kb_article_feedback FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 061: Visitor-side read markers (real unread badges in the widget) ───
-- visitor_id is the value carried by the signed HttpOnly `dvsid` cookie;
-- it is never accepted from the client body/query.
CREATE TABLE IF NOT EXISTS public.widget_conversation_reads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  visitor_id       text NOT NULL,
  last_read_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_conversation_reads_unique
  ON public.widget_conversation_reads (conversation_id, visitor_id);
CREATE INDEX IF NOT EXISTS idx_widget_conversation_reads_visitor
  ON public.widget_conversation_reads (workspace_id, visitor_id);

-- Written and read only through the Express service-role boundary; no
-- anon/authenticated PostgREST access at all.
REVOKE ALL ON public.widget_conversation_reads FROM PUBLIC;
REVOKE ALL ON public.widget_conversation_reads FROM anon;
REVOKE ALL ON public.widget_conversation_reads FROM authenticated;
GRANT ALL ON public.widget_conversation_reads TO service_role;

ALTER TABLE public.widget_conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages widget conversation reads" ON public.widget_conversation_reads;
CREATE POLICY "Service role manages widget conversation reads"
  ON public.widget_conversation_reads FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_updated_at_generic()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$;

DROP TRIGGER IF EXISTS trg_kb_article_feedback_touch ON public.kb_article_feedback;
CREATE TRIGGER trg_kb_article_feedback_touch
  BEFORE UPDATE ON public.kb_article_feedback
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_generic();

DROP TRIGGER IF EXISTS trg_widget_conversation_reads_touch ON public.widget_conversation_reads;
CREATE TRIGGER trg_widget_conversation_reads_touch
  BEFORE UPDATE ON public.widget_conversation_reads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_generic();

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.kb_article_feedback') IS NULL THEN
    RAISE EXCEPTION '060: public.kb_article_feedback was not created';
  END IF;
  IF to_regclass('public.widget_conversation_reads') IS NULL THEN
    RAISE EXCEPTION '061: public.widget_conversation_reads was not created';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.kb_article_feedback', 'INSERT') THEN
    RAISE EXCEPTION '060: service_role lacks INSERT on kb_article_feedback';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.widget_conversation_reads', 'INSERT') THEN
    RAISE EXCEPTION '061: service_role lacks INSERT on widget_conversation_reads';
  END IF;
  IF has_table_privilege('authenticated', 'public.widget_conversation_reads', 'SELECT') THEN
    RAISE EXCEPTION '061: authenticated unexpectedly can read widget_conversation_reads';
  END IF;
END
$verify$;