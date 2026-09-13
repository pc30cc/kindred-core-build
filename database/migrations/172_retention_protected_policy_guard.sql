CREATE FUNCTION public.retention_validate_protected_policy() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF OLD.retention_mode = 'permanent' OR OLD.category IN ('financial','core') THEN
   IF NEW.retention_mode <> 'permanent' OR NEW.table_name IS DISTINCT FROM OLD.table_name OR NEW.policy_key IS DISTINCT FROM OLD.policy_key OR NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION 'retention_policy_protected';
   END IF;
  END IF;
 END IF;
 IF (NEW.category IN ('financial','core') OR left(NEW.table_name,8) = 'billing_' OR NEW.table_name = ANY(ARRAY['profiles','users','workspaces','accounts','account_members','conversations','conversation_messages','contacts','knowledge_base_articles','knowledge_base_categories','ai_agent_sources','ai_source_pages','ai_knowledge_chunks','ai_run_settlements','financial_settlements'])) AND NEW.retention_mode <> 'permanent' THEN
  RAISE EXCEPTION 'retention_table_protected';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.retention_validate_protected_policy() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retention_validate_protected_policy() TO service_role;
CREATE TRIGGER retention_validate_protected_policy BEFORE INSERT OR UPDATE ON public.data_retention_policies FOR EACH ROW EXECUTE FUNCTION public.retention_validate_protected_policy();