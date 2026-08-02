-- Plan-aware Knowledge Base access + neutral async indexing outbox.

CREATE OR REPLACE FUNCTION public.workspace_has_knowledge_base(_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF _workspace_id IS NULL THEN
    RETURN false;
  END IF;
  BEGIN
    result := public.check_module_access(_workspace_id, 'knowledge_base');
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  RETURN COALESCE((result->>'allowed')::boolean, false);
END;
$$;

REVOKE ALL ON FUNCTION public.workspace_has_knowledge_base(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workspace_has_knowledge_base(uuid) TO anon, authenticated, service_role;

-- Categories: split member-manage into read (member) + write (member AND plan)
DROP POLICY IF EXISTS "Members can manage KB categories" ON public.knowledge_base_categories;
DROP POLICY IF EXISTS "Public can read KB categories" ON public.knowledge_base_categories;

CREATE POLICY "Members can read KB categories"
  ON public.knowledge_base_categories FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members with plan can insert KB categories"
  ON public.knowledge_base_categories FOR INSERT TO authenticated
  WITH CHECK (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Members with plan can update KB categories"
  ON public.knowledge_base_categories FOR UPDATE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Members with plan can delete KB categories"
  ON public.knowledge_base_categories FOR DELETE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Public can read KB categories of entitled workspaces"
  ON public.knowledge_base_categories FOR SELECT TO anon
  USING (public.workspace_has_knowledge_base(workspace_id));

-- Articles
DROP POLICY IF EXISTS "Members can manage KB articles" ON public.knowledge_base_articles;
DROP POLICY IF EXISTS "Public can read published articles" ON public.knowledge_base_articles;

CREATE POLICY "Members can read KB articles"
  ON public.knowledge_base_articles FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members with plan can insert KB articles"
  ON public.knowledge_base_articles FOR INSERT TO authenticated
  WITH CHECK (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Members with plan can update KB articles"
  ON public.knowledge_base_articles FOR UPDATE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Members with plan can delete KB articles"
  ON public.knowledge_base_articles FOR DELETE TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())
    AND public.workspace_has_knowledge_base(workspace_id));

CREATE POLICY "Public can read published articles of entitled workspaces"
  ON public.knowledge_base_articles FOR SELECT TO anon
  USING (status = 'published' AND public.workspace_has_knowledge_base(workspace_id));

-- Neutral async indexing outbox (no AI coupling in the KB write path)
CREATE TABLE IF NOT EXISTS public.knowledge_base_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  article_id uuid,
  event_type text NOT NULL,
  locale text,
  status text,
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.knowledge_base_change_events TO service_role;

ALTER TABLE public.knowledge_base_change_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages KB change events"
  ON public.knowledge_base_change_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_kb_change_events_pending
  ON public.knowledge_base_change_events (created_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION public.knowledge_base_emit_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.knowledge_base_change_events (workspace_id, article_id, event_type, locale, status)
    VALUES (OLD.workspace_id, OLD.id, 'deleted', OLD.locale, OLD.status);
    RETURN OLD;
  END IF;

  INSERT INTO public.knowledge_base_change_events (workspace_id, article_id, event_type, locale, status)
  VALUES (NEW.workspace_id, NEW.id, LOWER(TG_OP), NEW.locale, NEW.status);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_articles_change_event ON public.knowledge_base_articles;
CREATE TRIGGER trg_kb_articles_change_event
AFTER INSERT OR UPDATE OR DELETE ON public.knowledge_base_articles
FOR EACH ROW EXECUTE FUNCTION public.knowledge_base_emit_change_event();