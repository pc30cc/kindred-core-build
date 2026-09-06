-- One VERIFIED domain belongs to exactly one workspace. The widget origin
-- resolver relies on this invariant: without it an origin could resolve to a
-- nondeterministic tenant. (The resolver additionally fails closed if the
-- data ever violates this, but the database is the real guard.)
CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_verified_domain_uniq
  ON public.workspace_domains (normalized_domain)
  WHERE verified;