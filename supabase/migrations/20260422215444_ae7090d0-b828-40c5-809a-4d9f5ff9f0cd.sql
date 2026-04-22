-- Phase 8C fix — allow 'call' as a valid provider_type so workspace
-- voice/video overrides can be persisted in workspace_provider_settings.
-- The previous CHECK constraint only permitted email/ai/webhook which
-- caused PUT /api/workspace-calls/:id/settings to fail with 400 the
-- first time a workspace tried to toggle voice or video.

ALTER TABLE public.workspace_provider_settings
  DROP CONSTRAINT IF EXISTS workspace_provider_settings_provider_type_check;

ALTER TABLE public.workspace_provider_settings
  ADD CONSTRAINT workspace_provider_settings_provider_type_check
  CHECK (provider_type IN ('email', 'ai', 'webhook', 'call'));