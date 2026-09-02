-- 077 — Workspace Invitations v5.1 EXPAND migration (self-host chain).
--
-- Additive + compatibility-preserving. After this migration the LEGACY
-- runtime (server/routes/workspaceMembers.ts + public.accept_workspace_invitation_as)
-- keeps working unchanged; the secure v5.1 flow becomes possible.
--
-- Blocker-1 lifecycle (v5.1 §4.1) — public.workspace_invitations.token was
-- created by 042 as:
--     token text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex') UNIQUE
-- Making it nullable does NOT stop the default from firing, so:
--   * here  : DROP NOT NULL, DEFAULT deliberately RETAINED for the legacy
--             runtime, plus a guard trigger that makes a non-null token on a
--             version-2 row impossible;
--   * fence : ALTER COLUMN token DROP DEFAULT + NULL every remaining value;
--   * contract: DROP COLUMN token/max_uses/use_count.

-- =========================================================================
-- 1. workspace_invitations — expand
-- =========================================================================
ALTER TABLE public.workspace_invitations
  ALTER COLUMN token DROP NOT NULL;

ALTER TABLE public.workspace_invitations
  ADD COLUMN IF NOT EXISTS invitation_flow_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_name               text,
  ADD COLUMN IF NOT EXISTS last_name                text,
  ADD COLUMN IF NOT EXISTS invited_email_normalized text,
  ADD COLUMN IF NOT EXISTS invited_phone_e164       text,
  ADD COLUMN IF NOT EXISTS member_type              text,
  ADD COLUMN IF NOT EXISTS status                   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS accepted_by              uuid,
  ADD COLUMN IF NOT EXISTS accepted_at              timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by               uuid,
  ADD COLUMN IF NOT EXISTS revoked_reason           text,
  ADD COLUMN IF NOT EXISTS expired_at               timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at              timestamptz,
  ADD COLUMN IF NOT EXISTS notification_generation  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS job_title                text,
  ADD COLUMN IF NOT EXISTS staff_code               text,
  ADD COLUMN IF NOT EXISTS last_email_status        text,
  ADD COLUMN IF NOT EXISTS last_sms_status          text;

-- Composite key used by every (invitation_id, workspace_id) child FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workspace_invitations'::regclass
      AND conname = 'workspace_invitations_id_workspace_id_key'
  ) THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_id_workspace_id_key UNIQUE (id, workspace_id);
  END IF;
END $$;

-- ---------- 1a. Deterministic version-1 status backfill (v5.1 §4.3) ----------
-- 042's legacy table has NO acceptance column; use_count (incremented by
-- accept_workspace_invitation_as, 042:230) is the only acceptance evidence.
-- accepted_at / accepted_by stay NULL for legacy rows — never fabricated.
UPDATE public.workspace_invitations
SET status = CASE
      WHEN revoked_at IS NOT NULL                         THEN 'revoked'
      WHEN use_count > 0                                  THEN 'accepted'
      WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
      ELSE 'pending'
    END,
    expired_at = CASE
      WHEN revoked_at IS NULL AND use_count = 0
       AND expires_at IS NOT NULL AND expires_at <= now() THEN expires_at
      ELSE expired_at
    END
WHERE invitation_flow_version = 1;

-- ---------- 1b. Constraints ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_flow_version_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_flow_version_chk
      CHECK (invitation_flow_version IN (1, 2));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_status_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_status_chk
      CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_member_type_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_member_type_chk
      CHECK (member_type IS NULL OR member_type IN ('staff', 'customer_facing'));
  END IF;

  -- Version-2 required fields. Every leaf is an IS NOT NULL / comparison on a
  -- proven-non-null value, so the expression can never evaluate to NULL and
  -- silently pass (v5.1 §4.2).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_v2_required_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_v2_required_chk
      CHECK (
        invitation_flow_version <> 2 OR (
              first_name IS NOT NULL AND btrim(first_name) <> ''
          AND last_name  IS NOT NULL AND btrim(last_name)  <> ''
          AND invited_email_normalized IS NOT NULL
          AND invited_email_normalized = lower(btrim(invited_email_normalized))
          AND invited_phone_e164 IS NOT NULL
          AND invited_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
          AND member_type IS NOT NULL
          AND role IS NOT NULL AND role <> 'owner'::public.workspace_role
          AND workspace_id IS NOT NULL
          AND created_by   IS NOT NULL
          AND created_at   IS NOT NULL
          AND expires_at   IS NOT NULL AND expires_at > created_at
          AND notification_generation IS NOT NULL AND notification_generation >= 1
          AND token IS NULL
        )
      );
  END IF;

  -- Role / member-type pairing (version-2 only).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_v2_role_pairing_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_v2_role_pairing_chk
      CHECK (
        invitation_flow_version <> 2 OR (
             (member_type = 'staff' AND role::text IN
                ('admin','marketing_manager','seo_manager','analyst','developer','billing','viewer'))
          OR (member_type = 'customer_facing' AND role::text IN
                ('agent','support_agent','sales_agent','team_lead'))
        )
      );
  END IF;

  -- Terminal-state metadata: strict for version 2, tolerant for retained
  -- version-1 history (unknown legacy fields stay NULL, never invented).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.workspace_invitations'::regclass
                   AND conname = 'workspace_invitations_v2_state_chk') THEN
    ALTER TABLE public.workspace_invitations
      ADD CONSTRAINT workspace_invitations_v2_state_chk
      CHECK (
        invitation_flow_version <> 2 OR (
             (status = 'pending'  AND accepted_at IS NULL AND accepted_by IS NULL
                                  AND revoked_at IS NULL AND expired_at IS NULL)
          OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL
                                  AND revoked_at IS NULL)
          OR (status = 'revoked'  AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL
                                  AND revoked_reason IS NOT NULL AND btrim(revoked_reason) <> '')
          OR (status = 'expired'  AND expired_at IS NOT NULL)
        )
      );
  END IF;
END $$;

-- Partial uniqueness: one pending invitation per email / per phone per
-- workspace. No now() in the predicate (immutability requirement).
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitations_pending_email
  ON public.workspace_invitations (workspace_id, invited_email_normalized)
  WHERE status = 'pending' AND invited_email_normalized IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitations_pending_phone
  ON public.workspace_invitations (workspace_id, invited_phone_e164)
  WHERE status = 'pending' AND invited_phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_ws_status
  ON public.workspace_invitations (workspace_id, status);

-- ---------- 1c. Guard + compatibility triggers ----------
-- (a) A version-2 row may never carry a plaintext token, and a legacy row may
--     never be escalated into the secure flow.
CREATE OR REPLACE FUNCTION public.workspace_invitations_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.invitation_flow_version = 2 AND NEW.token IS NOT NULL THEN
    RAISE EXCEPTION 'v2 invitation must not carry a plaintext token';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.invitation_flow_version = 1
     AND NEW.invitation_flow_version = 2 THEN
    RAISE EXCEPTION 'legacy invitation cannot be escalated to the secure flow';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_invitations_version_guard ON public.workspace_invitations;
CREATE TRIGGER trg_workspace_invitations_version_guard
  BEFORE INSERT OR UPDATE ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.workspace_invitations_version_guard();

-- (b) Legacy compatibility window: keep version-1 `status` in sync with the
--     legacy columns the old runtime still writes. Version-2 rows are never
--     touched. DROPPED in the contract migration.
CREATE OR REPLACE FUNCTION public.workspace_invitations_legacy_status_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.invitation_flow_version <> 1 THEN
    RETURN NEW;
  END IF;

  NEW.status := CASE
    WHEN NEW.revoked_at IS NOT NULL                             THEN 'revoked'
    WHEN COALESCE(NEW.use_count, 0) > 0                         THEN 'accepted'
    WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN 'expired'
    ELSE 'pending'
  END;

  IF NEW.status = 'expired' AND NEW.expired_at IS NULL THEN
    NEW.expired_at := NEW.expires_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_invitations_legacy_status_sync ON public.workspace_invitations;
CREATE TRIGGER trg_workspace_invitations_legacy_status_sync
  BEFORE INSERT OR UPDATE OF use_count, revoked_at, expires_at
  ON public.workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION public.workspace_invitations_legacy_status_sync();

-- =========================================================================
-- 2. Secure-flow child tables
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.workspace_invitation_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_claim', 'manual_handoff')),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  token_generation integer NOT NULL DEFAULT 1,
  notification_generation integer NOT NULL DEFAULT 1,
  derivation_key_version integer,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitation_tokens_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_invitation_tokens_email_key_version_chk
    CHECK (purpose <> 'manual_handoff' OR derivation_key_version IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitation_tokens_active
  ON public.workspace_invitation_tokens (invitation_id, purpose)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.workspace_invitation_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  manual_token_id uuid NOT NULL REFERENCES public.workspace_invitation_tokens(id) ON DELETE CASCADE,
  manual_token_generation integer NOT NULL,
  notification_generation integer NOT NULL,
  purpose text NOT NULL DEFAULT 'manual_handoff_otp',
  code_digest text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitation_otps_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_otps_lookup
  ON public.workspace_invitation_otps (invitation_id, consumed_at, revoked_at);

CREATE TABLE IF NOT EXISTS public.workspace_invitation_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  otp_id uuid NOT NULL REFERENCES public.workspace_invitation_otps(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email_normalized text NOT NULL,
  manual_token_id uuid NOT NULL REFERENCES public.workspace_invitation_tokens(id) ON DELETE CASCADE,
  manual_token_generation integer NOT NULL,
  notification_generation integer NOT NULL,
  purpose text NOT NULL DEFAULT 'manual_handoff_proof',
  proof_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitation_proofs_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE
);

-- Login round-trip continuity (v5.1 §5.5): stores ONLY the hash of an opaque
-- handle plus a reference to the token row. Never a raw invitation token.
CREATE TABLE IF NOT EXISTS public.workspace_invitation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle_hash text NOT NULL UNIQUE,
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  token_id uuid NOT NULL REFERENCES public.workspace_invitation_tokens(id) ON DELETE CASCADE,
  token_generation integer NOT NULL,
  notification_generation integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('email_claim', 'manual_handoff')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitation_contexts_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.workspace_invitation_departments (
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  department_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, department_id),
  CONSTRAINT workspace_invitation_departments_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT workspace_invitation_departments_department_fk
    FOREIGN KEY (department_id, workspace_id)
    REFERENCES public.workspace_departments(id, workspace_id) ON DELETE RESTRICT
);

-- =========================================================================
-- 3. Durable outbox (mirrors 048's channel_jobs contract)
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.workspace_invitation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  notification_generation integer NOT NULL,
  email_token_generation integer,
  derivation_key_version integer,
  destination_hash text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','provider_accepted','completed','retrying',
                      'permanently_failed','cancelled','unconfigured','derivation_key_unavailable')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  claim_token uuid,
  claim_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitation_jobs_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_jobs_claim
  ON public.workspace_invitation_jobs (status, available_at)
  WHERE status IN ('queued', 'retrying');

CREATE TABLE IF NOT EXISTS public.workspace_invitation_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  job_id uuid REFERENCES public.workspace_invitation_jobs(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  notification_generation integer NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  provider_name text,
  provider_message_id text,
  status text NOT NULL,
  error_code text,
  safe_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  provider_accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT workspace_invitation_deliveries_invitation_fk
    FOREIGN KEY (invitation_id, workspace_id)
    REFERENCES public.workspace_invitations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_deliveries_invitation
  ON public.workspace_invitation_deliveries (invitation_id, created_at DESC);

-- =========================================================================
-- 4. Employee identity: active details + immutable history
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.workspace_member_details (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  work_email_normalized text NOT NULL,
  work_phone_e164 text NOT NULL,
  member_type text NOT NULL CHECK (member_type IN ('staff', 'customer_facing')),
  job_title text,
  staff_code text,
  invited_by uuid,
  invitation_id uuid REFERENCES public.workspace_invitations(id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_member_details_member_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.workspace_member_details_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  first_name text,
  last_name text,
  work_email_normalized text,
  work_phone_e164 text,
  member_type text,
  job_title text,
  staff_code text,
  invited_by uuid,
  invitation_id uuid REFERENCES public.workspace_invitations(id) ON DELETE SET NULL,
  joined_at timestamptz,
  offboarded_at timestamptz NOT NULL DEFAULT now(),
  offboarded_by uuid,
  reason text
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_details_history_ws
  ON public.workspace_member_details_history (workspace_id, offboarded_at DESC);

-- =========================================================================
-- 5. Legal versions + invitation-specific consent
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.legal_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_type text NOT NULL CHECK (policy_type IN ('terms', 'privacy')),
  version text NOT NULL,
  locale text NOT NULL,
  content_hash text NOT NULL,
  document_url text,
  published_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (policy_type, version, locale)
);

CREATE OR REPLACE FUNCTION public.legal_policy_versions_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.workspace_invitation_consents c
               WHERE c.terms_version_id = OLD.id OR c.privacy_version_id = OLD.id) THEN
      RAISE EXCEPTION 'legal policy version is referenced by consent and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.version <> OLD.version
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.published_at <> OLD.published_at THEN
    RAISE EXCEPTION 'legal policy version/content_hash/published_at are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.workspace_invitation_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  invitation_id uuid NOT NULL UNIQUE REFERENCES public.workspace_invitations(id) ON DELETE RESTRICT,
  terms_version_id uuid NOT NULL REFERENCES public.legal_policy_versions(id) ON DELETE RESTRICT,
  terms_content_hash text NOT NULL,
  privacy_version_id uuid NOT NULL REFERENCES public.legal_policy_versions(id) ON DELETE RESTRICT,
  privacy_content_hash text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  locale text,
  acceptance_method text NOT NULL
    CHECK (acceptance_method IN ('email_claim', 'manual_handoff_otp', 'existing_account'))
);

DROP TRIGGER IF EXISTS trg_legal_policy_versions_immutable ON public.legal_policy_versions;
CREATE TRIGGER trg_legal_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON public.legal_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.legal_policy_versions_immutable();

-- =========================================================================
-- 6. Idempotency ledger
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.workspace_invitation_idempotency (
  key text PRIMARY KEY,
  scope_kind text NOT NULL,
  operation text NOT NULL,
  workspace_id uuid,
  invitation_id uuid,
  result_state text NOT NULL,
  response_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitation_idempotency_expiry
  ON public.workspace_invitation_idempotency (expires_at);

-- =========================================================================
-- 7. Authoritative seat-entitlement mode (v5.1 §14, blocker 4)
-- =========================================================================
-- Deliberately NOT app_runtime_config: that table is anon-readable on the
-- hosted chain. PostgreSQL never reads an environment variable; the validated
-- server bootstrap upserts this row through a service-role-only RPC.
CREATE TABLE IF NOT EXISTS public.workspace_seat_entitlement_mode (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL CHECK (mode IN ('plan_authoritative', 'self_host_unlimited')),
  source text NOT NULL,
  seat_limit integer CHECK (seat_limit IS NULL OR seat_limit >= 0),
  config_version integer NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- 8. ACL — RLS on, zero policies, service_role only
-- =========================================================================
DO $$
DECLARE
  _t text;
  _tables text[] := ARRAY[
    'workspace_invitation_tokens',
    'workspace_invitation_otps',
    'workspace_invitation_proofs',
    'workspace_invitation_contexts',
    'workspace_invitation_departments',
    'workspace_invitation_jobs',
    'workspace_invitation_deliveries',
    'workspace_member_details',
    'workspace_member_details_history',
    'legal_policy_versions',
    'workspace_invitation_consents',
    'workspace_invitation_idempotency',
    'workspace_seat_entitlement_mode'
  ];
BEGIN
  FOREACH _t IN ARRAY _tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', _t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', _t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', _t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', _t);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      -- Append-only retention tables never get DELETE.
      IF _t IN ('workspace_invitation_deliveries',
                'workspace_member_details_history',
                'workspace_invitation_consents') THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', _t);
      ELSE
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', _t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- =========================================================================
-- 9. Privilege + shape proofs (043 precedent)
-- =========================================================================
DO $verify$
DECLARE
  _bad text;
BEGIN
  SELECT string_agg(format('%s:%s', t.relname, r.rolname), ', ')
    INTO _bad
  FROM pg_class t
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE t.relnamespace = 'public'::regnamespace
    AND t.relname IN (
      'workspace_invitation_tokens','workspace_invitation_otps','workspace_invitation_proofs',
      'workspace_invitation_contexts','workspace_invitation_departments','workspace_invitation_jobs',
      'workspace_invitation_deliveries','workspace_member_details','workspace_member_details_history',
      'legal_policy_versions','workspace_invitation_consents','workspace_invitation_idempotency',
      'workspace_seat_entitlement_mode')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname)
    AND (
      has_table_privilege(r.rolname, t.oid, 'SELECT')
      OR has_table_privilege(r.rolname, t.oid, 'INSERT')
      OR has_table_privilege(r.rolname, t.oid, 'UPDATE')
      OR has_table_privilege(r.rolname, t.oid, 'DELETE')
    );

  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'invitations v5.1 expand: unexpected client privileges (%)', _bad;
  END IF;

  -- The legacy default must STILL exist here: the compatibility window has
  -- not ended yet. The fence migration is what removes it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.workspace_invitations'::regclass AND a.attname = 'token'
  ) THEN
    RAISE EXCEPTION 'expand migration must preserve the legacy token default';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspace_invitations
    WHERE invitation_flow_version NOT IN (1, 2)
  ) THEN
    RAISE EXCEPTION 'invalid invitation_flow_version present after backfill';
  END IF;
END
$verify$;
