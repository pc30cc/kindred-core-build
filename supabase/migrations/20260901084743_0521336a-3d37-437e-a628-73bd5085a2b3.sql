-- Canonical DB-trigger writers for workspace usage counters.
-- Counters are attributed to the period of the row's own created_at,
-- so late-arriving rows never land in the wrong month.

CREATE OR REPLACE FUNCTION public.bump_usage_counter_for(
  _workspace_id uuid,
  _counter_name text,
  _amount integer,
  _at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _period text;
BEGIN
  IF _workspace_id IS NULL THEN RETURN; END IF;
  _period := to_char(COALESCE(_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM');

  INSERT INTO workspace_usage_counters (workspace_id, period)
  VALUES (_workspace_id, _period)
  ON CONFLICT (workspace_id, period) DO NOTHING;

  EXECUTE format(
    'UPDATE workspace_usage_counters SET %I = COALESCE(%I,0) + $1, updated_at = now() WHERE workspace_id = $2 AND period = $3',
    _counter_name, _counter_name
  ) USING _amount, _workspace_id, _period;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_conversations_count_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.bump_usage_counter_for(NEW.workspace_id, 'conversations_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_count_conversation ON public.conversations;
CREATE TRIGGER trg_conversations_count_conversation
AFTER INSERT ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.tg_conversations_count_conversation();

CREATE OR REPLACE FUNCTION public.tg_conversation_messages_count_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _ws uuid;
BEGIN
  SELECT workspace_id INTO _ws FROM public.conversations WHERE id = NEW.conversation_id;
  PERFORM public.bump_usage_counter_for(_ws, 'messages_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_messages_count_message ON public.conversation_messages;
CREATE TRIGGER trg_conversation_messages_count_message
AFTER INSERT ON public.conversation_messages
FOR EACH ROW EXECUTE FUNCTION public.tg_conversation_messages_count_message();

CREATE OR REPLACE FUNCTION public.tg_ai_usage_logs_count_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.bump_usage_counter_for(NEW.workspace_id, 'ai_requests_count', 1, NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ai_usage_logs_count_request ON public.ai_usage_logs;
CREATE TRIGGER trg_ai_usage_logs_count_request
AFTER INSERT ON public.ai_usage_logs
FOR EACH ROW EXECUTE FUNCTION public.tg_ai_usage_logs_count_request();