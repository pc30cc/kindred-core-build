/**
 * What the dashboard calls a chat widget template: the Super Admin's name in
 * the dashboard's language (shared/chatTemplateCatalog.ts), else the i18n
 * default (`widgetCatalog.names.<id>`), else the id itself. Never a name from
 * another language before the dashboard's own default, and never shown to a
 * visitor.
 */
import type { TranslationKey } from '@/i18n';
import { CHAT_WIDGET_TEMPLATES } from '../../shared/widgetTemplates';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function isKnownTemplate(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHAT_WIDGET_TEMPLATES, id);
}

export function templateDisplayName(t: Translate, id: string, stored?: string | null): string {
  const own = typeof stored === 'string' ? stored.trim() : '';
  if (own) return own;
  return isKnownTemplate(id) ? t(`widgetCatalog.names.${id}` as TranslationKey) : id;
}

/** One line about how a template looks (empty for an id the dashboard does not know). */
export function templateDescription(t: Translate, id: string): string {
  return isKnownTemplate(id) ? t(`widgetCatalog.descriptions.${id}` as TranslationKey) : '';
}
