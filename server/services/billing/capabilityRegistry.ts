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
  /** Legacy key kept only for backward compatibility — never offered in UI. */
  deprecated?: boolean;
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
  // Not yet enforced by a requireModule('seo') check in server/routes/seo.ts —
  // defaultValue: true means registering it here changes no workspace's
  // existing access; it only makes the module visible/toggleable in the
  // admin Plans editor. Wiring real enforcement is a separate follow-up.
  { key: 'seo', type: 'module', label: 'SEO / Website Audit', group: 'modules', description: 'Crawl and analyze the technical SEO health of a website registered in the workspace (Settings → Domains).', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 130 },

  // ─── Channels ───
  { key: 'chat_widget', type: 'channel', label: 'Chat Widget', group: 'channels', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
  { key: 'email',       type: 'channel', label: 'Email',       group: 'channels', defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 20 },
  { key: 'whatsapp',    type: 'channel', label: 'WhatsApp',    group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 30 },
  { key: 'sms',         type: 'channel', label: 'SMS',         group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 40 },
  { key: 'instagram',   type: 'channel', label: 'Instagram',   group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 50 },
  { key: 'telegram',    type: 'channel', label: 'Telegram',    group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 60 },
  { key: 'bale',        type: 'channel', label: 'Bale',        group: 'channels', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 65 },
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
  // DEPRECATED legacy inverse of `widget_powered_by`. Kept in the registry so
  // historical plan JSON stays known (no "unknown key" warnings) but never
  // shown as a second toggle in the admin plan editor or customer billing UI,
  // and never overridable per workspace.
  { key: 'remove_powered_by',     type: 'feature', label: 'Remove "Powered by" (legacy)', description: 'Deprecated — superseded by `widget_powered_by`. Read only as a fallback for plans that were never migrated.', group: 'branding', defaultValue: false, planConfigurable: false, workspaceOverridable: false, userVisible: false, internalOnly: true, deprecated: true, sortOrder: 20 },
  { key: 'widget_powered_by',     type: 'feature', label: 'Show Widget "Powered by" Footer', group: 'branding', description: 'Whether the chat widget shows the platform credit footer. Wording, brand label and link are platform-admin owned (Admin → Widget Settings → Powered by). Turn OFF for a plan to hide the footer entirely — the widget content then extends to the bottom edge.', defaultValue: true, planConfigurable: true, workspaceOverridable: false, userVisible: true, sortOrder: 25 },
  { key: 'widget_powered_by_toggle', type: 'feature', label: 'Workspace May Hide "Powered by"', group: 'branding', description: 'Lets the workspace owner switch the powered-by footer off in Widget → Appearance → Logo & branding. The workspace switch defaults to ON, so the credit keeps showing until the owner turns it off. Requires the footer to be allowed by "Show Widget \'Powered by\' Footer".', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 26 },

  // ─── Chat widget surface features (bounded by the `chat_widget` channel) ───
  // Live chat / Knowledge base / Visitor tracking intentionally REUSE the
  // `chat`, `knowledge_base` and `visitor_tracking` modules — no duplicates.
  { key: 'widget_attachments',       type: 'feature', label: 'Widget File Attachments', group: 'widget', description: 'Visitors may attach files in the chat widget composer.',                                   defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
  { key: 'widget_voice_notes',       type: 'feature', label: 'Widget Voice Notes',      group: 'widget', description: 'Visitors may record and send voice notes from the chat widget.',                            defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 20 },
  { key: 'widget_emoji',             type: 'feature', label: 'Widget Emoji Picker',     group: 'widget', description: 'Emoji picker in the chat widget composer.',                                                  defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 30 },
  { key: 'widget_smart_engagement',  type: 'feature', label: 'Widget Smart Engagement', group: 'widget', description: 'Behaviour-triggered nudges, announcements and proactive messages (Widget → Smart Engagement).', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 40 },
  { key: 'ai_proactive_nudge',       type: 'feature', label: 'AI Proactive Nudge',       group: 'widget', description: 'AI-generated contextual launcher nudges based on visitor journey (Widget → Smart Engagement → AI Proactive Assistant). Requires Widget Smart Engagement and the AI Assistant.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 45 },
  { key: 'widget_business_hours',    type: 'feature', label: 'Widget Business Hours',   group: 'widget', description: 'Per-workspace answering hours / offline behaviour for the chat widget.',                    defaultValue: true,  planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 50 },
  { key: 'widget_domain_allowlist',  type: 'feature', label: 'Widget Domain Allowlist', group: 'widget', description: 'Restrict where the widget may be embedded via an allowed-domains list. Bounded by max_widget_domains.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 60 },
  { key: 'max_widget_domains',       type: 'limit',   label: 'Max Widget Domains',      group: 'widget', description: 'Maximum number of allowed embed domains per workspace. Enforced when saving the allowlist. -1 = unlimited.', defaultValue: 1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 70 },
  { key: 'widget_assignment_routing', type: 'feature', label: 'Automatic Chat Assignment', group: 'widget', description: 'Automatic / round-robin routing of handed-off conversations to operators. When OFF the workspace is limited to manual assignment.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 80 },
  { key: 'widget_raw_ip_storage',     type: 'feature', label: 'Store Raw Visitor IP',     group: 'widget', description: 'Allow the workspace to store the full (unmasked) visitor IP address. Privacy-sensitive — off by default.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 90 },

  // ─── Appearance customisation (Widget → Appearance tab fields) ───
  // Each key controls whether the workspace may author that field at all. When
  // a plan denies it, the field is locked in the panel AND reset to the
  // platform/locale default in the widget bootstrap payload.
  { key: 'widget_reply_time_text',    type: 'feature', label: 'Custom Reply-Time Note',        group: 'widget', description: 'Workspace may author the "typically replies in…" line under the widget brand name.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 100 },
  { key: 'widget_welcome_message',    type: 'feature', label: 'Custom Welcome Message',        group: 'widget', description: 'Workspace may author the widget welcome message. Otherwise the locale default is used.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 110 },
  { key: 'widget_launcher_label',     type: 'feature', label: 'Custom Launcher Bubble Text',   group: 'widget', description: 'Workspace may author the text bubble shown beside the floating launcher button.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 120 },
  { key: 'widget_launcher_size',      type: 'feature', label: 'Custom Launcher Size',          group: 'widget', description: 'Workspace may resize the floating launcher button. Otherwise the default 56px size is used.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 130 },
  { key: 'widget_launcher_icon',      type: 'feature', label: 'Custom Launcher Icon',          group: 'widget', description: 'Workspace may pick the floating launcher icon. Otherwise the default chat icon is used.', defaultValue: false, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 140 },
  { key: 'widget_composer_placeholder', type: 'feature', label: 'Custom Composer Placeholder', group: 'widget', description: 'Workspace may author the "write your message" placeholder in the widget composer.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 150 },
  { key: 'widget_team_avatars',       type: 'feature', label: 'Online Operator Avatars',       group: 'widget', description: 'Show the avatars of online operators inside the widget "start chat" button.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 160 },
  { key: 'widget_workspace_logo',     type: 'feature', label: 'Workspace Logo in Widget',      group: 'widget', description: 'Show the workspace logo in the widget header. When denied the widget falls back to the brand name only.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 170 },
  // Tab-level surfaces of Widget → configuration. When a plan denies one of
  // these the whole tab disappears from the operator UI and the matching
  // workspace customisation is ignored by the runtime.
  { key: 'widget_appearance',         type: 'feature', label: 'Widget Appearance Editor',      group: 'widget', description: 'Workspace may customise the widget look & feel (Widget → Appearance). When denied the platform defaults are used.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 180 },
  { key: 'widget_behavior',           type: 'feature', label: 'Widget Behaviour Settings',     group: 'widget', description: 'Workspace may configure widget behaviour (Widget → Behaviour).', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 190 },
  { key: 'widget_prechat_form',       type: 'feature', label: 'Widget Pre-chat Form',          group: 'widget', description: 'Collect visitor details before the chat starts (Widget → Pre-chat form).', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 200 },

  // ─── Inbox surface tabs (operator Inbox tab strip) ───
  // When a plan denies one of these the tab is removed from the operator Inbox.
  { key: 'inbox_ai_queue',      type: 'feature', label: 'Inbox AI Queue Tab',      group: 'inbox', description: 'Automated / AI-managed conversations tab in the operator Inbox.', defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 10 },
  { key: 'inbox_needs_human',   type: 'feature', label: 'Inbox "Needs Human" Tab', group: 'inbox', description: 'Conversations handed off from AI that need an operator.',            defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 20 },
  { key: 'inbox_team_chat',     type: 'feature', label: 'Inbox Colleagues Chat',   group: 'inbox', description: 'Internal operator-to-operator chat tab inside the Inbox.',            defaultValue: true, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 30 },


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
  { key: 'max_kb_articles',       type: 'limit', label: 'Knowledge Base Articles',    group: 'usage', description: 'Maximum number of Knowledge Base articles (rows in public.knowledge_base_articles) per workspace at any one time. Occupancy semantics: deleting an article frees capacity. Enforced at create-time by POST /api/knowledge-base/articles via a live count(*). Legacy fallbacks (read only when this key is absent): ai_kb_max_articles, kb_articles. -1 = unlimited.', defaultValue: -1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 50 },
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
  { key: 'included_ai_allowance_irr', type: 'limit', label: 'AI Allowance / Month', group: 'ai', description: 'Monetary AI allowance (IRR) granted to the workspace at the start of every billing cycle by the AI Usage Billing domain. Granted exactly once per (workspace, cycle) as a PLAN_ALLOWANCE balance lot that expires at cycle end; unused allowance never rolls over and never becomes purchased credit. Consumption is the customer charge computed from actual provider usage (see docs/AI_BILLING_ARCHITECTURE.md). Enforcement only applies in ENFORCED billing mode; in METER_ONLY usage is measured but never denied. 0 = no allowance.', defaultValue: 0, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 160 },

  // ─── SEO / Website Audit (server/services/seo/limits.ts is the actual
  // enforcement point — resolveSeoLimits() already reads these exact key
  // names from billing_plans.limits via getWorkspacePlanInfo; registering
  // them here only makes them visible/editable in the admin Plans editor,
  // it does not change any runtime behavior). Only the values worth
  // differentiating per plan are exposed; per-fetch tuning knobs
  // (seo_request_timeout_ms, byte caps, crawl delay/concurrency) stay as
  // fixed fallbacks in limits.ts. ───
  { key: 'seo_max_pages_per_crawl',     type: 'limit', label: 'SEO — Max pages per audit',        group: 'seo', description: 'Maximum number of pages the SEO crawler will visit in a single audit run.', defaultValue: 100, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 10 },
  { key: 'seo_max_depth',               type: 'limit', label: 'SEO — Max crawl depth',            group: 'seo', description: 'Maximum link depth (clicks from the homepage) the SEO crawler will follow in a single audit run.', defaultValue: 3, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 20 },
  { key: 'seo_workspace_concurrent_jobs', type: 'limit', label: 'SEO — Concurrent audits',        group: 'seo', description: 'Maximum number of SEO audits that may be queued or running at once for the whole workspace, across all its registered websites.', defaultValue: 1, planConfigurable: true, workspaceOverridable: true, userVisible: true, unit: 'count', sortOrder: 30 },
  { key: 'seo_crawl_frequency_hours',   type: 'limit', label: 'SEO — Re-audit cooldown (hours)',  group: 'seo', description: 'Minimum number of hours that must pass since a website\'s last audit before another one may be started for it.', defaultValue: 24, planConfigurable: true, workspaceOverridable: true, userVisible: true, sortOrder: 40 },
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
  'max_kb_articles',
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