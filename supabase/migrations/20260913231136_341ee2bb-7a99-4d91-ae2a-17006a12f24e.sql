-- 183_backup_commands.sql
-- Safe, allow-listed command queue between Super Admin and the host-side
-- backup agent. Deliberately has NO restore command: production restore is a
-- controlled operational procedure, never a button.

CREATE TABLE IF NOT EXISTS public.backup_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command text NOT NULL CHECK (command IN ('run_logical_backup','run_base_backup','verify_latest_backup')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','succeeded','failed','expired')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE INDEX IF NOT EXISTS backup_commands_pending_idx
  ON public.backup_commands (status, requested_at);

GRANT ALL ON public.backup_commands TO service_role;
ALTER TABLE public.backup_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.backup_commands FROM anon, authenticated;

-- Claim the oldest pending command (single-flight; the agent may run on more
-- than one host during a migration window).
CREATE OR REPLACE FUNCTION public.backup_claim_command()
RETURNS SETOF public.backup_commands
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.backup_commands c
     SET status = 'claimed', claimed_at = now()
   WHERE c.id = (
     SELECT id FROM public.backup_commands
      WHERE status = 'pending' AND requested_at > now() - interval '1 hour'
      ORDER BY requested_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING c.*;
$$;

REVOKE ALL ON FUNCTION public.backup_claim_command() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backup_claim_command() TO service_role;