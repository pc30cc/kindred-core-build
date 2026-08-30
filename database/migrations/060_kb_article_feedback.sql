-- 060_kb_article_feedback.sql
--
-- Knowledge Base article feedback (thumbs up / down), collected from the
-- widget's public help-article view. This is an EXTENSION of the existing
-- Knowledge Base (public.knowledge_base_articles) — not a new subsystem.
--
-- One (overwritable) vote per visitor session per article: a visitor
-- changing their mind re-votes via UPSERT rather than accumulating rows.
-- Anonymous feedback with no resolvable visitor session is still accepted
-- (visitor_session_id NULL) but is not de-duplicated, matching how the rest
-- of the widget treats sessionless visitors elsewhere in the schema.
--
-- Idempotent: safe to re-run.

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

-- One overwritable vote per visitor session per article. Sessionless votes
-- (visitor_session_id IS NULL) are intentionally excluded from this
-- uniqueness rule — NULL never equals NULL, so a plain UNIQUE index would
-- not collapse them anyway; the upsert path below only targets rows with a
-- resolved session id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_article_feedback_unique_vote
  ON public.kb_article_feedback (article_id, visitor_session_id)
  WHERE visitor_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_article_feedback_article
  ON public.kb_article_feedback (article_id, rating);
CREATE INDEX IF NOT EXISTS idx_kb_article_feedback_workspace
  ON public.kb_article_feedback (workspace_id, created_at DESC);

-- ── Grants ──────────────────────────────────────────────────────────────
-- service_role: full access — the widget feedback endpoint and the KB
-- article aggregate-count enrichment both run through the Express
-- service-role boundary (server/routes/widget.ts, server/routes/
-- knowledgeBase.ts), never over a direct anon/authenticated PostgREST
-- connection.
-- authenticated: SELECT only, matching knowledge_base_articles' own access
-- model — operators can read aggregate feedback for their workspace's
-- articles, but only the server (service_role) ever writes a vote.
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

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.kb_article_feedback') IS NULL THEN
    RAISE EXCEPTION '060: public.kb_article_feedback was not created';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.kb_article_feedback', 'INSERT') THEN
    RAISE EXCEPTION '060: service_role lacks INSERT on public.kb_article_feedback';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.kb_article_feedback', 'SELECT') THEN
    RAISE EXCEPTION '060: authenticated lacks SELECT on public.kb_article_feedback';
  END IF;
  IF has_table_privilege('authenticated', 'public.kb_article_feedback', 'INSERT') THEN
    RAISE EXCEPTION '060: authenticated unexpectedly has INSERT on public.kb_article_feedback';
  END IF;
  RAISE NOTICE '060: kb_article_feedback established';
END
$verify$;
