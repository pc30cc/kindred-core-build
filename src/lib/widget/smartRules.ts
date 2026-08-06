/**
 * Smart Engagement — validation schemas, defaults and public sanitization.
 * Zod is the source of truth for every persisted config blob; the same
 * schemas are reused by the server before a rule can be published.
 */
import { z } from 'zod';
import {
  SMART_ENGINE_SCHEMA_VERSION,
  isSafeSmartUrl,
  type SmartRule,
} from './smartEngine';

export const SMART_LIMITS = {
  maxActiveRules: 20,
  maxConditionsPerGroup: 8,
  maxGroups: 2,
  maxBodyLength: 400,
  maxTitleLength: 80,
  maxCtaLength: 40,
  maxNameLength: 80,
} as const;

export const SMART_STATUSES = ['draft', 'active', 'paused'] as const;
export const SMART_PRESENTATIONS = [
  'launcher_nudge', 'open_widget', 'home_card', 'chat_message', 'announcement',
] as const;
export const SMART_ACTIONS = [
  'none', 'open_chat', 'open_home', 'open_kb', 'open_article', 'open_url',
] as const;
export const SMART_TRIGGERS = [
  'page_load', 'time_on_page', 'scroll_depth', 'inactivity', 'exit_intent',
] as const;
export const SMART_CONDITION_FIELDS = [
  'page_url', 'page_path', 'page_hostname', 'referrer',
  'utm_source', 'utm_medium', 'utm_campaign',
  'device', 'browser', 'os', 'locale', 'visitor_type',
  'session_page_count', 'availability',
] as const;
export const SMART_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'gt', 'lt',
] as const;
export const SMART_FREQUENCY_MODES = [
  'always', 'once_per_session', 'once_per_visitor', 'max_per_day', 'max_per_week', 'cooldown_hours',
] as const;

/** Personalization variables that are actually resolvable at runtime. */
export const SMART_VARIABLES = [
  'visitor.name', 'visitor.first_name', 'workspace.name', 'page.title', 'page.path',
] as const;

const conditionSchema = z.object({
  field: z.enum(SMART_CONDITION_FIELDS),
  operator: z.enum(SMART_OPERATORS),
  value: z.string().max(300),
});

const leafGroupSchema = z.object({
  match: z.enum(['all', 'any']),
  conditions: z.array(conditionSchema).max(SMART_LIMITS.maxConditionsPerGroup),
});

export const audienceSchema = z.object({
  match: z.enum(['all', 'any']),
  conditions: z.array(conditionSchema).max(SMART_LIMITS.maxConditionsPerGroup),
  groups: z.array(leafGroupSchema).max(SMART_LIMITS.maxGroups).optional(),
});

export const triggerSchema = z.object({
  type: z.enum(SMART_TRIGGERS),
  seconds: z.number().int().min(1).max(3600).optional(),
  percent: z.number().int().min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if ((value.type === 'time_on_page' || value.type === 'inactivity') && !value.seconds) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seconds'], message: 'required' });
  }
  if (value.type === 'scroll_depth' && !value.percent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percent'], message: 'required' });
  }
});

export const localeContentSchema = z.object({
  title: z.string().max(SMART_LIMITS.maxTitleLength).optional().default(''),
  body: z.string().min(1).max(SMART_LIMITS.maxBodyLength),
  cta_label: z.string().max(SMART_LIMITS.maxCtaLength).optional().default(''),
});

export const contentSchema = z.object({
  default_locale: z.string().min(2).max(8),
  locales: z.record(z.string().min(2).max(8), localeContentSchema),
}).refine((v) => Object.keys(v.locales).length > 0, { message: 'at_least_one_locale' });

export const presentationSchema = z.object({
  mode: z.enum(SMART_PRESENTATIONS),
  action: z.enum(SMART_ACTIONS),
  article_slug: z.string().max(200).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  open_in_new_tab: z.boolean().optional().default(true),
  dismissible: z.boolean().optional().default(true),
}).superRefine((value, ctx) => {
  if (value.action === 'open_url' && !isSafeSmartUrl(value.url)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'unsafe_url' });
  }
  if (value.action === 'open_article' && !value.article_slug) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['article_slug'], message: 'required' });
  }
});

export const scheduleSchema = z.object({
  start_at: z.string().datetime().nullable().optional(),
  end_at: z.string().datetime().nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().default([]),
  time_from: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  time_to: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.start_at && value.end_at && Date.parse(value.start_at) >= Date.parse(value.end_at)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end_at'], message: 'end_before_start' });
  }
});

export const frequencySchema = z.object({
  mode: z.enum(SMART_FREQUENCY_MODES),
  count: z.number().int().min(1).max(50).optional(),
  hours: z.number().int().min(1).max(720).optional(),
});

export const behaviorSchema = z.object({
  stop_after_dismiss: z.boolean().optional().default(true),
  stop_after_cta: z.boolean().optional().default(true),
  stop_after_widget_open: z.boolean().optional().default(true),
  stop_after_conversation: z.boolean().optional().default(true),
  stop_after_visitor_reply: z.boolean().optional().default(true),
  offline_mode: z.enum(['show', 'hide']).optional().default('show'),
  mobile_enabled: z.boolean().optional().default(true),
});

export const smartRuleSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string().trim().min(1).max(SMART_LIMITS.maxNameLength),
  description: z.string().max(400).nullable().optional(),
  status: z.enum(SMART_STATUSES),
  priority: z.number().int().min(0).max(1000),
  schema_version: z.number().int().min(1),
  published_version: z.number().int().min(0).optional(),
  trigger_config: triggerSchema,
  audience_config: audienceSchema,
  content_config: contentSchema,
  presentation_config: presentationSchema,
  schedule_config: scheduleSchema,
  frequency_config: frequencySchema,
  behavior_config: behaviorSchema,
});

export type SmartRuleRow = z.infer<typeof smartRuleSchema> & {
  created_at?: string;
  updated_at?: string;
  published_at?: string | null;
  /**
   * Published snapshot columns. Editing a live rule only mutates the draft
   * columns above; the visitor payload is always built from these.
   */
  published_trigger_config?: SmartRule['trigger_config'] | null;
  published_audience_config?: SmartRule['audience_config'] | null;
  published_content_config?: SmartRule['content_config'] | null;
  published_presentation_config?: SmartRule['presentation_config'] | null;
  published_schedule_config?: SmartRule['schedule_config'] | null;
  published_frequency_config?: SmartRule['frequency_config'] | null;
  published_behavior_config?: SmartRule['behavior_config'] | null;
  published_priority?: number | null;
  published_schema_version?: number | null;
};

/** Config blobs that are snapshotted on publish. */
export const SMART_SNAPSHOT_CONFIG_KEYS = [
  'trigger_config', 'audience_config', 'content_config',
  'presentation_config', 'schedule_config', 'frequency_config', 'behavior_config',
] as const;

/** Draft shape used by the editor before it is persisted. */
export type SmartRuleDraft = Omit<SmartRuleRow, 'id' | 'workspace_id'> & {
  id?: string;
  workspace_id?: string;
};

/**
 * Adapt an editor draft to the evaluator's `SmartRule` contract without
 * casting through `any`. Used by the preview studio so the operator sees the
 * verdict of the exact same evaluator the visitor's browser runs.
 */
export function draftToSmartRule(draft: SmartRuleDraft): SmartRule {
  const rule: SmartRule = {
    id: draft.id || 'preview-rule',
    name: draft.name || '',
    status: draft.status,
    priority: Number(draft.priority) || 0,
    schema_version: Number(draft.schema_version) || SMART_ENGINE_SCHEMA_VERSION,
    version: Number(draft.published_version) || 0,
    trigger_config: { type: 'page_load', ...(draft.trigger_config || {}) } as SmartRule['trigger_config'],
    audience_config: { match: 'all', conditions: [], ...(draft.audience_config || {}) } as SmartRule['audience_config'],
    content_config: {
      default_locale: 'en', locales: {}, ...(draft.content_config || {}),
    } as SmartRule['content_config'],
    presentation_config: {
      mode: 'launcher_nudge', action: 'none', ...(draft.presentation_config || {}),
    } as SmartRule['presentation_config'],
    schedule_config: (draft.schedule_config || {}) as SmartRule['schedule_config'],
    frequency_config: {
      mode: 'once_per_session', ...(draft.frequency_config || {}),
    } as SmartRule['frequency_config'],
    behavior_config: (draft.behavior_config || {}) as SmartRule['behavior_config'],
  };
  return rule;
}

export function createEmptySmartRule(locale: string, timezone: string | null): SmartRuleDraft {
  const lang = (locale || 'en').toLowerCase().split('-')[0];
  return {
    name: '',
    description: '',
    status: 'draft',
    priority: 100,
    schema_version: SMART_ENGINE_SCHEMA_VERSION,
    published_version: 0,
    trigger_config: { type: 'time_on_page', seconds: 20 },
    audience_config: { match: 'all', conditions: [], groups: [] },
    content_config: { default_locale: lang, locales: { [lang]: { title: '', body: '', cta_label: '' } } },
    presentation_config: {
      mode: 'launcher_nudge', action: 'open_chat',
      article_slug: null, url: null, open_in_new_tab: true, dismissible: true,
    },
    schedule_config: { start_at: null, end_at: null, weekdays: [], time_from: null, time_to: null, timezone },
    frequency_config: { mode: 'once_per_session' },
    behavior_config: {
      stop_after_dismiss: true, stop_after_cta: true, stop_after_widget_open: true,
      stop_after_conversation: true, stop_after_visitor_reply: true,
      offline_mode: 'show', mobile_enabled: true,
    },
  };
}

/** Strip every risky construct out of operator-authored message text. */
export function sanitizeSmartText(input: string): string {
  return String(input || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\son[a-z]+\s*=/gi, ' ')
    .replace(/javascript:/gi, '')
    .replace(/\u0000/g, '')
    .slice(0, SMART_LIMITS.maxBodyLength);
}

export interface SmartRuleValidationIssue { path: string; message: string }

export function validateSmartRuleForPublish(rule: unknown): SmartRuleValidationIssue[] {
  const parsed = smartRuleSchema.safeParse(rule);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Public payload sent to visitors' browsers. Drops every management field
 * (description, authorship, timestamps, metrics) and keeps only what the
 * evaluator needs.
 */
export function toPublicSmartRule(row: Record<string, any>): SmartRule {
  const content = row.content_config || { default_locale: 'en', locales: {} };
  const locales: Record<string, { title?: string; body: string; cta_label?: string }> = {};
  for (const key of Object.keys(content.locales || {})) {
    const entry = content.locales[key] || {};
    locales[key] = {
      title: sanitizeSmartText(entry.title || '').slice(0, SMART_LIMITS.maxTitleLength),
      body: sanitizeSmartText(entry.body || ''),
      cta_label: sanitizeSmartText(entry.cta_label || '').slice(0, SMART_LIMITS.maxCtaLength),
    };
  }
  const presentation = row.presentation_config || {};
  return {
    id: String(row.id),
    name: '',
    status: row.status,
    priority: Number(row.priority) || 0,
    schema_version: Number(row.schema_version) || SMART_ENGINE_SCHEMA_VERSION,
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