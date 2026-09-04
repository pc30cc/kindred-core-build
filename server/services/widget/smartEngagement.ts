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
    .replace(/\u0000/g, '')
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

export function toPublicSmartRule(row: Record<string, any>) {
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
  supabase: any,
  workspaceId: string,
  masterEnabled: boolean,
): Promise<{ enabled: boolean; rules: ReturnType<typeof toPublicSmartRule>[] }> {
  if (!masterEnabled) return { enabled: false, rules: [] };
  try {
    const { data, error } = await supabase
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
      .filter((row: any) => row.published_trigger_config != null
        && row.published_content_config != null
        && row.published_presentation_config != null)
      .map((row: any) => ({
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
      .filter((row: any) => {
        const end = row?.schedule_config?.end_at;
        if (!end) return true;
        const ts = Date.parse(end);
        return !isFinite(ts) || ts >= now;
      })
      .map(toPublicSmartRule);
    return { enabled: true, rules };
  } catch (err: any) {
    console.warn('[smart-engagement] rule load failed:', err?.message || err);
    return { enabled: masterEnabled, rules: [] };
  }
}

const EVENT_TYPES = new Set([
  'shown', 'opened', 'dismissed', 'cta_clicked', 'widget_opened', 'conversation_started', 'suppressed',
]);

export async function recordSmartEvent(
  supabase: any,
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
): Promise<{ ok: boolean; reason?: string }> {
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
    const { data: nudgeRow, error: nudgeErr } = await supabase
      .from('widget_ai_nudges')
      .select('workspace_id')
      .eq('id', payload.aiNudgeId)
      .maybeSingle();
    if (nudgeErr) return { ok: false, reason: nudgeErr.message };
    if (!nudgeRow || nudgeRow.workspace_id !== payload.workspaceId) {
      return { ok: false, reason: 'nudge_workspace_mismatch' };
    }
    const { error } = await supabase.from('widget_smart_events').insert({
      workspace_id: payload.workspaceId,
      source: 'ai_proactive',
      ai_nudge_id: payload.aiNudgeId,
      visitor_id: payload.visitorId || null,
      session_id: payload.sessionId || null,
      event_type: payload.eventType,
      page_path: path,
      idempotency_key: String(payload.idempotencyKey).slice(0, 120),
    });
    if (error && (error as any).code !== '23505') return { ok: false, reason: error.message };
    if (payload.eventType === 'dismissed') {
      void supabase.from('widget_ai_nudges').update({ status: 'dismissed' }).eq('id', payload.aiNudgeId).eq('workspace_id', payload.workspaceId);
    } else if (payload.eventType === 'cta_clicked') {
      void supabase.from('widget_ai_nudges').update({ status: 'clicked' }).eq('id', payload.aiNudgeId).eq('workspace_id', payload.workspaceId);
    }
    return { ok: true };
  }

  if (!payload.ruleId) return { ok: false, reason: 'missing_rule_id' };
  // The event route runs with the service role, which bypasses RLS — verify
  // the rule actually belongs to the resolved workspace before inserting so
  // a forged workspace_id can never attribute telemetry to another tenant's
  // rule (or vice versa).
  const { data: ruleRow, error: ruleErr } = await supabase
    .from('widget_smart_rules')
    .select('workspace_id')
    .eq('id', payload.ruleId)
    .maybeSingle();
  if (ruleErr) return { ok: false, reason: ruleErr.message };
  if (!ruleRow || ruleRow.workspace_id !== payload.workspaceId) {
    return { ok: false, reason: 'rule_workspace_mismatch' };
  }

  const { error } = await supabase.from('widget_smart_events').insert({
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
  if (error && (error as any).code !== '23505') return { ok: false, reason: error.message };
  return { ok: true };
}