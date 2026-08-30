-- 061_widget_conversation_reads.sql
--
-- Visitor-side read markers for the chat widget's conversation list.
--
-- The widget list view renders a real unread badge per conversation. Unread
-- is computed as: inbound messages (operator / ai / bot / system) created
-- after this visitor's last_read_at for that thread. The pre-existing
-- conversation_messages.seen_at column is the OPPOSITE direction (an
-- operator marking a visitor's message seen) and cannot serve this purpose,
-- hence a dedicated marker table.
--
-- `visitor_id` is always the value carried by the signed HttpOnly `dvsid`
-- cookie, resolved server-side. It is NEVER accepted from a request body or
-- query string, so a tampered client-supplied id cannot read or write
-- another visitor's markers.
--
-- Access: Express (service_role) only. Neither `anon` nor `authenticated`
-- get any privilege — there is no legitimate PostgREST consumer.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.widget_conversation_reads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  visitor_id       text NOT NULL,
  last_read_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Upsert target for POST /api/widget/conversations/:id/read
CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_conversation_reads_unique
  ON public.widget_conversation_reads (conversation_id, visitor_id);
CREATE INDEX IF NOT EXISTS idx_widget_conversation_reads_visitor
  ON public.widget_conversation_reads (workspace_id, visitor_id);

REVOKE ALL ON public.widget_conversation_reads FROM PUBLIC;
REVOKE ALL ON public.widget_conversation_reads FROM anon;
REVOKE ALL ON public.widget_conversation_reads FROM authenticated;
GRANT ALL ON public.widget_conversation_reads TO service_role;

ALTER TABLE public.widget_conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages widget conversation reads" ON public.widget_conversation_reads;
CREATE POLICY "Service role manages widget conversation reads"
  ON public.widget_conversation_reads FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_updated_at_generic()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$fn$;

DROP TRIGGER IF EXISTS trg_widget_conversation_reads_touch ON public.widget_conversation_reads;
CREATE TRIGGER trg_widget_conversation_reads_touch
  BEFORE UPDATE ON public.widget_conversation_reads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_generic();
