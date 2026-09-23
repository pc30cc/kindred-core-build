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

// ── Ads & announcements ──────────────────────────────────────────────────

export type DesktopPlacement = 'banner' | 'inbox_list' | 'colleagues_list' | 'contacts_list' | 'chat_empty' | 'settings';
export type CampaignSeverity = 'info' | 'success' | 'warning' | 'critical';
export type CampaignLocale = 'fa' | 'en' | 'tr';

export interface CampaignText {
  title?: string;
  body?: string;
  cta_label?: string;
}

export interface DesktopCampaign {
  id: string;
  kind: 'ad' | 'announcement';
  name: string;
  placements: DesktopPlacement[];
  target_plans: string[];
  text: Partial<Record<CampaignLocale, CampaignText>>;
  image_url: string | null;
  cta_url: string | null;
  severity: CampaignSeverity;
  dismissible: boolean;
  priority: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export type DesktopCampaignInput = Omit<DesktopCampaign, 'id' | 'created_at' | 'updated_at'>;

const CAMPAIGNS_KEY = ['admin', 'desktop-app', 'campaigns'] as const;

export function useDesktopCampaigns() {
  return useQuery({
    queryKey: CAMPAIGNS_KEY,
    queryFn: () => adminFetch<{ campaigns: DesktopCampaign[] }>('/api/admin/desktop-app/campaigns'),
  });
}

export function useSaveDesktopCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<DesktopCampaignInput> }) =>
      adminFetch<{ campaign: DesktopCampaign }>(
        id ? `/api/admin/desktop-app/campaigns/${id}` : '/api/admin/desktop-app/campaigns',
        { method: id ? 'PUT' : 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });
}

export function useDeleteDesktopCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminFetch(`/api/admin/desktop-app/campaigns/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });
}

export interface AdminPlanOption {
  id: string;
  name: string;
  slug: string;
  is_active?: boolean;
}

export function useAdminPlanOptions() {
  return useQuery({
    queryKey: ['admin', 'desktop-app', 'plans'],
    queryFn: () => adminFetch<{ plans: AdminPlanOption[] }>('/api/plans/admin/all'),
    staleTime: 5 * 60_000,
  });
}

// ── Live usage & broadcasts (memory only on the server) ──────────────────

export interface DesktopLiveSummary {
  online: number;
  users: number;
  workspaces: number;
  versions: Array<{ version: string; count: number }>;
  heartbeatSeconds: number;
  since: string;
}

export interface DesktopBroadcast {
  id: string;
  title: string;
  body: string;
  severity: CampaignSeverity;
  url: string | null;
  createdAt: string;
}

const LIVE_KEY = ['admin', 'desktop-app', 'live'] as const;

export function useDesktopLive() {
  return useQuery({
    queryKey: LIVE_KEY,
    queryFn: () => adminFetch<{ live: DesktopLiveSummary; broadcasts: DesktopBroadcast[] }>('/api/admin/desktop-app/live'),
    refetchInterval: 15_000,
  });
}

export function useSendDesktopBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; body: string; severity: CampaignSeverity; url: string }) =>
      adminFetch('/api/admin/desktop-app/broadcasts', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIVE_KEY }),
  });
}

export function useDeleteDesktopBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminFetch(`/api/admin/desktop-app/broadcasts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LIVE_KEY }),
  });
}
