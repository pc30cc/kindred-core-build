-- 250 — what a database built from this chain alone still lacked against
-- production, found by running every `.select()` string in server/ and
-- worker/ against such a database.
--
-- 1. knowledge_base_articles → knowledge_base_categories had TWO foreign keys
--    here: 002's single-column `knowledge_base_articles_category_id_fkey` and
--    239's composite `knowledge_base_articles_category_workspace_fkey`. The
--    hosted chain replaced the first with the second (20260802100104, then
--    20260802193805, which moved ON DELETE behaviour into the
--    kb_categories_detach_articles trigger — present here too), so production
--    has exactly one. With two, PostgREST cannot tell which one an embed means
--    and answers PGRST201: `knowledge_base_categories(...)` in
--    server/routes/knowledgeBase.ts failed on every self-hosted database.
--    Dropped here, as the hosted chain did.
--
-- 2. pgvector. 239 creates the extension, ai_knowledge_chunks.embedding and its
--    HNSW index only when the extension is available at that moment; a
--    database that gets pgvector later (moved to an image that ships it)
--    never got the column, and every knowledge retrieval failed with 42703.
--    Re-asserted here, so the next migration run completes it wherever the
--    extension can be installed. Without pgvector it still skips, with a
--    notice: the rest of the product works, AI knowledge retrieval does not.
--
-- Idempotent; a no-op on production, which already has both.

DO $kb_fk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.knowledge_base_articles'::regclass
                AND conname = 'knowledge_base_articles_category_workspace_fkey') THEN
    ALTER TABLE public.knowledge_base_articles
      DROP CONSTRAINT IF EXISTS knowledge_base_articles_category_id_fkey;
  END IF;
END $kb_fk$;

DO $pgvector$
DECLARE s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'vector';
  IF s IS NULL THEN
    RAISE NOTICE '250: pgvector is not available on this server — ai_knowledge_chunks.embedding stays absent and AI knowledge retrieval will not work. Use a PostgreSQL image that ships pgvector (e.g. pgvector/pgvector:pg17) and run the migrations again.';
    RETURN;
  END IF;
  EXECUTE format($ddl$ALTER TABLE public.ai_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding %1$I.vector(1536)$ddl$, s);
  EXECUTE format($ddl$CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_hnsw ON public.ai_knowledge_chunks USING hnsw (embedding %1$I.vector_cosine_ops)$ddl$, s);
END $pgvector$;
