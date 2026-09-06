ALTER TABLE public.workspace_domains
  ADD COLUMN IF NOT EXISTS normalized_domain text
  GENERATED ALWAYS AS (
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(domain)), '^https?://', ''),
        '[:/?#].*$', ''
      ),
      '^www\.', ''
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS workspace_domains_normalized_verified_idx
  ON public.workspace_domains (normalized_domain)
  WHERE verified;

CREATE INDEX IF NOT EXISTS workspace_domains_normalized_idx
  ON public.workspace_domains (normalized_domain);

CREATE INDEX IF NOT EXISTS workspace_domains_workspace_id_idx
  ON public.workspace_domains (workspace_id);