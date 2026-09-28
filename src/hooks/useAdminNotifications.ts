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
export type PushEventType =
  | 'new_message'
  | 'internal_note'
  | 'mention'
  | 'assignment'
  | 'handoff'
  | 'team_message'
  | 'email_message'
  | 'callback_request';

/** Every event a phone can be told about, in the order the admin screens list them. */
export const PUSH_EVENT_TYPES: PushEventType[] = [
  'new_message',
  'internal_note',
  'mention',
  'assignment',
  'handoff',
  'team_message',
  'email_message',
  'callback_request',
];

/**
 * The events whose wording comes from Super Admin's templates — a customer's
 * message, a note, a mention. The others are worded by the server in each
 * operator's language, since "{{sender}}" in a template means a customer.
 */
export const TEMPLATE_EVENT_TYPES: PushEventType[] = ['new_message', 'internal_note', 'mention'];

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
  /** The server removes log rows older than the retention on its own. */
  dispatch_log_auto_purge: boolean;

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

/** What the notification log holds — iPhone and Android alike — and its last cleanup. */
export interface DispatchLogStats {
  total: number;
  /** Rows a cleanup at `retentionDays` would remove right now. */
  expired: number;
  oldest: string | null;
  retentionDays: number;
  autoPurge: boolean;
  lastPurgedAt: string | null;
  lastPurgedCount: number | null;
}

export function useDispatchLogStats(days: number) {
  return useQuery({
    queryKey: [...KEY, 'log', 'stats', days],
    queryFn: () => adminFetch<DispatchLogStats>(`/api/admin/notifications/log/stats?days=${days}`),
  });
}

/** "Clean up now": removes every log row older than `days`. */
export function usePurgeDispatchLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) =>
      adminFetch<{ success: boolean; removed: number; days: number; stats: DispatchLogStats }>(
        '/api/admin/notifications/log/purge',
        { method: 'POST', body: JSON.stringify({ days }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'log'] });
    },
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
