/**
 * Smart Engagement — server side.
 *
 * Builds the sanitized, minimal public payload the visitor's browser
 * receives, and records interaction events. The management columns
 * (description, authorship, timestamps, draft content) never leave the
 * server.
 *
 * NOTE: rule *evaluation* lives in one place only —
 * `src/lib/widget/smartEngine.ts`, bundled to
 * `public/widget/smart-engine.js`. This module must never re-implement it.
 */

import type { ServerConfig } from '../../config.js';
import type { ServiceClient } from '../../supabase.js';

export const SMART_PUBLIC_RULE_LIMIT = 20;
const MAX_BODY = 400;
const MAX_TITLE = 80;
const MAX_CTA = 40;

export function sanitizeSmartText(input: unknown, max = MAX_BODY): string {
  return String(input == null ? '' : input)
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\son[a-z]+\s*=/gi, ' ')
    .replace(/javascript:/gi, '')
    .split('\u0000').join('')
    .slice(0, max);
}

export function isSafeSmartUrl(url: unknown): boolean {
  if (!url) return false;
  const raw = String(url).trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The published rule columns toPublicSmartRule reads; JSON configs stay opaque. */
interface SmartRuleSource {
  id?: unknown;
  status?: unknown;
  priority?: unknown;
  schema_version?: unknown;
  published_version?: unknown;
  trigger_config?: unknown;
  audience_config?: unknown;
  content_config?: {
    default_locale?: string;
    locales?: Record<string, { title?: unknown; body?: unknown; cta_label?: unknown } | null | undefined>;
  } | null;
  presentation_config?: {
    mode?: unknown;
    action?: string;
    article_slug?: string | null;
    url?: unknown;
    open_in_new_tab?: unknown;
    dismissible?: unknown;
  } | null;
  schedule_config?: unknown;
  frequency_config?: unknown;
  behavior_config?: unknown;
}

export function toPublicSmartRule(row: SmartRuleSource) {
  const content = row.content_config || { default_locale: 'en', locales: {} };
  const locales: Record<string, { title: string; body: string; cta_label: string }> = {};
  for (const key of Object.keys(content.locales || {})) {
    const entry = content.locales[key] || {};
    locales[key] = {
      title: sanitizeSmartText(entry.title, MAX_TITLE),
      body: sanitizeSmartText(entry.body, MAX_BODY),
      cta_label: sanitizeSmartText(entry.cta_label, MAX_CTA),
    };
  }
  const presentation = row.presentation_config || {};
  return {
    id: String(row.id),
    name: '',
    status: row.status,
    priority: Number(row.priority) || 0,
    schema_version: Number(row.schema_version) || 1,
    version: Number(row.published_version) || 1,
    trigger_config: row.trigger_config,
    audience_config: row.audience_config,
    content_config: { default_locale: content.default_locale || 'en', locales },
    presentation_config: {
      mode: presentation.mode,
      action: presentation.action || 'none',
      article_slug: presentation.article_slug || null,
      url: isSafeSmartUrl(presentation.url) ? presentation.url : null,
      open_in_new_tab: presentation.open_in_new_tab !== false,
      dismissible: presentation.dismissible !== false,
    },
    schedule_config: row.schedule_config || {},
    frequency_config: row.frequency_config || { mode: 'once_per_session' },
    behavior_config: row.behavior_config || {},
  };
}

/**
 * Published + active rules only. Drafts and paused rules are never sent to
 * a visitor, and an expired schedule is filtered out server side so the
 * payload stays small.
 */
export async function loadPublicSmartRules(
  /** The service client; `unknown` so a test can hand in a minimal fake. */
  supabase: unknown,
  workspaceId: string,
  masterEnabled: boolean,
): Promise<{ enabled: boolean; rules: ReturnType<typeof toPublicSmartRule>[] }> {
  if (!masterEnabled) return { enabled: false, rules: [] };
  try {
    const { data, error } = await (supabase as ServiceClient)
      .from('widget_smart_rules')
      .select('id, status, priority, schema_version, published_version, published_trigger_config, published_audience_config, published_content_config, published_presentation_config, published_schedule_config, published_frequency_config, published_behavior_config, published_priority, published_schema_version, published_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .gt('published_version', 0)
      .order('priority', { ascending: false })
      .limit(SMART_PUBLIC_RULE_LIMIT);
    if (error) throw error;
    const now = Date.now();
    const rules = (data || [])
      // A row with no published snapshot has never been published (or was
      // unpublished) — never fall back to the draft columns.
      .filter((row) => row.published_trigger_config != null
        && row.published_content_config != null
        && row.published_presentation_config != null)
      .map((row) => ({
        id: row.id,
        status: row.status,
        priority: row.published_priority,
        schema_version: row.published_schema_version,
        published_version: row.published_version,
        trigger_config: row.published_trigger_config,
        audience_config: row.published_audience_config,
        content_config: row.published_content_config,
        presentation_config: row.published_presentation_config,
        schedule_config: row.published_schedule_config,
        frequency_config: row.published_frequency_config,
        behavior_config: row.published_behavior_config,
      }))
      .filter((row) => {
        const end = (row?.schedule_config as { end_at?: string } | null)?.end_at;
        if (!end) return true;
        const ts = Date.parse(end);
        return !isFinite(ts) || ts >= now;
      })
      .map(toPublicSmartRule);
    return { enabled: true, rules };
  } catch (err) {
    console.warn('[smart-engagement] rule load failed:', err?.message || err);
    return { enabled: masterEnabled, rules: [] };
  }
}

const EVENT_TYPES = new Set([
  'shown', 'opened', 'dismissed', 'cta_clicked', 'widget_opened', 'conversation_started', 'suppressed',
]);

export async function recordSmartEvent(
  /** The service client; `unknown` so the security tests can hand in a fake. */
  supabase: unknown,
  payload: {
    workspaceId: string;
    ruleId?: string | null;
    ruleVersion?: number;
    /** AI Proactive Nudge lifecycle events reference widget_ai_nudges instead of a rule. */
    source?: 'rule' | 'ai_proactive';
    aiNudgeId?: string | null;
    visitorId?: string | null;
    sessionId?: string | null;
    eventType: string;
    pagePath?: string | null;
    idempotencyKey: string;
  },
  /**
   * Optional so existing direct callers (the cross-workspace security tests)
   * keep compiling and keep exercising the write.
   *
   * Of the two callers in server/routes/widget.ts, only :1127 (the 'rule'
   * branch) passes it — and that is the only one that can reach this insert.
   * :2325 uses source:'ai_proactive', which returns earlier and never writes,
   * so it correctly omits config. PRODUCT_ANALYTICS_LOGGING therefore does
   * reach every reachable write site, but not because every caller passes it.
   */
  config?: ServerConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const sb = supabase as ServiceClient;
  if (!EVENT_TYPES.has(payload.eventType)) return { ok: false, reason: 'invalid_event_type' };
  if (!payload.idempotencyKey) return { ok: false, reason: 'missing_idempotency_key' };

  const source = payload.source || 'rule';
  const path = payload.pagePath ? String(payload.pagePath).split('?')[0].slice(0, 300) : null;

  if (source === 'ai_proactive') {
    if (!payload.aiNudgeId) return { ok: false, reason: 'missing_nudge_id' };
    // Same tenant-isolation principle as the rule branch below: the event
    // route runs with the service role (bypasses RLS) — verify the nudge
    // actually belongs to the resolved workspace before inserting, so a
    // forged/cross-workspace nudge_id can never attribute an event to
    // another tenant's data.
    const { data: nudgeRow, error: nudgeErr } = await sb
      .from('widget_ai_nudges')
      .select('workspace_id')
      .eq('id', payload.aiNudgeId)
      .maybeSingle();
    if (nudgeErr) return { ok: false, reason: nudgeErr.message };
    if (!nudgeRow || nudgeRow.workspace_id !== payload.workspaceId) {
      return { ok: false, reason: 'nudge_workspace_mismatch' };
    }

    // ─── Lifecycle + event recording: ONE atomic server-side RPC call.
    // This is the ONLY place an 'ai_proactive' status ever changes and the
    // ONLY place an 'ai_proactive' widget_smart_events row is inserted, so
    // they can never disagree. The idempotency key is derived INSIDE the
    // RPC from immutable identifiers (workspace/nudge/event type) —
    // payload.idempotencyKey (client-controlled, built from a rotating
    // client session id) is NEVER used for this source. Out-of-order
    // arrival (e.g. a click racing ahead of the shown ack) is absorbed by
    // the RPC atomically backfilling the implied shown step first; an
    // invalid transition returns ok:false without inserting any event. ───
    const { data: rpcData, error: rpcError } = await sb.rpc('ai_nudge_apply_lifecycle_event', {
      _workspace_id: payload.workspaceId,
      _nudge_id: payload.aiNudgeId,
      _event_type: payload.eventType,
      _visitor_id: payload.visitorId || null,
      _session_id: payload.sessionId || null,
      _page_path: path,
    });
    if (rpcError) return { ok: false, reason: rpcError.message };
    const result = rpcData as { ok?: boolean; reason?: string } | null;
    if (!result || !result.ok) return { ok: false, reason: result?.reason || 'lifecycle_event_rejected' };
    return { ok: true };
  }

  if (!payload.ruleId) return { ok: false, reason: 'missing_rule_id' };
  // The event route runs with the service role, which bypasses RLS — verify
  // the rule actually belongs to the resolved workspace before inserting so
  // a forged workspace_id can never attribute telemetry to another tenant's
  // rule (or vice versa).
  const { data: ruleRow, error: ruleErr } = await sb
    .from('widget_smart_rules')
    .select('workspace_id')
    .eq('id', payload.ruleId)
    .maybeSingle();
  if (ruleErr) return { ok: false, reason: ruleErr.message };
  if (!ruleRow || ruleRow.workspace_id !== payload.workspaceId) {
    return { ok: false, reason: 'rule_workspace_mismatch' };
  }

  // PRODUCT_ANALYTICS_LOGGING — conversion telemetry for smart rules, read
  // only by the smart-rule analytics panel. Placed AFTER the tenant check
  // above on purpose: a forged/cross-workspace rule_id still gets its
  // `rule_workspace_mismatch` answer whether or not the row is kept, so the
  // flag removes the write and nothing else. Only this TypeScript half is
  // reachable — 'ai_proactive' events are inserted by the
  // ai_nudge_apply_lifecycle_event SQL function and are out of reach of any
  // env flag. `config` is optional so the security tests, which call this
  // helper directly with a fake client, keep exercising the write path.
  if (config?.productAnalyticsLoggingEnabled === false) return { ok: true };

  // 'suppressed' (a rule that evaluated but did not show: mobile disabled,
  // chat open, another rule showing, …) is accepted and not stored. The
  // widget reports one per page view per suppressed rule, before any
  // audience or page check, and nothing reads them back: the smart-rule
  // stats count only shown / opened / dismissed / CTA / conversation events,
  // and the AI nudge stats read their own source. Stored, they were the
  // bulk of this table's writes — and, because the stats read at most 5,000
  // rows of every type, they crowded real events out of the 30-day numbers.
  // Placed after the tenant check, like the flag above, so a forged rule_id
  // still gets the same answer.
  if (payload.eventType === 'suppressed') return { ok: true };

  const { error } = await sb.from('widget_smart_events').insert({
    workspace_id: payload.workspaceId,
    source: 'rule',
    rule_id: payload.ruleId,
    rule_version: payload.ruleVersion || 1,
    visitor_id: payload.visitorId || null,
    session_id: payload.sessionId || null,
    event_type: payload.eventType,
    page_path: path,
    idempotency_key: String(payload.idempotencyKey).slice(0, 120),
  });
  // 23505 = duplicate idempotency key → already recorded, treat as success.
  if (error && error.code !== '23505') return { ok: false, reason: error.message };
  return { ok: true };
}