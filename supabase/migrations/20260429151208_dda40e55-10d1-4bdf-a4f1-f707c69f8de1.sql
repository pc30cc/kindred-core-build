-- Enable pgvector if available (safe no-op when already on)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.ai_knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('kb_article','qna','learned_qna','web_page','file','business_profile')),
  source_id text NOT NULL,
  source_url text,
  title text,
  content text NOT NULL,
  locale text,
  chunk_index integer NOT NULL DEFAULT 0,
  content_hash text NOT NULL,
  embedding vector(1536),
  embedding_provider text,
  embedding_model text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness: one row per (workspace, source, chunk_index)
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_chunks_unique_source
  ON public.ai_knowledge_chunks (workspace_id, source_type, source_id, chunk_index);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_ws_status_idx
  ON public.ai_knowledge_chunks (workspace_id, status);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_ws_locale_idx
  ON public.ai_knowledge_chunks (workspace_id, locale);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_hash_idx
  ON public.ai_knowledge_chunks (content_hash);

-- Vector index (best-effort; HNSW preferred). Wrapped in DO block so the
-- migration succeeds even if a particular pgvector version doesn't support it.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_hnsw
      ON public.ai_knowledge_chunks USING hnsw (embedding vector_cosine_ops)';
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_ivfflat
        ON public.ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pgvector ANN index could not be created: %', SQLERRM;
    END;
  END;
END $$;

-- updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS TRIGGER AS $f$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql SET search_path = public;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_ai_knowledge_chunks_updated_at ON public.ai_knowledge_chunks;
CREATE TRIGGER update_ai_knowledge_chunks_updated_at
  BEFORE UPDATE ON public.ai_knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: backend-only access via service role
ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated → effectively backend-only via service role
DROP POLICY IF EXISTS "ai_knowledge_chunks_no_client_access" ON public.ai_knowledge_chunks;
CREATE POLICY "ai_knowledge_chunks_no_client_access"
  ON public.ai_knowledge_chunks
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
