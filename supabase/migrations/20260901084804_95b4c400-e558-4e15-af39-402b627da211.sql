REVOKE ALL ON FUNCTION public.bump_usage_counter_for(uuid, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_usage_counter_for(uuid, text, integer, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.tg_conversations_count_conversation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_conversation_messages_count_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_ai_usage_logs_count_request() FROM PUBLIC, anon, authenticated;