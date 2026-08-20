-- 018 — Canonical visitor-session relation for the Call Center.
--
-- `conversations`, `call_queue_entries` and `callback_requests` already point at
-- `visitor_sessions`, but `call_sessions` did not. Without it a call could only
-- be tied back to a visitor through the contact's *newest* session, which shows
-- the wrong IP/geo whenever the visitor has more than one session. This adds the
-- missing relation so every visitor-facing surface resolves the same session.
--
-- ROOT CAUSE FIX (found by independent review of a fresh, unexcluded
-- self-host chain application): this file's own ALTER TABLE below has
-- always assumed public.call_sessions already exists, and the backfill
-- UPDATE below it joins public.call_queue_entries — true on the hosted
-- chain (supabase/migrations/20260422123023_...sql creates call_sessions,
-- supabase/migrations/20260422211113_...sql creates call_queue_entries,
-- both long before supabase/migrations/20260808153714_...sql, this file's
-- hosted counterpart, runs), but FALSE on the self-host chain, which never
-- ported the Call Center's own base tables at all. Every self-host install
-- has therefore always failed here with "relation public.call_sessions
-- does not exist" — this file could never have successfully applied on
-- any self-host database, so there is no existing self-host Call Center
-- data this addition could conflict with.
--
-- Ported below (before the original ALTER logic), traced through every
-- hosted migration that ever touched either table
-- (20260422123023, 20260422211113, 20260422221658, 20260427110702,
-- 20260510211431, 20260511143550, 20260808153714 — the current, final
-- column/index/RLS/enum set as of all of them applied in order), scoped to
-- exactly what these two tables need to exist and to support the self-host
-- server code that already queries them (server/routes/callCenter.ts,
-- calls.ts, callWidget.ts, widgetCallInvitations.ts, and
-- server/services/calls/*, callCenter/*) — NOT the entire Call Center
-- feature surface (call_ratings, call_participants, call_recordings,
-- call_center_departments, call_invitations, etc. are separate tables,
-- untouched by this file, and out of scope for making 018 apply).
--
-- Two deliberate scope decisions, made explicit rather than left as silent
-- gaps:
--   * call_queue_entries.callback_request_id is kept as a plain,
--     unconstrained uuid (no FK to callback_requests). Hosted's FK target,
--     public.callback_requests, does not exist anywhere on this chain, and
--     no self-host-relevant server code path queries callback_requests —
--     porting the whole callback-request feature to satisfy one soft
--     reference column is out of scope for "make 018 apply."
--   * The hosted trg_call_sessions_bill_minutes trigger (added later, in
--     supabase/migrations/20260622180340_...sql) is NOT ported: it writes
--     to workspace_usage_counters.call_minutes_used, and
--     workspace_usage_counters does not exist anywhere on this chain —
--     same "no billing subsystem on self-host" scope boundary already
--     established for provision_account_on_signup's Trial-plan omission
--     in 039. The plain updated_at-touching triggers on both tables ARE
--     ported (no external dependency, and self-host server code relies on
--     them the same way it relies on widget_smart_rules' equivalent).
--
-- Every statement below is CREATE TYPE / CREATE TABLE IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS + CREATE POLICY /
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER — safe to re-run.

DO $enums$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_type') THEN
    CREATE TYPE public.call_type AS ENUM ('audio', 'video', 'screenshare', 'meeting');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_context_type') THEN
    CREATE TYPE public.call_context_type AS ENUM ('conversation', 'internal', 'verification');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_state') THEN
    CREATE TYPE public.call_state AS ENUM ('pending', 'ringing', 'connecting', 'active', 'ended', 'failed', 'cancelled', 'missed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_participant_type') THEN
    CREATE TYPE public.call_participant_type AS ENUM ('visitor', 'operator', 'admin', 'internal');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_recording_state') THEN
    CREATE TYPE public.call_recording_state AS ENUM ('disabled', 'pending', 'recording', 'finalizing', 'available', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_queue_channel') THEN
    CREATE TYPE public.call_queue_channel AS ENUM ('audio', 'video');
  END IF;
  -- All 7 values in one CREATE TYPE (hosted grew this to 7 across two
  -- later ALTER TYPE ADD VALUE statements — functionally identical to
  -- create it complete from the start on a chain with no pre-existing rows).
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_queue_state') THEN
    CREATE TYPE public.call_queue_state AS ENUM ('queued', 'offered', 'accepted', 'cancelled', 'expired', 'missed', 'callback_requested');
  END IF;
END $enums$;

CREATE TABLE IF NOT EXISTS public.call_sessions (
  id                          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id                UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider                    TEXT NOT NULL,
  provider_room_id            TEXT,
  call_type                   public.call_type NOT NULL,
  context_type                public.call_context_type NOT NULL,
  context_id                  UUID,
  state                       public.call_state NOT NULL DEFAULT 'pending',
  initiated_by                UUID,
  initiated_by_type           public.call_participant_type NOT NULL DEFAULT 'operator',
  started_at                  TIMESTAMPTZ,
  ended_at                    TIMESTAMPTZ,
  duration_seconds            INTEGER,
  recording_enabled           BOOLEAN NOT NULL DEFAULT false,
  recording_state             public.call_recording_state NOT NULL DEFAULT 'disabled',
  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_at                TIMESTAMPTZ,
  ended_by                    TEXT,
  ended_by_user_id            UUID,
  end_reason                  TEXT,
  entry_source                TEXT NOT NULL DEFAULT 'chat',
  subject                     TEXT,
  page_url                    TEXT,
  page_title                  TEXT,
  origin                      TEXT,
  direction                   TEXT NOT NULL DEFAULT 'inbound',
  visitor_name                TEXT,
  visitor_email                TEXT,
  visitor_phone               TEXT,
  wait_seconds                INT NOT NULL DEFAULT 0,
  department_id               UUID,
  assigned_agent_id           UUID,
  transfer_from_agent_id      UUID,
  transfer_to_agent_id        UUID,
  transfer_to_department_id   UUID,
  transfer_reason             TEXT,
  CONSTRAINT call_sessions_ended_by_check
    CHECK (ended_by IS NULL OR ended_by IN ('operator','visitor','system')),
  CONSTRAINT call_sessions_end_reason_check
    CHECK (end_reason IS NULL OR end_reason IN ('operator_ended','visitor_ended','system_ended','failed'))
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_workspace ON public.call_sessions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_context ON public.call_sessions (context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_state_active ON public.call_sessions (workspace_id, state) WHERE state IN ('pending','ringing','connecting','active');
CREATE INDEX IF NOT EXISTS idx_call_sessions_ws_entrysource_created ON public.call_sessions(workspace_id, entry_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_sessions_department ON public.call_sessions(workspace_id, department_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_assigned ON public.call_sessions(workspace_id, assigned_agent_id);

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_sessions_select_members" ON public.call_sessions;
CREATE POLICY "call_sessions_select_members"
  ON public.call_sessions FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );

CREATE OR REPLACE FUNCTION public.touch_call_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_sessions_updated_at ON public.call_sessions;
CREATE TRIGGER trg_call_sessions_updated_at
  BEFORE UPDATE ON public.call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_call_sessions_updated_at();

CREATE TABLE IF NOT EXISTS public.call_queue_entries (
  id                     UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel                public.call_queue_channel NOT NULL,
  state                  public.call_queue_state NOT NULL DEFAULT 'queued',
  visitor_session_id     UUID,
  contact_id             UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id        UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  call_session_id        UUID REFERENCES public.call_sessions(id) ON DELETE SET NULL,
  requested_by           TEXT NOT NULL DEFAULT 'visitor',
  priority               SMALLINT NOT NULL DEFAULT 0,
  position_hint          INT,
  offered_to_user_id     UUID,
  offered_at             TIMESTAMPTZ,
  accepted_at            TIMESTAMPTZ,
  ended_at               TIMESTAMPTZ,
  ended_reason           TEXT,
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  missed_offer_count     INTEGER NOT NULL DEFAULT 0,
  last_offer_expires_at  TIMESTAMPTZ,
  offer_timeout_seconds  INTEGER NOT NULL DEFAULT 25,
  sla_breached           BOOLEAN NOT NULL DEFAULT false,
  -- Deliberately no FK: public.callback_requests does not exist on this
  -- chain and is out of scope — see the top-of-file note.
  callback_request_id    UUID,
  entry_source           TEXT NOT NULL DEFAULT 'chat',
  department_id          UUID,
  assigned_agent_id      UUID,
  routing_mode           TEXT,
  routing_attempts       INTEGER NOT NULL DEFAULT 0,
  last_routing_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_call_queue_workspace_channel_state ON public.call_queue_entries (workspace_id, channel, state, created_at);
CREATE INDEX IF NOT EXISTS idx_call_queue_offered_to ON public.call_queue_entries (offered_to_user_id) WHERE state = 'offered';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_queue_per_visitor_channel ON public.call_queue_entries (workspace_id, visitor_session_id, channel) WHERE state IN ('queued', 'offered') AND visitor_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_queue_entries_offer_expires ON public.call_queue_entries (last_offer_expires_at) WHERE state = 'offered';
CREATE INDEX IF NOT EXISTS idx_call_queue_ws_entrysource_state ON public.call_queue_entries(workspace_id, entry_source, state);
CREATE INDEX IF NOT EXISTS idx_call_queue_department ON public.call_queue_entries(workspace_id, department_id);
CREATE INDEX IF NOT EXISTS idx_call_queue_assigned ON public.call_queue_entries(workspace_id, assigned_agent_id);

ALTER TABLE public.call_queue_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members read queue" ON public.call_queue_entries;
CREATE POLICY "Workspace members read queue"
  ON public.call_queue_entries FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = call_queue_entries.workspace_id
        AND wm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Workspace admins mutate queue" ON public.call_queue_entries;
CREATE POLICY "Workspace admins mutate queue"
  ON public.call_queue_entries FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = call_queue_entries.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE wm.workspace_id = call_queue_entries.workspace_id
        AND wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

CREATE OR REPLACE FUNCTION public.set_call_queue_entries_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS call_queue_entries_set_updated_at ON public.call_queue_entries;
CREATE TRIGGER call_queue_entries_set_updated_at
  BEFORE UPDATE ON public.call_queue_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_call_queue_entries_updated_at();

-- ---------- original 018 logic (visitor-session link) — unchanged below ----------

ALTER TABLE public.call_sessions
  ADD COLUMN IF NOT EXISTS visitor_session_id uuid REFERENCES public.visitor_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_sessions_visitor_session_id_idx
  ON public.call_sessions (visitor_session_id)
  WHERE visitor_session_id IS NOT NULL;

-- Backfill from the queue entry that produced the call (same visitor, same
-- session) so historical calls also resolve a network profile.
UPDATE public.call_sessions cs
SET visitor_session_id = q.visitor_session_id
FROM public.call_queue_entries q
WHERE q.call_session_id = cs.id
  AND cs.visitor_session_id IS NULL
  AND q.visitor_session_id IS NOT NULL;

-- ---------- in-migration proof ----------
DO $verify$
BEGIN
  IF to_regclass('public.call_sessions') IS NULL THEN
    RAISE EXCEPTION '018: public.call_sessions was not created';
  END IF;
  IF to_regclass('public.call_queue_entries') IS NULL THEN
    RAISE EXCEPTION '018: public.call_queue_entries was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'call_sessions' AND column_name = 'visitor_session_id'
  ) THEN
    RAISE EXCEPTION '018: call_sessions.visitor_session_id was not added';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'call_type'
  ) THEN
    RAISE EXCEPTION '018: public.call_type enum was not created';
  END IF;
  RAISE NOTICE '018: Call Center base schema (call_sessions, call_queue_entries) + visitor-session link established';
END
$verify$;
