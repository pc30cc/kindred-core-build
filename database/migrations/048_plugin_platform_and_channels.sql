-- 048_plugin_platform_and_channels.sql
--
-- Plugin Platform + Channels Runtime foundation.
--
-- Every table here is BACKEND/SERVICE-ONLY:
--   * no anon grants
--   * no authenticated (browser JWT) grants
--   * RLS enabled with no permissive policies, so even an accidental grant
--     cannot expose rows through PostgREST
-- The browser reaches this data exclusively through the first-party Express
-- Core API. Plugin credentials are stored as AES-256-GCM envelopes; the
-- master key lives only in Core Backend and the Channels Worker env.
--
-- Idempotent: safe to re-run.

-- ── Platform-level plugin state (Super Admin controlled) ──────────────
CREATE TABLE IF NOT EXISTS public.plugin_platform_state (
  plugin_id           text PRIMARY KEY,
  enabled             boolean NOT NULL DEFAULT true,
  marketplace_visible boolean NOT NULL DEFAULT true,
  installable         boolean NOT NULL DEFAULT true,
  maintenance_mode    boolean NOT NULL DEFAULT false,
  featured            boolean NOT NULL DEFAULT false,
  sort_order          integer NOT NULL DEFAULT 100,
  rollout_status      text    NOT NULL DEFAULT 'coming_soon',
  policy              jsonb   NOT NULL DEFAULT '{}'::jsonb,
  defaults            jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  CONSTRAINT plugin_rollout_status_check
    CHECK (rollout_status IN ('hidden','coming_soon','beta','public'))
);

-- ── Workspace installations ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_plugin_installations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plugin_id    text NOT NULL,
  -- Reserved for future multi-instance plugins; Telegram MVP uses 'default'.
  instance_key text NOT NULL DEFAULT 'default',
  status       text NOT NULL DEFAULT 'installed',
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_by uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_plugin_status_check
    CHECK (status IN ('installed','disabled','uninstalled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_plugin_installations_unique
  ON public.workspace_plugin_installations (workspace_id, plugin_id, instance_key);
CREATE INDEX IF NOT EXISTS workspace_plugin_installations_plugin_idx
  ON public.workspace_plugin_installations (plugin_id, status);

-- ── Encrypted plugin credentials (AES-256-GCM envelope) ───────────────
CREATE TABLE IF NOT EXISTS public.plugin_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  secret_key      text NOT NULL,
  key_version     integer NOT NULL DEFAULT 1,
  algorithm       text NOT NULL DEFAULT 'aes-256-gcm',
  nonce           text NOT NULL,        -- base64
  ciphertext      text NOT NULL,        -- base64
  auth_tag        text NOT NULL,        -- base64
  fingerprint     text,                 -- non-reversible, diagnostics only
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_secrets_unique
  ON public.plugin_secrets (installation_id, secret_key);

-- ── Channel integrations (provider account metadata) ──────────────────
CREATE TABLE IF NOT EXISTS public.channel_integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  installation_id       uuid NOT NULL REFERENCES public.workspace_plugin_installations(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  -- Public, non-secret identifier used in the gateway webhook URL.
  public_integration_id text NOT NULL,
  -- Stable provider account id (Telegram bot_id) — uniqueness boundary.
  external_account_id   text,
  display_name          text,
  username              text,
  status                text NOT NULL DEFAULT 'pending',
  webhook_registered_at timestamptz,
  webhook_verified_at   timestamptz,
  last_inbound_at       timestamptz,
  last_outbound_at      timestamptz,
  last_error_code       text,
  last_error_at         timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_integration_status_check
    CHECK (status IN ('pending','connected','disconnected','error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_integrations_public_id_unique
  ON public.channel_integrations (public_integration_id);
-- One provider account may only be actively bound to one workspace.
CREATE UNIQUE INDEX IF NOT EXISTS channel_integrations_account_unique
  ON public.channel_integrations (provider, external_account_id)
  WHERE external_account_id IS NOT NULL AND status <> 'disconnected';
CREATE INDEX IF NOT EXISTS channel_integrations_workspace_idx
  ON public.channel_integrations (workspace_id, provider);

-- ── Durable inbound idempotency ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channel_inbound_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  integration_id    uuid NOT NULL REFERENCES public.channel_integrations(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL,
  external_event_id text NOT NULL,      -- Telegram update_id
  payload           jsonb NOT NULL,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_inbound_events_unique
  ON public.channel_inbound_events (integration_id, external_event_id);
CREATE INDEX IF NOT EXISTS channel_inbound_events_created_idx
  ON public.channel_inbound_events (created_at);

-- ── Generic channel job queue (inbound AND outbound) ──────────────────
CREATE TABLE IF NOT EXISTS public.channel_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  job_type        text NOT NULL,
  workspace_id    uuid NOT NULL,
  integration_id  uuid REFERENCES public.channel_integrations(id) ON DELETE CASCADE,
  -- NEVER contains secrets; the worker resolves credentials by integration id.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending',
  attempt_count   integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 8,
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_at       timestamptz,
  claim_token     uuid,
  claim_expires_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_jobs_status_check
    CHECK (status IN ('pending','running','succeeded','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS channel_jobs_claim_idx
  ON public.channel_jobs (status, available_at, created_at);
CREATE INDEX IF NOT EXISTS channel_jobs_integration_idx
  ON public.channel_jobs (integration_id, status);
CREATE INDEX IF NOT EXISTS channel_jobs_type_idx
  ON public.channel_jobs (job_type, status);

-- ── Delivery attempts (observability) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channel_delivery_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES public.channel_jobs(id) ON DELETE CASCADE,
  attempt     integer NOT NULL,
  status      text NOT NULL,
  error_code  text,
  error_message text,
  latency_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_delivery_attempts_job_idx
  ON public.channel_delivery_attempts (job_id, attempt);

-- ── Worker heartbeat ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channel_worker_heartbeats (
  worker_id    text PRIMARY KEY,
  worker_kind  text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  code_version text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── Grants: service_role only. No anon. No authenticated. ─────────────
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plugin_platform_state',
    'workspace_plugin_installations',
    'plugin_secrets',
    'channel_integrations',
    'channel_inbound_events',
    'channel_jobs',
    'channel_delivery_attempts',
    'channel_worker_heartbeats'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;
END
$do$;

-- ── Atomic job claim (mirrors claim_entitlement_fanout_jobs) ──────────
CREATE OR REPLACE FUNCTION public.claim_channel_jobs(
  _worker_id text,
  _limit integer DEFAULT 5,
  _lease_seconds integer DEFAULT 120,
  _job_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  provider text,
  job_type text,
  workspace_id uuid,
  integration_id uuid,
  payload jsonb,
  attempt_count integer,
  max_attempts integer,
  claim_token uuid,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_lease integer := GREATEST(COALESCE(_lease_seconds, 120), 30);
  v_limit integer := LEAST(GREATEST(COALESCE(_limit, 5), 1), 50);
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id
    FROM public.channel_jobs j
    WHERE j.status IN ('pending','running')
      AND j.available_at <= now()
      AND (j.claim_expires_at IS NULL OR j.claim_expires_at <= now())
      AND (_job_types IS NULL OR j.job_type = ANY(_job_types))
    ORDER BY j.available_at ASC, j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.channel_jobs t
  SET status = 'running',
      attempt_count = t.attempt_count + 1,
      claim_token = v_token,
      locked_by = _worker_id,
      locked_at = now(),
      claim_expires_at = now() + make_interval(secs => v_lease),
      updated_at = now()
  FROM candidate c
  WHERE t.id = c.id
  RETURNING t.id, t.provider, t.job_type, t.workspace_id, t.integration_id,
            t.payload, t.attempt_count, t.max_attempts,
            t.claim_token, t.claim_expires_at;
END;
$$;

DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.claim_channel_jobs(text, integer, integer, text[]) FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_channel_jobs(text, integer, integer, text[]) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_channel_jobs(text, integer, integer, text[]) FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_channel_jobs(text, integer, integer, text[]) TO service_role';
  END IF;
END
$do$;

-- ── Seed platform state for the shipped catalog ───────────────────────
INSERT INTO public.plugin_platform_state
  (plugin_id, enabled, marketplace_visible, installable, featured, sort_order, rollout_status)
VALUES
  ('telegram',   true,  true, true,  true,  10,  'public'),
  ('whatsapp',   true,  true, false, false, 20,  'coming_soon'),
  ('instagram',  true,  true, false, false, 30,  'coming_soon'),
  ('messenger',  true,  true, false, false, 40,  'coming_soon'),
  ('email',      true,  true, false, false, 50,  'coming_soon'),
  ('slack',      true,  true, false, false, 60,  'coming_soon'),
  ('discord',    true,  true, false, false, 70,  'coming_soon'),
  ('sms',        true,  true, false, false, 80,  'coming_soon'),
  ('shopify',    true,  true, false, false, 90,  'coming_soon'),
  ('woocommerce',true,  true, false, false, 100, 'coming_soon'),
  ('hubspot',    true,  true, false, false, 110, 'coming_soon'),
  ('webhooks',   true,  true, false, false, 120, 'coming_soon')
ON CONFLICT (plugin_id) DO NOTHING;
