
-- Phase 8D — Smart routing, SLA-aware queue, callbacks, operator readiness.
--
-- Strategy: extend the existing call_queue_entries table (no parallel queue),
-- add a tiny operator_call_availability table for live readiness, and add
-- callback_requests as a first-class fallback path. All RLS is enforced via
-- existing workspace membership / admin helpers.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Extend call_queue_entries with SLA + missed/callback states
-- ─────────────────────────────────────────────────────────────────────────

-- New states. The queue state column is a Postgres enum; add the new values.
ALTER TYPE public.call_queue_state ADD VALUE IF NOT EXISTS 'missed';
ALTER TYPE public.call_queue_state ADD VALUE IF NOT EXISTS 'callback_requested';

-- SLA / lifecycle telemetry
ALTER TABLE public.call_queue_entries
  ADD COLUMN IF NOT EXISTS missed_offer_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_offer_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS offer_timeout_seconds integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS sla_breached boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS callback_request_id uuid;

CREATE INDEX IF NOT EXISTS idx_call_queue_entries_offer_expires
  ON public.call_queue_entries (last_offer_expires_at)
  WHERE state = 'offered';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Operator call availability (per user, per workspace)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.operator_call_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- 'unavailable' | 'available_audio' | 'available_video' | 'available_both' | 'busy'
  status text NOT NULL DEFAULT 'unavailable',
  -- True only while the operator is actually on a call (server-managed).
  in_call boolean NOT NULL DEFAULT false,
  in_call_since timestamptz,
  active_call_session_id uuid,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_operator_call_avail_lookup
  ON public.operator_call_availability (workspace_id, status)
  WHERE status <> 'unavailable';

ALTER TABLE public.operator_call_availability ENABLE ROW LEVEL SECURITY;

-- Members can read availability inside their workspace (queue UI needs it).
CREATE POLICY "members read call availability"
  ON public.operator_call_availability
  FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Operators can write only their OWN row.
CREATE POLICY "operator writes own availability"
  ON public.operator_call_availability
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_workspace_member(workspace_id, auth.uid())
  );

CREATE POLICY "operator updates own availability"
  ON public.operator_call_availability
  FOR UPDATE
  USING (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_operator_call_avail_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operator_call_avail_updated_at ON public.operator_call_availability;
CREATE TRIGGER trg_operator_call_avail_updated_at
  BEFORE UPDATE ON public.operator_call_availability
  FOR EACH ROW
  EXECUTE FUNCTION public.set_operator_call_avail_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Callback requests — fallback path when live call isn't possible
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.callback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  visitor_session_id text,
  channel text NOT NULL DEFAULT 'audio', -- 'audio' | 'video'
  -- 'requested' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
  status text NOT NULL DEFAULT 'requested',
  contact_phone text,
  contact_email text,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  scheduled_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  handled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_workspace_status
  ON public.callback_requests (workspace_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_callback_requests_conversation
  ON public.callback_requests (conversation_id)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE public.callback_requests ENABLE ROW LEVEL SECURITY;

-- Workspace members can read all callbacks in their workspace.
CREATE POLICY "members read callbacks"
  ON public.callback_requests
  FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Workspace members can update callbacks (mark complete/cancel).
CREATE POLICY "members update callbacks"
  ON public.callback_requests
  FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

-- INSERT happens via service-role from the widget API (no RLS path needed).
-- For symmetry / future operator-initiated callbacks we allow members to insert.
CREATE POLICY "members insert callbacks"
  ON public.callback_requests
  FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.set_callback_requests_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_callback_requests_updated_at ON public.callback_requests;
CREATE TRIGGER trg_callback_requests_updated_at
  BEFORE UPDATE ON public.callback_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_callback_requests_updated_at();

-- Add the FK from queue → callback request (created after table exists).
ALTER TABLE public.call_queue_entries
  DROP CONSTRAINT IF EXISTS call_queue_entries_callback_request_fk;
ALTER TABLE public.call_queue_entries
  ADD CONSTRAINT call_queue_entries_callback_request_fk
  FOREIGN KEY (callback_request_id) REFERENCES public.callback_requests(id) ON DELETE SET NULL;
