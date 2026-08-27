/**
 * ============================================================
 * CENTRAL CAPABILITY REGISTRY
 * ------------------------------------------------------------
 * Single source of truth for entitlement/module/channel/limit
 * keys consumed by:
 *   - Admin plan editor (rendering)
 *   - App-side billing UI (display)
 *   - Backend validation & diagnostics (plan payload sanity)
 *   - Effective-state aggregation
 *
 * Design rules:
 *  1. Additive only. Existing keys MUST NOT be renamed.
 *  2. Keys here mirror what is already stored in
 *     `billing_plans.entitlements` / `billing_plans.limits`
 *     and what `requireFeature/requireModule/requireChannel`
 *     middleware consumes. Adding to this registry does NOT
 *     change any contract — it only documents and centralises.
 *  3. The registry is metadata. Plan JSON values, workspace
 *     overrides, usage counters, and middleware enforcement
 *     remain authoritative — see docs/ENTITLEMENT_ARCHITECTURE.md.
 * ============================================================
 */

export type CapabilityType = 'feature' | 'module' | 'channel' | 'limit';
export type CapabilityUnit =
  | 'count' | 'bytes' | 'mb' | 'gb' | 'seconds' | 'minutes'
  | 'per_month' | 'per_day' | 'percent' | 'boolean' | 'days';

export interface CapabilityDefinition {
  /** Stable key. MUST match existing plan JSON / middleware key. */
  key: string;
  type: CapabilityType;
  /** Short, user-facing label (English; localisation handled in UI). */
  label: string;
  description?: string;
  /** Logical grouping for admin/app UI. */
  group: string;
  /** Default value applied when neither plan nor override defines it. */
  defaultValue: boolean | number | null;
  /** Whether Super Admin can configure this on a plan. */
  planConfigurable: boolean;
  /** Whether Super Admin can override this per workspace. */
  workspaceOverridable: boolean;
  /** Whether this should appear in customer-facing billing UI. */
  userVisible: boolean;
  /** Internal/admin-only — never shown to end users. */
  internalOnly?: boolean;
  /** Unit hint for `limit` types. */
  unit?: CapabilityUnit;
  /** Sort order within group (ascending). */
  sortOrder?: number;
}

/**
 * The registry. Keep this list aligned with the keys actually
 * read by `featureGating.ts`, `aiAgent`, `aiKb`, plan defaults,
 * and the admin/app billing UI.
 */
export const CAPABILITY_REGISTRY: CapabilityDefinition[] = [
  // ─── Modules (boolean access at module level) ───
  { key: 'chat',              type: 'module', label: 'Live Chat',          group: 'modules', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
  { key: 'knowledge_base',    type: 'module', label: 'Knowledge Base',     group: 'modules', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 20 },
  { key: 'ai_assistant',      type: 'module', label: 'AI Assistant',       group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 30 },
  { key: 'visitor_tracking',  type: 'module', label: 'Visitor Tracking',   group: 'modules', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 40 },
  { key: 'email_campaigns',   type: 'module', label: 'Email Campaigns',    group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 50 },
  { key: 'automation',        type: 'module', label: 'Automation',         group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 60 },
  { key: 'analytics',         type: 'module', label: 'Analytics',          group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 70 },
  { key: 'omnichannel',       type: 'module', label: 'Omnichannel',        group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 80 },
  { key: 'custom_branding',   type: 'module', label: 'Custom Branding',    group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 90 },
  { key: 'api_access',        type: 'module', label: 'API Access',         group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 100 },
  { key: 'voice_video',       type: 'module', label: 'Voice & Video',      group: 'modules', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 110 },
  { key: 'help_center',       type: 'module', label: 'Help Center',        group: 'modules', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 120 },
  { key: 'call_center',       type: 'module', label: 'Call Center',        group: 'modules', description: 'Call queue, routing, invitations and callbacks suite. Bounded by Voice & Video and the global call control plane.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 115 },
  { key: 'contacts',          type: 'module', label: 'Contacts',           group: 'modules', description: 'Contacts directory: saved contact records, search, tagging, notes and detail view. Sub-features (import/export/bulk/tags/notes) live under the "contacts" feature group.', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 125 },

  // ─── Channels ───
  { key: 'chat_widget', type: 'channel', label: 'Chat Widget', group: 'channels', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
  { key: 'email',       type: 'channel', label: 'Email',       group: 'channels', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 20 },
  { key: 'whatsapp',    type: 'channel', label: 'WhatsApp',    group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 30 },
  { key: 'sms',         type: 'channel', label: 'SMS',         group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 40 },
  { key: 'instagram',   type: 'channel', label: 'Instagram',   group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 50 },
  { key: 'telegram',    type: 'channel', label: 'Telegram',    group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 60 },
  { key: 'voice',       type: 'channel', label: 'Voice Calls', group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 70 },
  { key: 'video',       type: 'channel', label: 'Video Calls', group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 80 },

  // ─── Boolean feature flags ───
  { key: 'advanced_ai_agent',     type: 'feature', label: 'Advanced AI Agent',      group: 'ai',       defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 10 },
  { key: 'ai_operator_assist',    type: 'feature', label: 'AI Operator Assist',     group: 'ai',       defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 20 },
  { key: 'ai_kb_builder',         type: 'feature', label: 'AI KB Builder',          group: 'ai',       defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 30 },
  { key: 'priority_support',      type: 'feature', label: 'Priority Support',       group: 'support',  defaultValue: false, planConfigurable: true, workspaceOverridable: false, userVisible: true, sortOrder: 10 },
  { key: 'sso',                   type: 'feature', label: 'SSO / SAML',             group: 'security', defaultValue: false, planConfigurable: true, workspaceOverridable: false, userVisible: true, sortOrder: 10 },
  { key: 'audit_logs',            type: 'feature', label: 'Audit Logs',             group: 'security', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 20 },
  { key: 'white_label',           type: 'feature', label: 'White-label Branding',   group: 'branding', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 10 },
  { key: 'remove_powered_by',     type: 'feature', label: 'Remove "Powered by"',    group: 'branding', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 20 },

  // ─── Call surface features (plan-level toggles bounded by call control plane) ───
  { key: 'call_recording',        type: 'feature', label: 'Call Recording',         group: 'calls',    description: 'Allow operators to record voice/video calls. Bounded by global call_recording_enabled_global runtime gate.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 10 },
  { key: 'call_queue',            type: 'feature', label: 'Call Queue',             group: 'calls',    description: 'Plan-level access to the call queue / routing surface. Bounded by global call_queue_enabled_global runtime gate.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 20 },
  { key: 'call_callbacks',        type: 'feature', label: 'Call Callbacks',         group: 'calls',    description: 'Allow visitors to request a callback when SLA is breached. Bounded by global callback_offer_after_timeout runtime gate.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 30 },

  // ─── Contacts surface features (bounded by the `contacts` module) ───
  { key: 'contact_import',        type: 'feature', label: 'Contact Import',         group: 'contacts', description: 'CSV import wizard for bulk-creating contact records. Bounded by the Contacts module.',                                  defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 10 },
  { key: 'contact_create',        type: 'feature', label: 'Contact Create',         group: 'contacts', description: 'Manually create new contact records from the contacts directory. Bounded by the Contacts module.',                       defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 12 },
  { key: 'contact_edit',          type: 'feature', label: 'Contact Edit',           group: 'contacts', description: 'Edit existing contact records (name, email, phone, notes, tags). Bounded by the Contacts module.',                       defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 14 },
  { key: 'contact_export',        type: 'feature', label: 'Contact Export',         group: 'contacts', description: 'Export the contacts directory to CSV. Bounded by the Contacts module.',                                                defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 20 },
  { key: 'contact_tags',          type: 'feature', label: 'Contact Tags',           group: 'contacts', description: 'Tagging, tag filtering and tag-based grouping on contact records. Bounded by the Contacts module.',                       defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 30 },
  { key: 'contact_notes',         type: 'feature', label: 'Contact Notes',          group: 'contacts', description: 'Free-form notes attached to a contact record. Bounded by the Contacts module.',                                          defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 40 },
  { key: 'bulk_contact_actions',  type: 'feature', label: 'Bulk Contact Actions',   group: 'contacts', description: 'Multi-select bulk operations (e.g. bulk delete) on the contacts directory. Bounded by the Contacts module.',               defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 50 },
  { key: 'contact_ip_visibility', type: 'feature', label: 'Contact IP Visibility',  group: 'contacts', description: 'Reveal the visitor IP address on the contact detail page. When disabled the IP is never sent to the client (server-side redaction). Bounded by the Contacts module.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true,  sortOrder: 60 },

  // ─── Numeric limits ───
  { key: 'max_agents',            type: 'limit', label: 'Max Agents',                 group: 'team',  defaultValue: 1,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 10 },
  { key: 'max_workspaces',        type: 'limit', label: 'Max Workspaces',             group: 'team',  defaultValue: 1,    planConfigurable: true, workspaceOverridable: false, userVisible: true, unit: 'count', sortOrder: 20 },
  { key: 'max_conversations',     type: 'limit', label: 'Conversations / month',      group: 'usage', defaultValue: 100,  planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 10 },
  { key: 'max_visitors',          type: 'limit', label: 'Tracked Visitors / month',   group: 'usage', defaultValue: 1000, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 20 },
  { key: 'ai_credits_per_month',  type: 'limit', label: 'AI Credits / month',         group: 'ai',    defaultValue: 0,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 100 },
  // AI KB Builder — historical/canonical owner of these three keys. Also
  // read (as a legacy fallback only) by AI Agent's own Web Pages ingestion
  // when the ai_agent_web_source_* keys below are absent from a plan — see
  // server/services/ai-agent/limits.ts and docs/PLAN_DATA_RECONCILIATION.md.
  { key: 'ai_kb_max_pages',       type: 'limit', label: 'AI KB Builder — Max pages per crawl', group: 'ai', description: 'AI KB Builder website-crawl page cap. Historical key: also used as the legacy fallback for AI Agent Web Pages ingestion when ai_agent_web_source_max_pages is unset.', defaultValue: 50,   planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 110 },
  { key: 'ai_kb_max_depth',       type: 'limit', label: 'AI KB Builder — Crawl depth',          group: 'ai', description: 'AI KB Builder website-crawl depth cap. Historical key: also used as the legacy fallback for AI Agent Web Pages ingestion when ai_agent_web_source_max_depth is unset.', defaultValue: 2,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 120 },
  { key: 'ai_kb_jobs_per_month',  type: 'limit', label: 'AI KB Builder — Jobs / month',         group: 'ai', description: 'AI KB Builder crawl jobs per month. Historical key: also used as the legacy fallback for AI Agent Web Pages ingestion when ai_agent_web_source_jobs_per_month is unset.', defaultValue: 5,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 130 },
  // AI Agent — Web Pages (Data Hub) source ingestion. New, AI-Agent-only
  // keys; absent on any plan created before this key-separation fix, in
  // which case the resolver falls back to the ai_kb_* keys above.
  { key: 'ai_agent_web_source_max_pages',      type: 'limit', label: 'AI Agent — Web Pages: Max pages per source', group: 'ai', description: 'Overrides ai_kb_max_pages for AI Agent Web Pages (Data Hub) source ingestion only. Leave unset to keep using the shared/legacy ai_kb_max_pages value.', defaultValue: 50,   planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 111 },
  { key: 'ai_agent_web_source_max_depth',      type: 'limit', label: 'AI Agent — Web Pages: Crawl depth',          group: 'ai', description: 'Overrides ai_kb_max_depth for AI Agent Web Pages (Data Hub) source ingestion only. Leave unset to keep using the shared/legacy ai_kb_max_depth value.', defaultValue: 2,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 121 },
  { key: 'ai_agent_web_source_jobs_per_month', type: 'limit', label: 'AI Agent — Web Pages: Sync jobs / month',    group: 'ai', description: 'Overrides ai_kb_jobs_per_month for AI Agent Web Pages (Data Hub) source ingestion only. Leave unset to keep using the shared/legacy ai_kb_jobs_per_month value.', defaultValue: 5,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'per_month', sortOrder: 131 },
  { key: 'ai_kb_file_size_mb',    type: 'limit', label: 'AI Agent — Max file size',   group: 'ai',    defaultValue: 10,   planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'mb', sortOrder: 140 },
  { key: 'ai_kb_file_count',      type: 'limit', label: 'AI Agent — Max files',       group: 'ai',    defaultValue: 20,   planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 150 },
  { key: 'storage_gb',            type: 'limit', label: 'Storage',                    group: 'usage', defaultValue: 1,    planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'gb', sortOrder: 30 },
  { key: 'data_retention_days',   type: 'limit', label: 'Data Retention',             group: 'usage', defaultValue: 30,   planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'days', sortOrder: 40 },
  { key: 'max_contacts',          type: 'limit', label: 'Max Contacts',               group: 'contacts', description: 'Maximum number of contact records (rows in public.contacts) per workspace at any one time. Occupancy semantics: deletes free capacity; edits/tags/notes do not consume. Enforced by POST /api/contacts and POST /api/contacts/bulk via requireLimit + live count(*).', defaultValue: 100, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 60 },
  { key: 'max_concurrent_calls',  type: 'limit', label: 'Max Concurrent Calls',       group: 'calls',    description: 'Workspace-wide ceiling on simultaneously-active call_sessions (canonical active set: pending, ringing, connecting, active, all entry_source values). Enforced at create-time on POST /api/calls/create (operator) and POST /api/widget/calls/request (visitor) via canonical derived count. Composes additively with the widget-scoped platform-admin knob platform_call_center_settings.max_concurrent_calls_per_workspace — both ceilings may deny new work; first denial wins. -1 = unlimited.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 70 },
  { key: 'max_call_minutes_per_month', type: 'limit', label: 'Call Minutes / Month', group: 'calls', description: 'Monthly cap on billable call minutes per workspace (UTC month). Billable = connected calls only: CEIL((ended_at - connected_at) / 60) per finalized call. Pre-connect, queue, hold, and recording-only time do not count. Usage is aggregated by the DB trigger tg_call_sessions_bill_minutes into workspace_usage_counters.call_minutes_used (sole writer). Enforced at create-time on POST /api/calls/create and POST /api/widget/calls/request via checkPlanMonthlyMinutesCeiling. -1 = unlimited.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'minutes', sortOrder: 80 },
  { key: 'recording_retention_days', type: 'limit', label: 'Call Recording Retention', group: 'calls', description: 'Maximum number of days a call recording is retained before the recording janitor hard-deletes it. Subject set: rows in public.call_recordings with legal_hold = false. Clock: stamped once on insert as retention_expires_at = created_at + effective_days; the value is locked at creation time, so plan changes only affect future recordings. -1 = unlimited (retention_expires_at left NULL; janitor never selects the row). Enforced exclusively by server/services/recordings/retentionJanitor.ts — there is no other deletion path. See docs/CALL_RECORDING_RETENTION.md.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'days', sortOrder: 90 },
  { key: 'max_call_recordings',       type: 'limit', label: 'Max Call Recordings',     group: 'calls', description: 'Lifetime cap on the number of stored call recordings for the workspace. Subject set: rows in public.call_recordings joined to call_sessions where workspace_id = $1. Live derived count(*). Enforced at recording-start time by server/services/callCenter/recordingControl.ts#startCallCenterRecording before invoking the provider. Deleting a recording frees capacity (occupancy semantics). -1 = unlimited.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 100 },
  { key: 'max_call_recording_storage_mb', type: 'limit', label: 'Recording Storage', group: 'calls', description: 'Lifetime cap on aggregate stored size (MiB) of call recordings for the workspace. Source: SUM(call_recordings.size_bytes) joined to call_sessions where workspace_id = $1, converted to MiB. Enforced at recording-start time by server/services/callCenter/recordingControl.ts#startCallCenterRecording before invoking the provider. Deleting a recording frees capacity. -1 = unlimited.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'mb', sortOrder: 110 },
];

// ─── Helpers ───

const BY_KEY: Map<string, CapabilityDefinition> = new Map(
  CAPABILITY_REGISTRY.map((c) => [c.key, c]),
);

export function getCapability(key: string): CapabilityDefinition | undefined {
  return BY_KEY.get(key);
}

export function listCapabilities(filter?: { type?: CapabilityType; group?: string }): CapabilityDefinition[] {
  return CAPABILITY_REGISTRY.filter((c) =>
    (!filter?.type || c.type === filter.type) &&
    (!filter?.group || c.group === filter.group),
  );
}

/**
 * Subset of registry limit keys that have a working usage resolver in
 * `server/services/billing/usageResolvers.ts`. Listed here (rather than
 * imported) to avoid pulling backend-only resolver code into this module.
 * Keep in sync with the `RESOLVERS` map there.
 */
export const USAGE_BACKED_LIMIT_KEYS: readonly string[] = [
  'max_conversations',
  'max_visitors',
  'storage_gb',
  'ai_kb_jobs_per_month',
  'ai_credits_per_month',
  'max_contacts',
  'max_agents',
  'max_concurrent_calls',
  'max_call_minutes_per_month',
  'max_call_recordings',
  'max_call_recording_storage_mb',
];

/**
 * Additive normalizer used when CREATING a new plan. Ensures resolver-ready
 * limit keys are present so future `requireLimit(...)` enforcement does not
 * fail-closed on the new plan.
 *
 * Rules:
 *   - Never overwrites a value the caller supplied.
 *   - Only fills missing keys with the registry `defaultValue`.
 *   - Only touches keys in `USAGE_BACKED_LIMIT_KEYS`; legacy/unknown keys
 *     are passed through untouched.
 *
 * Returns a new object — does not mutate the input.
 */
export function normalizePlanLimitsForCreate(
  limits: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(limits || {}) };
  for (const key of USAGE_BACKED_LIMIT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    const def = BY_KEY.get(key);
    if (def && typeof def.defaultValue === 'number') {
      out[key] = def.defaultValue;
    }
  }
  return out;
}

/**
 * Validate a plan payload's `entitlements` + `limits` against
 * the registry. Returns issues; never throws.
 *
 * Backward-compatible: unknown keys are reported as warnings,
 * not errors — they remain accepted by the existing CRUD API.
 */
export interface PlanValidationIssue {
  level: 'error' | 'warning';
  key: string;
  message: string;
}

/**
 * Legacy plan keys that predate the capability registry. They are still
 * stored on plan rows (external billing/reporting may read them) but no
 * code path resolves them through the registry, so they must NOT be
 * reported as drift every time an admin saves a plan.
 */
export const LEGACY_PLAN_KEYS = new Set<string>([
  // entitlements
  'advanced_analytics',
  'ai_enabled',
  // limits
  'ai_kb_max_articles',
  'ai_kb_max_chars',
  'ai_kb_monthly_credits',
  'ai_requests_monthly',
  'conversations_monthly',
  'kb_articles',
  'storage_mb',
  'team_members',
  'contacts',
  'agents',
  'ai_credits',
  'conversations',
  'file_storage_mb',
]);

export function validatePlanPayload(payload: {
  entitlements?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}): { valid: boolean; issues: PlanValidationIssue[] } {
  const issues: PlanValidationIssue[] = [];
  const ent = payload.entitlements || {};
  const lim = payload.limits || {};


  for (const [key, value] of Object.entries(ent)) {
    const def = BY_KEY.get(key);
    const legacy = LEGACY_PLAN_KEYS.has(key);
    if (!def) {
      if (!legacy) {
        issues.push({ level: 'warning', key, message: `Unknown entitlement key '${key}' (not in registry)` });
      }
      if (typeof value !== 'boolean') {
        issues.push({ level: 'error', key, message: `Entitlement '${key}' must be boolean` });
      }
      continue;
    }
    if (def.type === 'limit' && !legacy) {
      issues.push({ level: 'warning', key, message: `Key '${key}' is a limit; expected in 'limits' not 'entitlements'` });
    }
    if (typeof value !== 'boolean') {
      issues.push({ level: 'error', key, message: `Entitlement '${key}' must be boolean` });
    }
  }

  for (const [key, value] of Object.entries(lim)) {
    const def = BY_KEY.get(key);
    const legacy = LEGACY_PLAN_KEYS.has(key);
    if (!def) {
      if (!legacy) {
        issues.push({ level: 'warning', key, message: `Unknown limit key '${key}' (not in registry)` });
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ level: 'error', key, message: `Limit '${key}' must be a finite number (use -1 for unlimited)` });
      }
      continue;
    }
    if (def.type !== 'limit' && !legacy) {
      issues.push({ level: 'warning', key, message: `Key '${key}' is not a 'limit' in registry (type=${def.type})` });
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ level: 'error', key, message: `Limit '${key}' must be a finite number (use -1 for unlimited)` });
    }
  }

  return { valid: !issues.some((i) => i.level === 'error'), issues };
}

/**
 * Compare a set of plan rows against the registry — surfaces
 * keys present in DB but unknown to registry (drift/legacy)
 * and registry keys missing from every plan (gaps).
 */
export function diagnoseAgainstPlans(plans: Array<{
  id: string; slug: string; entitlements?: Record<string, unknown> | null; limits?: Record<string, unknown> | null;
}>): {
  unknownKeysInDb: Array<{ planSlug: string; key: string; bucket: 'entitlements' | 'limits' }>;
  registryKeysMissingEverywhere: string[];
  invalidLimitValues: Array<{ planSlug: string; key: string; value: unknown }>;
} {
  const unknownKeysInDb: Array<{ planSlug: string; key: string; bucket: 'entitlements' | 'limits' }> = [];
  const invalidLimitValues: Array<{ planSlug: string; key: string; value: unknown }> = [];
  const seenKeys = new Set<string>();

  for (const p of plans) {
    for (const k of Object.keys(p.entitlements || {})) {
      seenKeys.add(k);
      if (!BY_KEY.has(k)) unknownKeysInDb.push({ planSlug: p.slug, key: k, bucket: 'entitlements' });
    }
    for (const [k, v] of Object.entries(p.limits || {})) {
      seenKeys.add(k);
      if (!BY_KEY.has(k)) unknownKeysInDb.push({ planSlug: p.slug, key: k, bucket: 'limits' });
      if (typeof v !== 'number' || !Number.isFinite(v)) invalidLimitValues.push({ planSlug: p.slug, key: k, value: v });
    }
  }

  const registryKeysMissingEverywhere = CAPABILITY_REGISTRY
    .filter((c) => c.planConfigurable && !seenKeys.has(c.key))
    .map((c) => c.key);

  return { unknownKeysInDb, registryKeysMissingEverywhere, invalidLimitValues };
}