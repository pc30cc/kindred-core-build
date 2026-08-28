CREATE TABLE IF NOT EXISTS public.channel_provider_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  operation       text NOT NULL,
  workspace_id    uuid NOT NULL,
  integration_id  uuid,
  installation_id uuid,
  status          text NOT NULL DEFAULT 'pending',
  request         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb,
  error_code      text,
  error_message   text,
  requested_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_provider_operations_status_check'
  ) THEN
    ALTER TABLE public.channel_provider_operations
      ADD CONSTRAINT channel_provider_operations_status_check
      CHECK (status IN ('pending','running','succeeded','failed'));
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS channel_provider_operations_pending_idx
  ON public.channel_provider_operations (status, created_at)
  WHERE status IN ('pending','running');

CREATE INDEX IF NOT EXISTS channel_provider_operations_integration_idx
  ON public.channel_provider_operations (integration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS channel_provider_operations_workspace_idx
  ON public.channel_provider_operations (workspace_id, created_at DESC);

GRANT ALL ON public.channel_provider_operations TO service_role;

ALTER TABLE public.channel_provider_operations ENABLE ROW LEVEL SECURITY;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'channel_provider_operations'
      AND policyname = 'channel_provider_operations_service_role'
  ) THEN
    CREATE POLICY channel_provider_operations_service_role
      ON public.channel_provider_operations
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS channel_provider_operations_inflight_unique
  ON public.channel_provider_operations (integration_id, operation)
  WHERE status IN ('pending','running') AND integration_id IS NOT NULL;

COMMENT ON TABLE public.channel_provider_operations IS
  'Durable provider-side operations executed by the Channels Worker. Core never performs provider network I/O.';