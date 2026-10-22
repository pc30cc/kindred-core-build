import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { WidgetSettings } from '@/types/models';

export function useWidgetSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-settings', workspaceId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    enabled: !!workspaceId,
  });
}

/**
 * A refused or failed settings save, with what the server said: `code` is its
 * `error` (`plan_upgrade_required`, `Invalid input`, `template_not_available`,
 * …; `network` when the request never got an answer), `issues` the fields a
 * 400 names. `message` is the code, as before.
 */
export class WidgetSettingsSaveError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: Array<{ path: string; message: string }>;
  readonly denied: string[];

  constructor(code: string, status: number, body: { issues?: unknown; denied?: unknown } = {}) {
    super(code);
    this.name = 'WidgetSettingsSaveError';
    this.code = code;
    this.status = status;
    this.issues = Array.isArray(body.issues) ? (body.issues as Array<{ path: string; message: string }>) : [];
    this.denied = Array.isArray(body.denied) ? (body.denied as string[]) : [];
  }
}

/**
 * Below the browsers' 64 KiB budget for requests that outlive the page, so a
 * save sent while the page is being left still arrives (useWidgetSettingsDraft
 * flushes on pagehide).
 */
const KEEPALIVE_MAX_BYTES = 48 * 1024;

/** The platform's period for visitor tracking data (migration 281), from GET /api/widget-settings/:id. */
export interface VisitorRetentionDefault {
  default_days: number | null;
  enabled: boolean;
}

export function useWidgetVisitorRetention(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['widget-settings', workspaceId, 'visitor-retention'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return (json.visitor_retention ?? null) as VisitorRetentionDefault | null;
    },
    enabled: !!workspaceId,
  });
}

export function useUpdateWidgetSettings(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<WidgetSettings>) => {
      const body = JSON.stringify(updates);
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}`, {
          credentials: 'include',
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES,
        });
      } catch {
        throw new WidgetSettingsSaveError('network', 0);
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new WidgetSettingsSaveError(json.error || `Update failed: ${res.status}`, res.status, json);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] });
      void qc.invalidateQueries({ queryKey: ['widget-availability-now', workspaceId] });
    },
  });
}

/** What visitors see right now, from the widget's own resolver (Widget → Availability's "Now" card). */
export interface WidgetAvailabilityNow {
  state: 'online' | 'offline';
  reason: 'within_hours' | 'outside_hours' | 'override_closed' | 'always_offline' | 'no_operators_online' | 'disabled';
  next_open_at: string | null;
  timezone: string;
  offline_mode: WidgetSettings['offline_mode'];
  /** False when the plan does not include business hours (they are then not applied). */
  business_hours_allowed: boolean;
  /** Members visitors may consider, and how many of them are available now. */
  operators: { members: number; available: number };
  checked_at: string;
}

export function useWidgetAvailabilityNow(workspaceId: string | undefined, locale: string) {
  return useQuery({
    queryKey: ['widget-availability-now', workspaceId, locale],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/availability?locale=${encodeURIComponent(locale)}`, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json as WidgetAvailabilityNow;
    },
    enabled: !!workspaceId,
    // Operators come and go: the card follows them while the tab is open.
    refetchInterval: 60_000,
  });
}

/** Widget → Appearance's welcome field: what visitors read while it is empty, and whether the AI agent greets instead. */
export interface WidgetWelcomeInfo {
  /** The platform's default welcome, else the built-in one, in the widget's language. */
  default_text: string;
  /** The AI agent speaks first, so no template shows the welcome. */
  ai_greeting: boolean;
}

export function useWidgetWelcome(workspaceId: string | undefined, locale: string) {
  return useQuery({
    queryKey: ['widget-welcome', workspaceId, locale],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/welcome?locale=${encodeURIComponent(locale)}`, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Load failed: ${res.status}`);
      return json as WidgetWelcomeInfo;
    },
    enabled: !!workspaceId,
  });
}

/**
 * Upload the widget launcher image.
 *
 * The browser hands the BYTES to the backend and nothing else. It does not
 * choose the object key and it never sees — let alone persists — a storage
 * provider URL: the server builds the canonical key, stores the file, and
 * records only that key. The `fab_image_url` that comes back on `settings`
 * is derived from the key for whichever provider is primary, so it changes
 * by itself when the platform promotes a new one.
 */
export function useUploadWidgetFabImage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/fab-image`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentType: file.type,
          data: btoa(binary),
          fileName: file.name,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Upload failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}

/** Remove the launcher image — clears the stored key and deletes the object. */
export function useRemoveWidgetFabImage(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/${workspaceId}/fab-image`, {
        credentials: 'include',
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Remove failed: ${res.status}`);
      return json.settings as WidgetSettings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['widget-settings', workspaceId] }),
  });
}
