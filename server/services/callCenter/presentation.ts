import { z } from 'zod';

export const CALL_WIDGET_DEFAULT_TEMPLATE_ID = 'default' as const;
export const CALL_WIDGET_TEMPLATE_IDS = [CALL_WIDGET_DEFAULT_TEMPLATE_ID] as const;

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

export function resolveCallWidgetTemplateId(value: unknown): typeof CALL_WIDGET_DEFAULT_TEMPLATE_ID {
  return value === CALL_WIDGET_DEFAULT_TEMPLATE_ID ? value : CALL_WIDGET_DEFAULT_TEMPLATE_ID;
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

export function callWidgetTemplateAssetKeys(templateId: unknown) {
  const id = resolveCallWidgetTemplateId(templateId);
  return {
    registry: 'presentation-registry.js',
    script: `presentation-${id}.js`,
    style: `presentation-${id}.css`,
  } as const;
}
