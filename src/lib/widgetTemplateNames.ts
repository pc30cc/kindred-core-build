/**
 * What the dashboard calls a chat widget template: the Super Admin's name in
 * the dashboard's language (shared/chatTemplateCatalog.ts), else the i18n
 * default (`widgetCatalog.names.<id>`), else the id itself. Never a name from
 * another language before the dashboard's own default, and never shown to a
 * visitor.
 */
import type { TranslationKey } from '@/i18n';
import { CHAT_WIDGET_TEMPLATES, type ChatWidgetTemplateId } from '../../shared/widgetTemplates';
import { chatTemplateOptionKeys } from '../../shared/chatTemplateCatalog';

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

/**
 * What a visitor gets from a template, among what not every template has
 * always had: the dashboard lists it on each template, so an owner choosing
 * one knows (the renderers' `features`, shared/widgetTemplates.ts).
 */
export type TemplateVisitorFeature = 'typing' | 'queuePlace' | 'closedLine' | 'rating' | 'reactions';

export function templateVisitorFeatures(id: string): TemplateVisitorFeature[] {
  if (!isKnownTemplate(id)) return [];
  const d = CHAT_WIDGET_TEMPLATES[id as ChatWidgetTemplateId];
  // Every template shows an operator typing (default's row since 2026-10).
  const out: TemplateVisitorFeature[] = ['typing'];
  // The place in the queue is Template 1's (runtime-late.js `queuePosition`, its extras).
  if (d.script === 'presentation-t1.js') out.push('queuePlace');
  if (d.closedNotice) out.push('closedLine');
  // The rating card under it where the template reads the `csat` option: every template since the inactivity close.
  if (d.closedNotice && chatTemplateOptionKeys(id).includes('csat')) out.push('rating');
  if (d.reactions) out.push('reactions');
  return out;
}

/** The template's features as one line in the dashboard's language. */
export function templateFeatureLine(t: Translate, id: string): string {
  const list = templateVisitorFeatures(id).map((f) => t(`widgetCatalog.features.${f}` as TranslationKey));
  return list.length ? `${t('widgetCatalog.features.title' as TranslationKey)}: ${list.join(' · ')}` : '';
}
