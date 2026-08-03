-- ============================================================
-- Self-host mirror of the hosted `public.email_templates` contract.
--
-- The initial self-host chain created the table with a NOT NULL
-- `workspace_id` and without `is_active`, while the runtime (and the hosted
-- project, which is the contract of record) uses global templates
-- (`workspace_id IS NULL`) filtered by `is_active`. Forward-only and
-- idempotent; the shipped creation migration is not edited.
-- ============================================================

ALTER TABLE public.email_templates
  ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
