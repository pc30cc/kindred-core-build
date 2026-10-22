/**
 * The states the live preview (WidgetLivePreview.tsx) draws, as the server
 * resolves them for a visitor: the pre-chat form asked, the offline
 * behaviour, the owner's offline message in the widget's language.
 */
import type { WidgetPrechatSettings } from '@/hooks/useWidgetIdentity';
import { effectivePrechat } from '../../../../shared/prechatPolicy';

type PrechatRow = Partial<Pick<WidgetPrechatSettings, 'ask_name' | 'ask_email' | 'ask_phone' | 'require_name' | 'require_email' | 'require_phone'>>;

/**
 * The pre-chat form a visitor is asked, by the server's rule
 * (shared/prechatPolicy.ts effectivePrechat, as /identity/me serves it): the
 * Super Admin's policy (`{ name, email, phone }` of prechat_<field>_policy)
 * forces a field on or off, a plan without `widget_prechat_form` drops the
 * workspace's row (only forced fields are asked), without a row the
 * policy's defaults (name and email, both required), and a field is
 * required only while it is asked.
 */
export function previewPrechatForm(
  row: PrechatRow | null | undefined,
  policy?: unknown,
  opts: { planAllowsForm?: boolean } = {},
): {
  asked: Record<'name' | 'email' | 'phone', boolean>;
  required: Record<'name' | 'email' | 'phone', boolean>;
} {
  const form = effectivePrechat(row, policy, opts);
  return {
    asked: { name: form.ask_name, email: form.ask_email, phone: form.ask_phone },
    required: { name: form.require_name, email: form.require_email, phone: form.require_phone },
  };
}

/** The widget's offline behaviour as the server resolves it (availability.ts normalizeOfflineMode). */
export function previewOfflineMode(value: unknown): 'capture_message' | 'show_offline_message' | 'hide_widget' {
  return value === 'show_offline_message' || value === 'hide_widget' ? value : 'capture_message';
}

/** The owner's offline message in the widget's language, as the server picks it (availability.ts pickLocalized). */
export function previewOfflineMessage(s: Record<string, unknown>, locale: string): string {
  const localized = s.offline_message_localized as Record<string, unknown> | null | undefined;
  const direct = localized && typeof localized === 'object' ? localized[locale] : null;
  const text = typeof direct === 'string' && direct ? direct : typeof s.offline_message === 'string' ? s.offline_message : '';
  return text.trim();
}
