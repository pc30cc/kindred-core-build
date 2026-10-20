import { z } from 'zod';
import type { Edition } from '../../../shared/edition.js';
import {
  CALL_WIDGET_TEMPLATES,
  EDITION_CALL_WIDGET_TEMPLATES,
  resolveCallWidgetTemplateForEdition,
  type CallWidgetTemplateId,
} from '../../../shared/widgetTemplates.js';
import { CALL_LAUNCHER_STYLES, normalizeCallWidgetPosition } from '../../../shared/callLauncherStyles.js';
import {
  DAY_KEYS,
  MAX_INTERVALS_PER_DAY,
  callbackHoursHaveInterval,
  isValidTimeZone,
  type BusinessHours,
} from '../../../shared/callbackSlots.js';

/**
 * Call widget templates per edition live in shared/widgetTemplates.ts: the
 * Iranian edition (and an unknown one) wears `default`, exactly as before;
 * the International edition wears `intl`.
 */
export const CALL_WIDGET_DEFAULT_TEMPLATE_ID = 'default' as const;
export const CALL_WIDGET_TEMPLATE_IDS = Object.keys(CALL_WIDGET_TEMPLATES) as CallWidgetTemplateId[];

/** The template ids a settings save may store: any known one (the edition check follows). */
export const callWidgetTemplateIdSchema = z.enum(['default', 'intl'] as const satisfies readonly CallWidgetTemplateId[]);

/** May this edition wear (and save) this call widget template? */
export function isCallWidgetTemplateOffered(edition: Edition | null, id: unknown): boolean {
  return (EDITION_CALL_WIDGET_TEMPLATES[edition ?? 'iran'].offered as readonly unknown[]).includes(id);
}

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i).transform((value) => value.toLowerCase());

export const callWidgetThemeSchema = z.object({
  primary: hexColor.optional(),
  accent: hexColor.optional(),
  surface: hexColor.optional(),
  text: hexColor.optional(),
  muted: hexColor.optional(),
  danger: hexColor.optional(),
  radius: z.enum(['sm', 'md', 'lg']).optional(),
  density: z.enum(['compact', 'comfortable']).optional(),
}).strict();

const optionSchema = z.object({
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
}).strict();

export const callWidgetFormFieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox']),
  label: z.string().trim().min(1).max(120),
  placeholder: z.string().trim().max(160).optional(),
  required: z.boolean().optional().default(false),
  options: z.array(optionSchema).min(1).max(30).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.type === 'select' && !field.options?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'select_requires_options' });
  }
  if (field.type !== 'select' && field.options) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'options_only_allowed_for_select' });
  }
});

export const callWidgetFormSchema = z.array(callWidgetFormFieldSchema).max(12).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (seen.has(field.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'duplicate_field_id' });
    }
    seen.add(field.id);
  });
});

export const callWidgetOfflineBehaviorSchema = z.enum(['hide', 'show_callback', 'show_message']);

export type CallWidgetTheme = z.infer<typeof callWidgetThemeSchema>;
export type CallWidgetFormField = z.infer<typeof callWidgetFormFieldSchema>;
export type CallWidgetOfflineBehavior = z.infer<typeof callWidgetOfflineBehaviorSchema>;

/**
 * The call widget template to wear: the stored id when the edition offers it,
 * else the edition's default. Without an edition (or with `null`, unknown)
 * this is the Iranian rule: always `default`.
 */
export function resolveCallWidgetTemplateId(value: unknown, edition: Edition | null = null): CallWidgetTemplateId {
  return resolveCallWidgetTemplateForEdition(edition, value);
}

export function normalizeCallWidgetTheme(value: unknown): CallWidgetTheme {
  const parsed = callWidgetThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function normalizeCallWidgetFormSchema(value: unknown): CallWidgetFormField[] {
  const parsed = callWidgetFormSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function normalizeCallWidgetOfflineBehavior(value: unknown): CallWidgetOfflineBehavior {
  if (value === 'callback') return 'show_callback';
  const parsed = callWidgetOfflineBehaviorSchema.safeParse(value);
  return parsed.success ? parsed.data : 'show_callback';
}

function knownCallTemplate(templateId: unknown): CallWidgetTemplateId {
  return Object.prototype.hasOwnProperty.call(CALL_WIDGET_TEMPLATES, String(templateId))
    ? (templateId as CallWidgetTemplateId)
    : CALL_WIDGET_DEFAULT_TEMPLATE_ID;
}

/** The asset file names (public/call-widget/) of a template; unknown ids get `default`'s. */
export function callWidgetTemplateAssetKeys(templateId: unknown) {
  const template = CALL_WIDGET_TEMPLATES[knownCallTemplate(templateId)];
  return {
    registry: 'presentation-registry.js',
    script: template.script,
    style: template.style,
  } as const;
}

/**
 * The panel module and its stylesheet of a template (public/call-widget/),
 * loaded on the visitor's first intent; unknown ids get `default`'s.
 */
export function callWidgetPanelAssetKeys(templateId: unknown) {
  const { panel } = CALL_WIDGET_TEMPLATES[knownCallTemplate(templateId)];
  return { panelScript: panel.script, panelStyle: panel.style } as const;
}

// ─── Launcher and placement (migration 277) ─────────────────────────────────

/** A launcher style a save may store (shared/callLauncherStyles.ts). */
export const callWidgetLauncherStyleSchema = z.enum(CALL_LAUNCHER_STYLES);

/**
 * A placement as a save sends it: a placement or one of its older spellings
 * becomes the placement; any other string becomes `right`, which is where it
 * always rendered (an old dashboard resending what it loaded never fails).
 */
export const callWidgetPositionSchema = z.string().max(64).transform((raw) => normalizeCallWidgetPosition(raw));

// ─── Callback hours (business_hours, migration 277's slots) ─────────────────

const hhmmStrict = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const callbackIntervalSchema = z.object({ from: hhmmStrict, to: hhmmStrict }).strict();
const callbackDaySchema = z.array(callbackIntervalSchema).max(MAX_INTERVALS_PER_DAY);
const callbackWeeklySchema = z.object(
  Object.fromEntries(DAY_KEYS.map((day) => [day, callbackDaySchema.optional()])) as Record<(typeof DAY_KEYS)[number], z.ZodOptional<typeof callbackDaySchema>>,
).strict();
const callbackOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/),
  closed: z.boolean().optional(),
  intervals: callbackDaySchema.optional(),
  label: z.string().max(120).optional(),
}).strict();

/**
 * call_center_settings.business_hours as a save may store it: `{}` (no hours)
 * or the chat's BusinessHoursConfig, strictly (HH:mm times, at most 6
 * intervals a day, a time zone this server knows, at most 60 overrides).
 */
export const callbackHoursSchema = z.union([
  z.object({}).strict(),
  z.object({
    enabled: z.boolean().optional(),
    timezone: z.string().max(64).refine((tz) => isValidTimeZone(tz), { message: 'invalid_timezone' }).optional(),
    weekly: callbackWeeklySchema,
    overrides: z.array(callbackOverrideSchema).max(60).optional(),
  }).strict(),
]);

/** Stored hours that pass the strict shape, else null (a legacy value a save never rewrote). */
export function parseCallbackHours(value: unknown): BusinessHours | null {
  const parsed = callbackHoursSchema.safeParse(value);
  return parsed.success ? (parsed.data as BusinessHours) : null;
}

/**
 * The hours callback slots come from: only while the workspace turned slots
 * on AND its stored hours pass the strict shape AND name an interval; null
 * otherwise (the widget then offers its date-and-time field).
 */
export function callbackSlotHours(slotsEnabled: boolean, businessHours: unknown): BusinessHours | null {
  if (!slotsEnabled) return null;
  const hours = parseCallbackHours(businessHours);
  return hours && callbackHoursHaveInterval(hours) ? hours : null;
}
