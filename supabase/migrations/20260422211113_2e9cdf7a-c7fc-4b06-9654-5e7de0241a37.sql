-- ============================================================
-- Phase 8C — Voice/Video Channel: queue + role permissions
-- ============================================================

-- ---------- 1) call_queue_entries ----------------------------
CREATE TYPE public.call_queue_channel AS ENUM ('audio', 'video');
CREATE TYPE public.call_queue_state AS ENUM ('queued', 'offered', 'accepted', 'cancelled', 'expired');

CREATE TABLE public.call_queue_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  channel public.call_queue_channel NOT NULL,
  state public.call_queue_state NOT NULL DEFAULT 'queued',

  visitor_session_id UUID,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  call_session_id UUID REFERENCES public.call_sessions(id) ON DELETE SET NULL,

  requested_by TEXT NOT NULL DEFAULT 'visitor',
  priority SMALLINT NOT NULL DEFAULT 0,
  position_hint INT,

  offered_to_user_id UUID,
  offered_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_queue_workspace_channel_state
  ON public.call_queue_entries (workspace_id, channel, state, created_at);

CREATE INDEX idx_call_queue_offered_to
  ON public.call_queue_entries (offered_to_user_id)
  WHERE state = 'offered';

CREATE UNIQUE INDEX uniq_active_queue_per_visitor_channel
  ON public.call_queue_entries (workspace_id, visitor_session_id, channel)
  WHERE state IN ('queued', 'offered') AND visitor_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_call_queue_entries_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER call_queue_entries_set_updated_at
  BEFORE UPDATE ON public.call_queue_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_call_queue_entries_updated_at();

ALTER TABLE public.call_queue_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members read queue"
ON public.call_queue_entries
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = call_queue_entries.workspace_id
      AND wm.user_id = auth.uid()
  )
);

CREATE POLICY "Workspace admins mutate queue"
ON public.call_queue_entries
FOR ALL
TO authenticated
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

-- ---------- 2) role_permissions ------------------------------
CREATE TABLE public.role_permissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  role_slug TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_role_perm_scope
  ON public.role_permissions (
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    role_slug,
    permission_key
  );

CREATE OR REPLACE FUNCTION public.set_role_permissions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_permissions_set_updated_at
  BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_role_permissions_updated_at();

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read role permissions"
ON public.role_permissions
FOR SELECT
TO authenticated
USING (
  workspace_id IS NULL
  OR EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = role_permissions.workspace_id
      AND wm.user_id = auth.uid()
  )
);

CREATE POLICY "Platform admins manage defaults"
ON public.role_permissions
FOR ALL
TO authenticated
USING (
  workspace_id IS NULL
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
)
WITH CHECK (
  workspace_id IS NULL
  AND public.has_role(auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY "Workspace admins manage overrides"
ON public.role_permissions
FOR ALL
TO authenticated
USING (
  workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = role_permissions.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.role IN ('owner', 'admin')
  )
)
WITH CHECK (
  workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = role_permissions.workspace_id
      AND wm.user_id = auth.uid()
      AND wm.role IN ('owner', 'admin')
  )
);

-- ---------- 3) Seed platform default permissions -------------
INSERT INTO public.role_permissions (workspace_id, role_slug, permission_key, granted) VALUES
  (NULL, 'owner', 'can_start_audio_call', true),
  (NULL, 'owner', 'can_start_video_call', true),
  (NULL, 'owner', 'can_receive_audio_call', true),
  (NULL, 'owner', 'can_receive_video_call', true),
  (NULL, 'owner', 'can_record_calls', true),
  (NULL, 'owner', 'can_transfer_calls', true),
  (NULL, 'owner', 'can_join_queue_calls', true),
  (NULL, 'owner', 'can_manage_call_queue', true),

  (NULL, 'admin', 'can_start_audio_call', true),
  (NULL, 'admin', 'can_start_video_call', true),
  (NULL, 'admin', 'can_receive_audio_call', true),
  (NULL, 'admin', 'can_receive_video_call', true),
  (NULL, 'admin', 'can_record_calls', true),
  (NULL, 'admin', 'can_transfer_calls', true),
  (NULL, 'admin', 'can_join_queue_calls', true),
  (NULL, 'admin', 'can_manage_call_queue', true),

  (NULL, 'agent', 'can_start_audio_call', true),
  (NULL, 'agent', 'can_start_video_call', true),
  (NULL, 'agent', 'can_receive_audio_call', true),
  (NULL, 'agent', 'can_receive_video_call', true),
  (NULL, 'agent', 'can_record_calls', false),
  (NULL, 'agent', 'can_transfer_calls', false),
  (NULL, 'agent', 'can_join_queue_calls', true),
  (NULL, 'agent', 'can_manage_call_queue', false),

  (NULL, 'viewer', 'can_start_audio_call', false),
  (NULL, 'viewer', 'can_start_video_call', false),
  (NULL, 'viewer', 'can_receive_audio_call', false),
  (NULL, 'viewer', 'can_receive_video_call', false),
  (NULL, 'viewer', 'can_record_calls', false),
  (NULL, 'viewer', 'can_transfer_calls', false),
  (NULL, 'viewer', 'can_join_queue_calls', false),
  (NULL, 'viewer', 'can_manage_call_queue', false)
ON CONFLICT DO NOTHING;
