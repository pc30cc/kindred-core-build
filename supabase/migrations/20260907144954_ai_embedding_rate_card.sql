-- AI billing — publish the missing rate card for the embedding model.
--
-- The website-crawl / KB-indexing / operator-assist embedding path
-- (server/services/ai-agent/embeddings/openai.ts) has always called
-- OpenAI's text-embedding-3-small in production, but no ai_rate_cards row
-- ever existed for it — only the chat completion model (openai/gpt-5-nano)
-- had one. Under METER_ONLY this meant embedding usage was silently never
-- priced or logged (confirmed empty in ai_usage_events); under ENFORCED it
-- would throw billing_rate_not_configured on every embedding call. This
-- closes that gap with the real, current OpenAI price ($0.02 / 1M tokens,
-- input-only — embeddings have no output-token component).
--
-- Uses the existing ai_publish_rate_card() admin RPC (see
-- database/migrations/073_ai_usage_billing.sql) so versioning, the
-- ai_models catalog entry and the audit log entry are all handled the same
-- way a platform admin publishing a price through /admin/pricing/rate-cards
-- would get. Guarded to be a no-op if an active card already exists (e.g.
-- this was already applied directly to the live project before this
-- migration file was written).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_rate_cards
    WHERE provider = 'openai' AND model_key = 'text-embedding-3-small' AND effective_to IS NULL
  ) THEN
    PERFORM public.ai_publish_rate_card(
      'openai',
      'text-embedding-3-small',
      'USD',
      '[{"component_type":"EMBEDDING_TOKENS","unit":"TOKEN","unit_amount":"0.02","per_units":"1000000"}]'::jsonb,
      NULL,
      'Official OpenAI pricing ($0.02 / 1M tokens), verified against multiple independent pricing sources.'
    );
  END IF;
END $$;
