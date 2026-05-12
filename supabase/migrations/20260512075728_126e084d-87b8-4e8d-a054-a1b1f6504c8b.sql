
-- CC-2G-UI-Architecture-Fix — Add Call Center channel flags to canonical
-- workspace_departments. Existing audio_enabled/video_enabled remain the
-- chat-widget call channels (untouched). The new cc_* columns gate the
-- standalone Call Center widget routing.
ALTER TABLE public.workspace_departments
  ADD COLUMN IF NOT EXISTS tickets_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cc_voice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cc_video_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cc_callback_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cc_routing_mode text NULL,
  ADD COLUMN IF NOT EXISTS cc_fallback_department_id uuid NULL
    REFERENCES public.workspace_departments(id) ON DELETE SET NULL;

-- cc_routing_mode allowed values: broadcast | round_robin | least_busy | NULL
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_departments_cc_routing_mode_check'
  ) THEN
    ALTER TABLE public.workspace_departments
      ADD CONSTRAINT workspace_departments_cc_routing_mode_check
      CHECK (cc_routing_mode IS NULL OR cc_routing_mode IN ('broadcast','round_robin','least_busy'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_departments_cc_voice
  ON public.workspace_departments(workspace_id, enabled, cc_voice_enabled);
CREATE INDEX IF NOT EXISTS idx_workspace_departments_cc_video
  ON public.workspace_departments(workspace_id, enabled, cc_video_enabled);
