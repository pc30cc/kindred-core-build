import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

export type PreChatPolicy = 'force_on' | 'force_off' | 'default_on' | 'default_off';
export type FeatureLockMode = 'allow' | 'force_on' | 'force_off';

export interface WidgetPlatformSettings {
  id: string;
  prechat_name_policy: PreChatPolicy;
  prechat_email_policy: PreChatPolicy;
  prechat_phone_policy: PreChatPolicy;
  default_allow_subdomains: boolean;
  max_allowed_domains_per_workspace: number;
  enforce_domain_validation: boolean;
  default_debug_mode: boolean;
  force_chat_enabled: FeatureLockMode;
  force_kb_enabled: FeatureLockMode;
  force_visitor_tracking: FeatureLockMode;
  max_message_length: number;
  rate_limit_messages_per_minute: number;
  admin_notes: string | null;
  // ── Deployment URLs (single source of truth for widget loader/assets/api) ──
  widget_loader_base_url: string | null;
  widget_asset_base_url: string | null;
  widget_public_base_url: string | null;
  widget_api_base_url: string | null;
  // ── Embed snippet wrappers (rendered above/below the <script> tag) ──
  embed_header_comment: string | null;
  embed_footer_comment: string | null;
  // Default operator welcome bubble shown when a visitor opens chat with
  // no prior messages. Workspaces can override via `widget_settings.welcome_message`.
  default_welcome_message: string;
  // ── Phase 1 hardening ──────────────────────────────────────────────
  // Flood / Abuse Protection — per-conversation server-side typing limiter.
  typing_rate_limit_enabled: boolean;
  typing_rate_limit_window_ms: number;
  typing_rate_limit_max_events: number;
  // Realtime / Transport — diagnostic flag for the resubscribe-loop guard.
  realtime_stale_resubscribe_guard_enabled: boolean;
  // ── Phase 2 hardening ──────────────────────────────────────────────
  realtime_reconnect_jitter_pct: number;
  realtime_token_ttl_seconds: number;
  realtime_idle_disposal_ms: number;
  realtime_pending_max: number;
  realtime_message_dedupe_enabled: boolean;
  realtime_message_dedupe_window: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

const QUERY_KEY = ['widget-platform-settings'] as const;

export function useWidgetPlatformSettings() {
  return useQuery({
    queryKey: QUERY_KEY,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/widget-settings/platform/config`, { credentials: 'include' });
      const raw = await res.text();
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(
          `Unexpected response from ${API_BASE}/api/widget-settings/platform/config (HTTP ${res.status}). ` +
            `Body: ${raw.slice(0, 160)}`,
        );
      }
      if (!res.ok) {
        const detail = [json?.error, json?.detail, json?.hint].filter(Boolean).join(' — ');
        throw new Error(detail || `Load failed: HTTP ${res.status}`);
      }
      return (json?.settings ?? null) as WidgetPlatformSettings | null;
    },
  });
}


export function useUpdateWidgetPlatformSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<WidgetPlatformSettings> }) => {
      const res = await fetch(`${API_BASE}/api/widget-settings/platform/config`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Update failed: ${res.status}`);
      return json.settings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
