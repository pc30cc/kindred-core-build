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
  storage_settings_visible: boolean;

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

// ── Shared by both desktop apps ──────────────────────────────────────────

/**
 * Which desktop app a campaign, a broadcast or a live copy belongs to. Ads,
 * announcements, live usage and broadcasts are one pool under
 * /api/admin/desktop-app, targeted per app: an empty `platforms` list means
 * every desktop app.
 */
export type DesktopPlatform = 'windows' | 'macos';
export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ['windows', 'macos'];

/** `?platform=…` for a scoped list, nothing for the unscoped one. */
const platformQuery = (platform?: DesktopPlatform) => (platform ? `?platform=${platform}` : '');

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
  /** Which desktop apps show it; empty (or missing on rows older than migration 211) means both. */
  platforms?: DesktopPlatform[] | null;
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

/** What the editor sends: `platforms` is always a list here, since the server refuses null. */
export type DesktopCampaignInput = Omit<DesktopCampaign, 'id' | 'created_at' | 'updated_at' | 'platforms'> & {
  platforms: DesktopPlatform[];
};

/** Prefix of every campaign list; invalidating it refreshes each app's scoped list at once. */
const CAMPAIGNS_KEY = ['admin', 'desktop-app', 'campaigns'] as const;

/** Without a platform: every row. With one: only the rows that app shows (its own and the shared ones). */
export function useDesktopCampaigns(platform?: DesktopPlatform) {
  return useQuery({
    queryKey: [...CAMPAIGNS_KEY, platform ?? 'all'],
    queryFn: () =>
      adminFetch<{ campaigns: DesktopCampaign[] }>(`/api/admin/desktop-app/campaigns${platformQuery(platform)}`),
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
  /** Copies per app, whatever platform the summary was asked for. */
  platforms: Record<DesktopPlatform, number>;
  /** OS releases among the counted copies, most common first. */
  oses: Array<{ os: string; count: number }>;
  heartbeatSeconds: number;
  since: string;
}

export interface DesktopBroadcast {
  id: string;
  title: string;
  body: string;
  severity: CampaignSeverity;
  url: string | null;
  /** Which apps show it; empty means every desktop app. */
  platforms?: DesktopPlatform[];
  createdAt: string;
}

export interface DesktopBroadcastInput {
  title: string;
  body: string;
  severity: CampaignSeverity;
  url: string;
  /** Empty sends to every desktop app. */
  platforms?: DesktopPlatform[];
}

/** Prefix of every live query; invalidating it refreshes each app's view at once. */
const LIVE_KEY = ['admin', 'desktop-app', 'live'] as const;

/** Without a platform: every running copy. With one: that app's copies and the broadcasts it shows. */
export function useDesktopLive(platform?: DesktopPlatform) {
  return useQuery({
    queryKey: [...LIVE_KEY, platform ?? 'all'],
    queryFn: () =>
      adminFetch<{ live: DesktopLiveSummary; broadcasts: DesktopBroadcast[] }>(
        `/api/admin/desktop-app/live${platformQuery(platform)}`,
      ),
    refetchInterval: 15_000,
  });
}

/** `platform` only scopes the live summary the server answers with; who receives it is `input.platforms`. */
export function useSendDesktopBroadcast(platform?: DesktopPlatform) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DesktopBroadcastInput) =>
      adminFetch(`/api/admin/desktop-app/broadcasts${platformQuery(platform)}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
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
