-- ============================================================
-- PRODUCTION-GRADE VISITOR IDENTITY & CONTACT VERIFICATION
-- Self-hosted, provider-based, modular, fail-closed
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 1: Extend visitor_sessions with identity metadata
-- ------------------------------------------------------------
ALTER TABLE public.visitor_sessions
  ADD COLUMN IF NOT EXISTS identity_state text NOT NULL DEFAULT 'anonymous',
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_visitor_sessions_workspace_visitor
  ON public.visitor_sessions(workspace_id, visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_contact
  ON public.visitor_sessions(contact_id) WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- SECTION 2: User continuity tokens (cross-device session)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_continuity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  user_id uuid,
  token_hash text NOT NULL UNIQUE,
  device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT continuity_target_required CHECK (contact_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_continuity_tokens_workspace_contact
  ON public.user_continuity_tokens(workspace_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_continuity_tokens_expires
  ON public.user_continuity_tokens(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE public.user_continuity_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access continuity"
  ON public.user_continuity_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members read continuity"
  ON public.user_continuity_tokens FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ------------------------------------------------------------
-- SECTION 3: Contact verification tokens (email/phone)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_id text,
  channel text NOT NULL CHECK (channel IN ('email','phone')),
  identifier text NOT NULL,
  token_hash text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_verifications_workspace_identifier
  ON public.contact_verifications(workspace_id, channel, identifier);
CREATE INDEX IF NOT EXISTS idx_contact_verifications_token_hash
  ON public.contact_verifications(token_hash) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_verifications_expires
  ON public.contact_verifications(expires_at) WHERE used_at IS NULL;

ALTER TABLE public.contact_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access verifications"
  ON public.contact_verifications FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members read verifications"
  ON public.contact_verifications FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ------------------------------------------------------------
-- SECTION 4: Identity merges audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.identity_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cookie','email','phone','token','prechat','manual')),
  conversations_merged integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_merges_workspace_contact
  ON public.identity_merges(workspace_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_identity_merges_visitor
  ON public.identity_merges(workspace_id, visitor_id);

ALTER TABLE public.identity_merges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access merges"
  ON public.identity_merges FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members read merges"
  ON public.identity_merges FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ------------------------------------------------------------
-- SECTION 5: Pre-chat field policies (workspace-level)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.widget_prechat_settings (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ask_name boolean NOT NULL DEFAULT true,
  ask_email boolean NOT NULL DEFAULT true,
  ask_phone boolean NOT NULL DEFAULT false,
  require_name boolean NOT NULL DEFAULT true,
  require_email boolean NOT NULL DEFAULT true,
  require_phone boolean NOT NULL DEFAULT false,
  verify_email boolean NOT NULL DEFAULT false,
  verify_phone boolean NOT NULL DEFAULT false,
  history_continue_window_hours integer NOT NULL DEFAULT 24,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.widget_prechat_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access prechat"
  ON public.widget_prechat_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members read prechat"
  ON public.widget_prechat_settings FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace admins manage prechat"
  ON public.widget_prechat_settings FOR ALL TO authenticated
  USING (
    public.is_workspace_member(workspace_id, auth.uid())
    AND public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin')
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND public.get_workspace_role(workspace_id, auth.uid()) IN ('owner','admin')
  );

-- Touch trigger
CREATE OR REPLACE FUNCTION public.widget_prechat_settings_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_widget_prechat_settings_touch ON public.widget_prechat_settings;
CREATE TRIGGER trg_widget_prechat_settings_touch
  BEFORE UPDATE ON public.widget_prechat_settings
  FOR EACH ROW EXECUTE FUNCTION public.widget_prechat_settings_touch();

-- ------------------------------------------------------------
-- SECTION 6: Atomic identity merge function (server-only)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_visitor_into_contact(
  _workspace_id uuid,
  _visitor_id text,
  _contact_id uuid,
  _method text,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _merged_count integer := 0;
BEGIN
  -- Attach visitor sessions to contact
  UPDATE public.visitor_sessions
  SET contact_id = _contact_id,
      identity_state = 'identified'
  WHERE workspace_id = _workspace_id
    AND visitor_id = _visitor_id
    AND (contact_id IS NULL OR contact_id = _contact_id);

  -- Re-link conversations from this visitor to the contact
  WITH updated AS (
    UPDATE public.conversations c
    SET contact_id = _contact_id,
        updated_at = now()
    WHERE c.workspace_id = _workspace_id
      AND c.visitor_session_id IN (
        SELECT vs.id FROM public.visitor_sessions vs
        WHERE vs.workspace_id = _workspace_id AND vs.visitor_id = _visitor_id
      )
      AND (c.contact_id IS NULL OR c.contact_id = _contact_id)
    RETURNING c.id
  )
  SELECT count(*) INTO _merged_count FROM updated;

  -- Audit
  INSERT INTO public.identity_merges (workspace_id, visitor_id, contact_id, method, conversations_merged, metadata)
  VALUES (_workspace_id, _visitor_id, _contact_id, _method, _merged_count, COALESCE(_metadata, '{}'::jsonb));

  RETURN jsonb_build_object(
    'success', true,
    'contact_id', _contact_id,
    'visitor_id', _visitor_id,
    'conversations_merged', _merged_count
  );
END;
$$;

-- ------------------------------------------------------------
-- SECTION 7: Cleanup expired tokens
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_widget_identity()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.contact_verifications WHERE expires_at < now() - interval '1 day';
  DELETE FROM public.user_continuity_tokens WHERE expires_at < now() - interval '7 days' AND revoked_at IS NOT NULL;
END;
$$;

-- ------------------------------------------------------------
-- SECTION 8: Seed default prechat settings for existing workspaces
-- ------------------------------------------------------------
INSERT INTO public.widget_prechat_settings (workspace_id)
SELECT w.id FROM public.workspaces w
WHERE NOT EXISTS (SELECT 1 FROM public.widget_prechat_settings p WHERE p.workspace_id = w.id);
