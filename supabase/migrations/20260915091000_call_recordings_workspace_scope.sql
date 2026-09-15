-- Call recording storage-path workspace scoping.
--
-- Hosted-only: call_recordings has no self-host mirror table today. This
-- predates the storage architecture project — database/migrations/
-- 101_call_widget_presentation_contract.sql already ALTERs
-- public.call_center_settings unconditionally, with no self-host CREATE
-- TABLE for it anywhere in database/migrations/, and the self-host CI
-- chain only exercises 000->013 (see database/README.md); call_recordings
-- has the same gap. Fixing that asymmetry is a separate, larger effort
-- than this constraint pass, so this migration is intentionally NOT
-- registered in src/test/integration/migrationMirrorParity.test.ts's
-- MIRRORS array.
--
-- Storage ownership standardization: call_recordings.storage_path had no
-- workspace_id of its own — only call_session_id -> call_sessions.workspace_id.
-- server/routes/livekitWebhook.ts already fail-closed validates the
-- LiveKit egress filename against the canonical
-- workspace/<workspaceId>/calls/recordings/<callSessionId>/... prefix
-- before ever writing storage_path (assertCallRecordingKey in
-- server/services/storage/keys.ts), so this constraint is defense in
-- depth, not the primary control.
--
-- storage_path is '' while a recording is in progress (only populated on
-- egress_ended) — the CHECK allows that pending state alongside the
-- canonical shape. Added NOT VALID: existing rows may still carry a
-- pre-canonicalization LiveKit path (<providerRoomId>/<ts>.mp4, no
-- workspace prefix at all) written before this session's webhook fix, and
-- there is no safe way to enumerate real production data from here.
-- Forcing immediate validation would either fail the migration outright or
-- require guessing. Phase 6 (legacy migration tooling) is the right place
-- to rewrite those rows; VALIDATE CONSTRAINT call_recordings_path_scope_check
-- once that has run.

ALTER TABLE public.call_recordings
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;

UPDATE public.call_recordings cr
SET workspace_id = cs.workspace_id
FROM public.call_sessions cs
WHERE cr.call_session_id = cs.id
  AND cr.workspace_id IS NULL;

DO $verify_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM public.call_recordings WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'call_recordings.workspace_id backfill left NULL rows — orphaned call_session_id?';
  END IF;
END
$verify_backfill$;

ALTER TABLE public.call_recordings
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_recordings_workspace ON public.call_recordings (workspace_id);

ALTER TABLE public.call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_path_scope_check;

ALTER TABLE public.call_recordings
  ADD CONSTRAINT call_recordings_path_scope_check
    CHECK (
      storage_path = ''
      OR storage_path LIKE 'workspace/' || workspace_id::text || '/calls/recordings/' || call_session_id::text || '/%'
    )
    NOT VALID;

COMMENT ON COLUMN public.call_recordings.workspace_id IS
  'Denormalized from call_sessions.workspace_id at write time — lets the database itself verify storage_path is scoped to the right workspace+session (call_recordings_path_scope_check), independent of the call_session_id join.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'call_recordings' AND column_name = 'workspace_id'
  ) THEN
    RAISE EXCEPTION 'call_recordings.workspace_id column missing after migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_path_scope_check') THEN
    RAISE EXCEPTION 'call_recordings_path_scope_check constraint missing after migration';
  END IF;
END
$verify$;
