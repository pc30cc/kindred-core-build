/**
 * Super Admin → Notifications data access.
 *
 * The transport status, the device fleet and the dispatch log are read-only
 * observations; only the policy row is writable. Credentials never appear in
 * any of these payloads — see server/routes/adminNotifications.ts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminFetch } from '@/hooks/useAdmin';

export type PushScope = 'all' | 'assigned' | 'mentions' | 'none';
export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive' | 'critical';
export type ThreadStrategy = 'conversation' | 'workspace' | 'none';
export type PushEventType = 'new_message' | 'internal_note' | 'mention';

export interface PushCategoryAction {
  id: string;
  titles: Record<string, string>;
  foreground: boolean;
  destructive: boolean;
  textInput: boolean;
}

export interface PushCategory {
  id: string;
  eventTypes: PushEventType[];
  actions: PushCategoryAction[];
}

export interface PushTemplate {
  title: Record<string, string>;
  body: Record<string, string>;
  privateTitle?: Record<string, string>;
  privateBody?: Record<string, string>;
}

export interface PushPlatformSettings {
  push_enabled: boolean;

  default_scope: PushScope;
  default_preview: boolean;
  default_internal_notes: boolean;
  default_sound: boolean;
  default_quiet_hours_enabled: boolean;
  default_quiet_hours_start: string;
  default_quiet_hours_end: string;
  default_quiet_hours_timezone: string | null;
  mention_bypasses_quiet_hours: boolean;

  apns_priority: number;
  apns_ttl_seconds: number;
  interruption_level: InterruptionLevel;
  relevance_score: number;
  mutable_content: boolean;
  thread_id_strategy: ThreadStrategy;
  collapse_enabled: boolean;
  badge_enabled: boolean;
  sound_name: string;
  critical_alerts_enabled: boolean;
  critical_alert_volume: number;
  provisional_authorization: boolean;
  android_channel_id: string;

  throttle_per_user_per_minute: number;
  dispatch_log_retention_days: number;

  categories: PushCategory[];
  templates: Record<string, PushTemplate>;
  updated_at?: string | null;
}

export interface TransportStatus {
  configured: boolean;
  projectId: string | null;
  clientEmailMasked: string | null;
}

export interface DeviceFleet {
  total: number;
  enabled: number;
  ios: number;
  android: number;
  denied: number;
  activeLast7d: number;
  byVersion: Record<string, number>;
}

export interface DispatchEntry {
  id: string;
  workspace_id: string;
  user_id: string;
  conversation_id: string | null;
  notification_type: string;
  status: string;
  device_count: number;
  accepted_count: number;
  failed_count: number;
  error: string | null;
  created_at: string;
}

const KEY = ['admin', 'notifications'] as const;

export function useNotificationSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () =>
      adminFetch<{ settings: PushPlatformSettings; transport: TransportStatus; provisioned: boolean }>(
        '/api/admin/notifications/settings',
      ),
  });
}

export function useSaveNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<PushPlatformSettings>) =>
      adminFetch<{ success: boolean; settings: PushPlatformSettings }>(
        '/api/admin/notifications/settings',
        { method: 'PUT', body: JSON.stringify(patch) },
      ),
    onSuccess: (data) => {
      qc.setQueryData(KEY, (previous: { settings: PushPlatformSettings } | undefined) =>
        previous ? { ...previous, settings: data.settings } : previous,
      );
    },
  });
}

export function useDeviceFleet() {
  return useQuery({
    queryKey: [...KEY, 'devices'],
    queryFn: () => adminFetch<DeviceFleet>('/api/admin/notifications/devices'),
  });
}

export function useDispatchLog(status: string) {
  return useQuery({
    queryKey: [...KEY, 'log', status],
    queryFn: () =>
      adminFetch<{ entries: DispatchEntry[]; totals: { devices: number; accepted: number; failed: number } }>(
        `/api/admin/notifications/log?limit=50&status=${encodeURIComponent(status)}`,
      ),
  });
}

export function useSendTestNotification() {
  return useMutation({
    mutationFn: (input: { event_type: PushEventType; locale: string; preview: boolean }) =>
      adminFetch<{
        success: boolean;
        devices: number;
        accepted: number;
        failures: { platform: string; status?: number; error?: string }[];
      }>('/api/admin/notifications/test', { method: 'POST', body: JSON.stringify(input) }),
  });
}
