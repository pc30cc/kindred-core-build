import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

/**
 * Where the platform lives, as the platform itself answers it.
 *
 * `GET /api/platform/origins` is public and unauthenticated on purpose: these
 * are hostnames that already appear in DNS, in the widget snippet and in every
 * email the platform sends, and the answer is needed before anyone signs in.
 * It reads `platform_domains` — Super Admin → Branding → Domains — so moving a
 * domain is a settings edit, never a rebuild.
 *
 * This is the same endpoint the native iOS app asks on every launch
 * (see ios/WebyarNative/Sources/Core/Networking/PlatformOrigin.swift). One
 * endpoint, one answer, every client agrees.
 */
export interface PlatformOrigins {
  apiBaseUrl: string | null;
  appBaseUrl: string | null;
  publicBaseUrl: string | null;
  helpCenterUrl: string | null;
  /** Already resolved: the help centre when one is set, else `<public>/help`. */
  supportUrl: string | null;
  canonicalBaseUrl: string | null;
}

export function usePlatformOrigins() {
  return useQuery<PlatformOrigins>({
    queryKey: ['platform-origins'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/platform/origins`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('platform origins unavailable');
      return res.json();
    },
    // One row that changes perhaps twice in a platform's life, and the server
    // caches it for a minute anyway.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
