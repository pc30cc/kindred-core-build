CREATE TABLE IF NOT EXISTS public.operator_presence_fallback_state (
  scope text PRIMARY KEY,
  reason text,
  roster jsonb NOT NULL DEFAULT '[]'::jsonb,
  activated_at timestamptz NOT NULL DEFAULT now(),
  handoff_until timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_presence_fallback_expires
  ON public.operator_presence_fallback_state (expires_at);

GRANT ALL ON public.operator_presence_fallback_state TO service_role;

ALTER TABLE public.operator_presence_fallback_state ENABLE ROW LEVEL SECURITY;