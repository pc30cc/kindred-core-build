ALTER TABLE public.knowledge_base_articles
  ADD COLUMN IF NOT EXISTS visible_in_widget boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS used_by_ai boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS knowledge_base_articles_widget_idx
  ON public.knowledge_base_articles (workspace_id, visible_in_widget)
  WHERE visible_in_widget = true;

CREATE INDEX IF NOT EXISTS knowledge_base_articles_ai_idx
  ON public.knowledge_base_articles (workspace_id, used_by_ai)
  WHERE used_by_ai = true;