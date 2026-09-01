-- AI billing — versioned pricing/FX/policy rows are historical evidence for
-- past charges. Only closing an OPEN period (effective_to: NULL -> value) is
-- allowed; every other update and every delete is rejected.
CREATE OR REPLACE FUNCTION public.ai_billing_block_pricing_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append_only_pricing: % rows cannot be deleted', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'ai_rate_card_components' THEN
    RAISE EXCEPTION 'append_only_pricing: % rows cannot be updated', TG_TABLE_NAME;
  END IF;

  IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
     AND to_jsonb(NEW) - 'effective_to' = to_jsonb(OLD) - 'effective_to' THEN
    RETURN NEW; -- superseding an open version: the only legal update
  END IF;

  RAISE EXCEPTION 'append_only_pricing: % rows are immutable once published', TG_TABLE_NAME;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_billing_block_pricing_mutation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ai_rate_cards_append_only ON public.ai_rate_cards;
CREATE TRIGGER ai_rate_cards_append_only
  BEFORE UPDATE OR DELETE ON public.ai_rate_cards
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_pricing_mutation();

DROP TRIGGER IF EXISTS ai_rate_card_components_append_only ON public.ai_rate_card_components;
CREATE TRIGGER ai_rate_card_components_append_only
  BEFORE UPDATE OR DELETE ON public.ai_rate_card_components
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_pricing_mutation();

DROP TRIGGER IF EXISTS ai_exchange_rates_append_only ON public.ai_exchange_rates;
CREATE TRIGGER ai_exchange_rates_append_only
  BEFORE UPDATE OR DELETE ON public.ai_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_pricing_mutation();

DROP TRIGGER IF EXISTS ai_sell_policies_append_only ON public.ai_sell_policies;
CREATE TRIGGER ai_sell_policies_append_only
  BEFORE UPDATE OR DELETE ON public.ai_sell_policies
  FOR EACH ROW EXECUTE FUNCTION public.ai_billing_block_pricing_mutation();