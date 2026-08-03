/**
 * useContactIp — plan-gated contact IP lookup.
 *
 * The IP is never part of the contact payload. It is fetched from a
 * dedicated server endpoint that enforces the `contact_ip_visibility`
 * capability; when the plan does not include it the server returns 403
 * and no IP value ever reaches the browser.
 */
import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import { supabase } from '@/integrations/supabase/client';

export type ContactIpState =
  | { status: 'ok'; ip: string | null }
  | { status: 'locked' };

export function useContactIp(contactId: string | undefined) {
  return useQuery<ContactIpState>({
    queryKey: ['contact-ip', contactId],
    enabled: !!contactId,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/contacts/${contactId}/ip`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status === 403) return { status: 'locked' };
      if (!res.ok) throw new Error(`IP lookup failed: ${res.status}`);
      const body = await res.json();
      return { status: 'ok', ip: (body?.ip as string | null) ?? null };
    },
  });
}
