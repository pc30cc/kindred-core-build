-- ─── privacy_jobs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.privacy_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  actor_user_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('contact', 'visitor', 'user')),
  subject_id text NOT NULL,
  subject_email_hash text,
  resolved_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  action text NOT NULL CHECK (action IN ('export', 'delete')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_path text,
  artifact_hash text,
  artifact_size_bytes bigint,
  download_count integer NOT NULL DEFAULT 0,
  download_token_hash text,
  expires_at timestamptz,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_privacy_jobs_workspace_status ON public.privacy_jobs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_actor_requested ON public.privacy_jobs(actor_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_status_requested ON public.privacy_jobs(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_privacy_jobs_subject ON public.privacy_jobs(workspace_id, subject_type, subject_id);

ALTER TABLE public.privacy_jobs ENABLE ROW LEVEL SECURITY;

-- Workspace admins can view jobs in their workspace
CREATE POLICY "Workspace admins view privacy jobs"
ON public.privacy_jobs FOR SELECT
TO authenticated
USING (
  workspace_id IS NOT NULL
  AND get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])
);

-- Users can view their own user-subject jobs (cross-workspace)
CREATE POLICY "Users view own privacy jobs"
ON public.privacy_jobs FOR SELECT
TO authenticated
USING (actor_user_id = auth.uid() AND subject_type = 'user' AND subject_id = auth.uid()::text);

-- Global admins
CREATE POLICY "Global admins view all privacy jobs"
ON public.privacy_jobs FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Workspace admins can create contact/visitor jobs
CREATE POLICY "Workspace admins create privacy jobs"
ON public.privacy_jobs FOR INSERT
TO authenticated
WITH CHECK (
  actor_user_id = auth.uid()
  AND (
    (
      subject_type IN ('contact', 'visitor')
      AND workspace_id IS NOT NULL
      AND get_workspace_role(workspace_id, auth.uid()) = ANY (ARRAY['owner'::workspace_role, 'admin'::workspace_role])
    )
    OR (
      subject_type = 'user'
      AND subject_id = auth.uid()::text
    )
  )
);

-- Service role full access for the worker
CREATE POLICY "Service role full access privacy jobs"
ON public.privacy_jobs FOR ALL
TO service_role
USING (true) WITH CHECK (true);

-- ─── resolve_privacy_subject helper ─────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_privacy_subject(
  _workspace_id uuid,
  _subject_type text,
  _subject_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _contact_ids uuid[] := ARRAY[]::uuid[];
  _visitor_ids text[] := ARRAY[]::text[];
  _emails text[] := ARRAY[]::text[];
  _root_contact_id uuid;
  _root_visitor_id text;
BEGIN
  IF _subject_type = 'contact' THEN
    _root_contact_id := _subject_id::uuid;
    _contact_ids := ARRAY[_root_contact_id];

    -- Pull email/phone from contacts row
    SELECT ARRAY_REMOVE(ARRAY[email], NULL) INTO _emails
    FROM public.contacts
    WHERE id = _root_contact_id AND workspace_id = _workspace_id;

    -- Find all visitor_ids merged into this contact
    SELECT ARRAY_AGG(DISTINCT visitor_id) INTO _visitor_ids
    FROM public.identity_merges
    WHERE workspace_id = _workspace_id AND contact_id = _root_contact_id;

    -- Also pull visitor_ids directly attached via visitor_sessions
    _visitor_ids := COALESCE(_visitor_ids, ARRAY[]::text[]) || COALESCE(
      (SELECT ARRAY_AGG(DISTINCT vs.visitor_id)
       FROM public.visitor_sessions vs
       WHERE vs.workspace_id = _workspace_id AND vs.contact_id = _root_contact_id),
      ARRAY[]::text[]
    );

  ELSIF _subject_type = 'visitor' THEN
    _root_visitor_id := _subject_id;
    _visitor_ids := ARRAY[_root_visitor_id];

    -- Find any contact this visitor was merged into
    SELECT ARRAY_AGG(DISTINCT contact_id) INTO _contact_ids
    FROM public.identity_merges
    WHERE workspace_id = _workspace_id AND visitor_id = _root_visitor_id;

    _contact_ids := COALESCE(_contact_ids, ARRAY[]::uuid[]) || COALESCE(
      (SELECT ARRAY_AGG(DISTINCT vs.contact_id)
       FROM public.visitor_sessions vs
       WHERE vs.workspace_id = _workspace_id
         AND vs.visitor_id = _root_visitor_id
         AND vs.contact_id IS NOT NULL),
      ARRAY[]::uuid[]
    );

    -- Pull emails from any matching contacts
    IF array_length(_contact_ids, 1) > 0 THEN
      SELECT ARRAY_AGG(DISTINCT email) INTO _emails
      FROM public.contacts
      WHERE id = ANY(_contact_ids) AND email IS NOT NULL;
    END IF;

  ELSIF _subject_type = 'user' THEN
    -- User subjects: not workspace-scoped here; resolver returns user identifiers
    SELECT ARRAY_REMOVE(ARRAY[email], NULL) INTO _emails
    FROM public.profiles WHERE id = _subject_id::uuid;
  END IF;

  RETURN jsonb_build_object(
    'contact_ids', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(_contact_ids))), '[]'::jsonb),
    'visitor_ids', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(_visitor_ids))), '[]'::jsonb),
    'emails', COALESCE(to_jsonb(ARRAY(SELECT DISTINCT unnest(COALESCE(_emails, ARRAY[]::text[])))), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_privacy_subject(uuid, text, text) TO authenticated, service_role;