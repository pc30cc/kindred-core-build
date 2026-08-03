
-- Production-specific domain seed.
-- A fresh local/reset database does not contain this hosted workspace, so the
-- row is inserted only when its real parent workspace exists.
INSERT INTO public.workspace_domains (workspace_id, domain, is_primary, verified)
SELECT
  w.id,
  'destekly.tr',
  true,
  true
FROM public.workspaces AS w
WHERE w.id = '6ee40d07-32a3-4594-8a5f-d439f81afa5b'::uuid
ON CONFLICT DO NOTHING;

-- Enable RLS
ALTER TABLE public.workspace_domains ENABLE ROW LEVEL SECURITY;

-- Drop existing policies one by one (safe approach)
DROP POLICY IF EXISTS "Authenticated users can view domains" ON public.workspace_domains;
DROP POLICY IF EXISTS "Only admins can insert domains" ON public.workspace_domains;
DROP POLICY IF EXISTS "Only admins can update domains" ON public.workspace_domains;
DROP POLICY IF EXISTS "Only admins can delete domains" ON public.workspace_domains;
DROP POLICY IF EXISTS "workspace_domains_select" ON public.workspace_domains;
DROP POLICY IF EXISTS "workspace_domains_insert" ON public.workspace_domains;
DROP POLICY IF EXISTS "workspace_domains_update" ON public.workspace_domains;
DROP POLICY IF EXISTS "workspace_domains_delete" ON public.workspace_domains;

-- Everyone authenticated can read domains
CREATE POLICY "Authenticated users can view domains"
ON public.workspace_domains
FOR SELECT
TO authenticated
USING (true);

-- Only platform admins can insert domains
CREATE POLICY "Only admins can insert domains"
ON public.workspace_domains
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Only platform admins can update domains
CREATE POLICY "Only admins can update domains"
ON public.workspace_domains
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Only platform admins can delete domains
CREATE POLICY "Only admins can delete domains"
ON public.workspace_domains
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
