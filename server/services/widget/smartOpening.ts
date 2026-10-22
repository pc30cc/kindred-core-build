/**
 * A Smart Engagement rule shown as a "Message inside the chat" is the first
 * line of the conversation the visitor's answer opens.
 *
 * The loader draws that message in the widget as an operator's line, but it
 * was never stored: the operator (and the AI) saw a conversation that began
 * with the visitor's "yes" and no question, a reload took the line away from
 * the visitor's own thread, and the rule's "conversations" stat stayed 0.
 *
 * The widget now names the rule it showed (`smart_rule` on the first
 * POST /message: id, version, the locale it was shown in). The text stored is
 * the server's own copy of the PUBLISHED rule (the workspace snapshot the
 * widget's /config was built from), never text from the browser; the locale
 * only picks among the rule's own translations. Only a rule whose
 * presentation is `chat_message` qualifies.
 */
import { renderSmartTemplate, resolveSmartContent, type SmartRule } from '../../../src/lib/widget/smartEngine.js';
import type { WorkspaceWidgetSnapshot } from './configSnapshot.js';

export interface SmartOpening {
  ruleId: string;
  version: number;
  text: string;
}

/** The longest text a conversation message holds (POST /message). */
const MAX_TEXT = 5000;

export function smartRuleOpening(
  snap: Pick<WorkspaceWidgetSnapshot, 'smart'>,
  ruleId: string,
  locale: string | null | undefined,
  /** The same variables the loader fills in (loader.js fire()). */
  vars: { workspaceName: string; pageTitle?: string | null; pagePath?: string | null },
): SmartOpening | null {
  const rule = (snap.smart?.rules || []).find((r) => r.id === ruleId);
  if (!rule || rule.presentation_config?.mode !== 'chat_message') return null;
  const content = resolveSmartContent(rule as unknown as SmartRule, String(locale || ''));
  if (!content) return null;
  const values = {
    'workspace.name': vars.workspaceName,
    'page.title': vars.pageTitle || '',
    'page.path': vars.pagePath || '',
  };
  const title = renderSmartTemplate(content.title || '', values).trim();
  const body = renderSmartTemplate(content.body || '', values).trim();
  if (!body) return null;
  return {
    ruleId: rule.id,
    version: Number(rule.version) || 1,
    text: (title ? `${title}\n${body}` : body).slice(0, MAX_TEXT),
  };
}
