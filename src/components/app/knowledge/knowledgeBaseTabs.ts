import type { AiAgentCapabilities } from '@/lib/ai-agent-api';

/**
 * The Knowledge Base's tabs (src/pages/app/KnowledgeBasePage.tsx), by their
 * `?tab=` value; Articles is the page without one.
 *
 * The Knowledge Base is the one place knowledge is managed (owner,
 * 2026-11-01). Its own content (articles, Q&A, files) is open to every member
 * on every plan. Besides it, what the AI assistant learns from: the pages of
 * the workspace's site it crawls, what it learns from operators' answers, and
 * the state of all of it. Those three were the AI section's knowledge pages;
 * they are tabs here now, and the section's old URLs redirect to them
 * (App.tsx).
 */
export const KB_CONTENT_TABS = ['articles', 'qna', 'files'] as const;
export const KB_AI_TABS = ['web', 'learning', 'status'] as const;

export type KbContentTab = (typeof KB_CONTENT_TABS)[number];
export type KbAiTab = (typeof KB_AI_TABS)[number];
export type KbTab = KbContentTab | KbAiTab;

export function isKbAiTab(value: string | null | undefined): value is KbAiTab {
  return (KB_AI_TABS as readonly string[]).includes(value ?? '');
}

/** A `?tab=` value as a tab; null when there is none or it names no tab. */
export function kbTabFromParam(value: string | null | undefined): KbTab | null {
  if (isKbAiTab(value)) return value;
  return (KB_CONTENT_TABS as readonly string[]).includes(value ?? '') ? (value as KbContentTab) : null;
}

/** A tab's address in the workspace, for wsPath(): `wsPath(kbTabPath('learning'))`. */
export function kbTabPath(tab: KbTab): string {
  return tab === 'articles' ? '/knowledge-base' : `/knowledge-base?tab=${tab}`;
}

/**
 * Which of the assistant's tabs a member sees. They manage the assistant, so
 * they follow the AI section's own rule, the one the main menu offers the AI
 * entry by (`aiSection`: sectionVisible('aiAgent'), src/lib/planAccess.ts: a
 * workspace owner or admin, the plan's `ai_assistant` module, the platform's
 * AI switched on and shown to customers). The status tab is also the Super
 * Admin's `customer_nav.knowledge` entry, which used to hide the AI section's
 * Knowledge page.
 */
export function kbAiTabsVisible(
  aiSection: boolean,
  customerNav: Partial<AiAgentCapabilities['customer_nav']> | null | undefined,
): Record<KbAiTab, boolean> {
  return {
    web: aiSection,
    learning: aiSection,
    status: aiSection && customerNav?.knowledge !== false,
  };
}
