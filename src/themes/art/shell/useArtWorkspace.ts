/**
 * The active workspace as the Art header presents it: its name, its mark and
 * its domain. Same sources and fallbacks as the classic sidebar's workspace
 * header (src/components/layout/AppSidebar.tsx), and the same query keys, so
 * both read one cache.
 */
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useProfile } from '@/hooks/useProfile';
import { useBranding } from '@/hooks/useBranding';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

export function useArtWorkspace() {
  const { workspace, workspaces } = useActiveWorkspace();
  const { data: profile } = useProfile();
  const { platformName } = useBrandingContext();
  const { data: branding } = useBranding(workspace?.id);

  // GET /api/workspaces/:workspaceId/primary-domain, as in the sidebar.
  const { data: primaryDomain } = useQuery({
    queryKey: ['workspace-primary-domain', workspace?.id],
    enabled: !!workspace,
    queryFn: async () => {
      const res = await fetch(`${RESOLVED_API_BASE}/api/workspaces/${workspace!.id}/primary-domain`, { credentials: 'include' });
      if (!res.ok) return null;
      const { domain } = await res.json();
      return domain as string | null;
    },
    staleTime: 60_000,
  });

  const name = workspace?.name || profile?.company_name || platformName || 'Workspace';

  return {
    workspace,
    workspaces,
    name,
    domain: primaryDomain || profile?.website_domain || workspace?.slug || '',
    logoUrl: (branding?.logo_url as string | null | undefined) || '',
  };
}
