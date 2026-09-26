-- Hosted mirror of database/migrations/221_brin_created_at_indexes.sql:
-- BRIN indexes on conversation_messages.created_at and
-- conversations.created_at for the business rollup's time-range scans.
--
-- This chain runs each file inside a transaction, where CREATE INDEX
-- CONCURRENTLY is not allowed — and a plain CREATE INDEX blocks every insert
-- into the table while it builds. A BRIN build is one sequential pass, so on
-- a small table that is a moment; on a large one it would stall messages.
-- So: build here only below 256 MB of table data, and otherwise leave it to
-- the self-host chain's CONCURRENTLY build, or run by hand:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_messages_created_brin
--     ON public.conversation_messages USING brin (created_at);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_created_brin
--     ON public.conversations USING brin (created_at);

DO $$
DECLARE
  v_table text;
  v_index text;
  v_bytes bigint;
BEGIN
  FOR v_table, v_index IN
    VALUES ('conversation_messages', 'idx_conversation_messages_created_brin'),
           ('conversations', 'idx_conversations_created_brin')
  LOOP
    IF to_regclass('public.' || v_index) IS NOT NULL THEN
      CONTINUE;
    END IF;
    v_bytes := pg_relation_size(('public.' || v_table)::regclass);
    IF v_bytes < 256 * 1024 * 1024 THEN
      EXECUTE format('CREATE INDEX %I ON public.%I USING brin (created_at)', v_index, v_table);
    ELSE
      RAISE NOTICE '%: % of data — build % by hand with CREATE INDEX CONCURRENTLY (see this file''s header)',
        v_table, pg_size_pretty(v_bytes), v_index;
    END IF;
  END LOOP;
END;
$$;
