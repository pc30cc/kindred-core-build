CREATE TABLE IF NOT EXISTS public.invitation_secret_material (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invitation_secret_material ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invitation_secret_material FROM anon, authenticated;
GRANT ALL ON TABLE public.invitation_secret_material TO service_role;