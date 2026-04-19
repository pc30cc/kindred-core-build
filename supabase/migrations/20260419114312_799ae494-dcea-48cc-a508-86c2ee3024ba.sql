-- ============================================================================
-- Canned Responses (Phase 6)
-- Workspace-scoped reply templates with multilingual support and slash-trigger.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE public.canned_responses (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id    UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by      UUID        NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  locale          TEXT        NOT NULL CHECK (locale IN ('en', 'fa', 'tr')),
  shortcut        TEXT        NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body            TEXT        NOT NULL CHECK (char_length(body)  BETWEEN 1 AND 4000),
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  usage_count     INTEGER     NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX canned_responses_workspace_locale_shortcut_uniq
  ON public.canned_responses (workspace_id, locale, lower(shortcut));

CREATE INDEX canned_responses_workspace_locale_idx
  ON public.canned_responses (workspace_id, locale, is_active);

CREATE INDEX canned_responses_usage_idx
  ON public.canned_responses (workspace_id, usage_count DESC, last_used_at DESC NULLS LAST);

CREATE INDEX canned_responses_title_trgm_idx
  ON public.canned_responses USING GIN (title gin_trgm_ops);
CREATE INDEX canned_responses_shortcut_trgm_idx
  ON public.canned_responses USING GIN (shortcut gin_trgm_ops);
CREATE INDEX canned_responses_body_trgm_idx
  ON public.canned_responses USING GIN (body gin_trgm_ops);

-- Dedicated updated_at trigger function (no shared helper exists in this DB)
CREATE OR REPLACE FUNCTION public.set_canned_responses_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER canned_responses_set_updated_at
  BEFORE UPDATE ON public.canned_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.set_canned_responses_updated_at();

ALTER TABLE public.canned_responses ENABLE ROW LEVEL SECURITY;

-- SELECT: any workspace member
CREATE POLICY "Members can view canned responses"
  ON public.canned_responses
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- INSERT: any workspace member, but only as themselves
CREATE POLICY "Members can create own canned responses"
  ON public.canned_responses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND created_by = auth.uid()
  );

-- UPDATE: author OR workspace admin/owner; post-update row must remain in a workspace the user belongs to
CREATE POLICY "Author or admin can update canned responses"
  ON public.canned_responses
  FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid()
    OR public.get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND (
      created_by = auth.uid()
      OR public.get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
    )
  );

-- DELETE: author OR workspace admin/owner
CREATE POLICY "Author or admin can delete canned responses"
  ON public.canned_responses
  FOR DELETE
  TO authenticated
  USING (
    created_by = auth.uid()
    OR public.get_workspace_role(workspace_id, auth.uid()) IN ('owner', 'admin')
  );
