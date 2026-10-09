import { z } from 'zod';
import type { Edition } from '../../../shared/edition.js';
import {
  CALL_WIDGET_TEMPLATES,
  EDITION_CALL_WIDGET_TEMPLATES,
  resolveCallWidgetTemplateForEdition,
  type CallWidgetTemplateId,
} from '../../../shared/widgetTemplates.js';

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

/** The asset file names (public/call-widget/) of a template; unknown ids get `default`'s. */
export function callWidgetTemplateAssetKeys(templateId: unknown) {
  const id: CallWidgetTemplateId = Object.prototype.hasOwnProperty.call(CALL_WIDGET_TEMPLATES, String(templateId))
    ? (templateId as CallWidgetTemplateId)
    : CALL_WIDGET_DEFAULT_TEMPLATE_ID;
  const template = CALL_WIDGET_TEMPLATES[id];
  return {
    registry: 'presentation-registry.js',
    script: template.script,
    style: template.style,
  } as const;
}
