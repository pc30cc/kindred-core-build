/**
 * Super Admin → Desktop app data access.
 *
 * One query for the settings row and one mutation that writes it. The server
 * answers a save with the normalized row, which replaces the cache directly
 * so what is shown is always what was stored.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';

export type DesktopUpdateChannel = 'stable' | 'beta';

export interface DesktopAppSettings {
  update_feed_url: string | null;
  update_channel: DesktopUpdateChannel;
  latest_version: string | null;
  minimum_supported_version: string | null;
  download_url: string | null;
  release_notes: string | null;
  auto_update_enabled: boolean;
  update_check_interval_minutes: number;

  realtime_enabled: boolean;
  poll_interval_seconds: number;
  poll_interval_realtime_seconds: number;
  calls_enabled: boolean;

  updated_at?: string | null;
}

export interface DesktopAppPayload {
  settings: DesktopAppSettings;
}

const KEY = ['admin', 'desktop-app'] as const;

export function useDesktopAppSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => adminFetch<DesktopAppPayload>('/api/admin/desktop-app/settings'),
  });
}

export function useSaveDesktopAppSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<DesktopAppSettings>) =>
      adminFetch<DesktopAppPayload & { success: boolean }>('/api/admin/desktop-app/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(KEY, (previous: DesktopAppPayload | undefined) =>
        previous ? { ...previous, settings: data.settings } : { settings: data.settings },
      );
    },
  });
}
