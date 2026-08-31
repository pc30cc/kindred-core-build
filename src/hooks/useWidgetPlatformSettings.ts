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
  // ── Platform-owned "Powered by" footer (super admin only) ──────────
  // Plans gate visibility via the `widget_powered_by` entitlement.
  powered_by_enabled: boolean;
  powered_by_text: string;
  powered_by_brand_text: string | null;
  powered_by_url: string | null;
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

const PLATFORM_PATH = '/api/widget-settings/platform/config';

/**
 * Self-host resilience: when the bundle was built with a cross-origin
 * `VITE_API_BASE_URL` that the browser cannot reach (DNS, mixed content, or a
 * CORS allowlist that omits the admin origin), `fetch` rejects with a bare
 * `TypeError: Failed to fetch` and no diagnostics. In that case we retry the
 * SAME-ORIGIN path, which the standard nginx `/api/` proxy forwards to Express.
 */
async function fetchPlatform(init?: RequestInit): Promise<Response> {
  const bases = API_BASE ? [API_BASE, ''] : [''];
  let lastError: unknown = null;
  let lastResponse: Response | null = null;
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${PLATFORM_PATH}`, { credentials: 'include', ...init });
      lastResponse = response;
      // A configured API host can point at a stale backend release while the
      // same-origin nginx proxy already targets the current Express service.
      // Retry only a route-level 404; auth/database errors must be surfaced
      // unchanged and mutations must never be replayed for other failures.
      if (response.status !== 404 || base === bases[bases.length - 1]) return response;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastResponse) return lastResponse;
  const tried = bases.map((b) => `${b || window.location.origin}${PLATFORM_PATH}`).join(', ');
  throw new Error(
    `Network request failed (${(lastError as Error)?.message || 'Failed to fetch'}). Tried: ${tried}. ` +
      `Check that the backend is reachable from the browser (nginx /api/ proxy or VITE_API_BASE_URL + CORS_ORIGINS).`,
  );
}

export function useWidgetPlatformSettings() {
  return useQuery({
    queryKey: QUERY_KEY,
    retry: 1,
    queryFn: async () => {
      const res = await fetchPlatform();
      const raw = await res.text();
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(
          `Unexpected response from ${PLATFORM_PATH} (HTTP ${res.status}). Body: ${raw.slice(0, 160)}`,
        );
      }
      if (!res.ok) {
        const detail = [json?.error, json?.detail, json?.hint].filter(Boolean).join(' — ');
        if (res.status === 404 && json?.error === 'Not found') {
          throw new Error(
            'The connected Express backend does not contain the widget platform settings route. ' +
              'Redeploy/rebuild the backend from the same source version as the frontend, then retry.',
          );
        }
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
      const res = await fetchPlatform({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      const raw = await res.text();
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Unexpected response (HTTP ${res.status}). Body: ${raw.slice(0, 160)}`);
      }
      if (!res.ok) throw new Error(json?.error || `Update failed: ${res.status}`);
      return json?.settings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

