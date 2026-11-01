import {
  LayoutDashboard, BookOpen, MessageSquareText, Workflow, Sparkles, Activity, Wrench,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import type { AiAccent } from '@/components/ai-agent/AiPageHeader';
import type { AiAgentCapabilities } from '@/lib/ai-agent/assistant';

/**
 * The AI section's menu: a few plain sections, each opening its pages as
 * tabs (AiAgentLayout). Every customer page of the section is in exactly one
 * section (src/test/ai-agent/aiSectionMenu.test.ts), so none is reachable
 * only by typing its URL; the URLs themselves are unchanged.
 *
 * `navFlag` is the Super Admin's per-entry switch (capabilities.customer_nav,
 * server/services/ai-agent/platformSettings.ts): a tab whose flag is false is
 * hidden, and a section without a visible tab is hidden. Pages without a flag
 * are always offered, as they always were by URL. The Super Admin's cap on
 * visible entries (max_customer_visible_nav_items) counts sections.
 */
export type CustomerNavKey = keyof AiAgentCapabilities['customer_nav'];

export interface AiMenuTab {
  /** The page's path under /ai-agent/ (also matches its sub-paths). */
  path: string;
  label: TranslationKey;
  navFlag?: CustomerNavKey;
}

export interface AiMenuSection {
  id: string;
  label: TranslationKey;
  desc: TranslationKey;
  icon: React.ElementType;
  accent: AiAccent;
  tabs: AiMenuTab[];
  /** Other first path segments that belong here (detail pages, no tab). */
  also?: string[];
  /** Platform admins only (AdvancedAiAgentGuard's rule). */
  advanced?: boolean;
}

export const AI_MENU: AiMenuSection[] = [
  {
    id: 'overview', label: 'aiAgent.menu.overview', desc: 'aiAgent.menu.overviewDesc', icon: LayoutDashboard, accent: 'indigo',
    tabs: [
      { path: 'overview', label: 'aiAgent.menu.tabOverview', navFlag: 'overview' },
      { path: 'activation', label: 'aiAgent.menu.tabActivation' },
      { path: 'playground', label: 'aiAgent.menu.tabPlayground' },
    ],
  },
  {
    id: 'knowledge', label: 'aiAgent.menu.knowledge', desc: 'aiAgent.menu.knowledgeDesc', icon: BookOpen, accent: 'cyan',
    tabs: [
      { path: 'knowledge', label: 'aiAgent.menu.tabKnowledge', navFlag: 'knowledge' },
      { path: 'web-pages', label: 'aiAgent.menu.tabWebPages' },
      { path: 'learning-candidates', label: 'aiAgent.menu.tabLearning' },
      { path: 'train', label: 'aiAgent.menu.tabTrain' },
    ],
  },
  {
    id: 'answers', label: 'aiAgent.menu.answers', desc: 'aiAgent.menu.answersDesc', icon: MessageSquareText, accent: 'violet',
    tabs: [
      { path: 'behavior', label: 'aiAgent.menu.tabBehavior', navFlag: 'behavior' },
      { path: 'instructions', label: 'aiAgent.menu.tabInstructions' },
      { path: 'guidance', label: 'aiAgent.menu.tabGuidance' },
      { path: 'settings', label: 'aiAgent.menu.tabSettings', navFlag: 'settings' },
    ],
  },
  {
    id: 'automation', label: 'aiAgent.menu.automation', desc: 'aiAgent.menu.automationDesc', icon: Workflow, accent: 'emerald',
    tabs: [
      { path: 'routing', label: 'aiAgent.menu.tabRouting' },
      { path: 'topics', label: 'aiAgent.menu.tabTopics' },
      { path: 'triggers', label: 'aiAgent.menu.tabTriggers' },
      { path: 'workflow', label: 'aiAgent.menu.tabWorkflow' },
      { path: 'integrations', label: 'aiAgent.menu.tabIntegrations' },
    ],
  },
  {
    id: 'operatorAssist', label: 'aiAgent.menu.operatorAssist', desc: 'aiAgent.menu.operatorAssistDesc', icon: Sparkles, accent: 'amber',
    tabs: [
      { path: 'operator-assist', label: 'aiAgent.menu.tabOperatorAssist', navFlag: 'operatorAssist' },
      { path: 'operator-assist-analytics', label: 'aiAgent.menu.tabAssistAnalytics', navFlag: 'operatorAssist' },
    ],
  },
  {
    id: 'activity', label: 'aiAgent.menu.activity', desc: 'aiAgent.menu.activityDesc', icon: Activity, accent: 'sky',
    tabs: [
      { path: 'activity', label: 'aiAgent.menu.tabActivity', navFlag: 'activity' },
      { path: 'analytics', label: 'aiAgent.menu.tabAnalytics' },
    ],
  },
  {
    id: 'advanced', label: 'aiAgent.menu.advanced', desc: 'aiAgent.menu.advancedDesc', icon: Wrench, accent: 'rose', advanced: true,
    tabs: [
      { path: 'test-cases', label: 'aiAgent.menu.tabTestCases' },
      { path: 'suggested-tests', label: 'aiAgent.menu.tabSuggestedTests' },
      { path: 'regression-runs', label: 'aiAgent.menu.tabRegressionRuns' },
      { path: 'source-health', label: 'aiAgent.menu.tabSourceHealth' },
      { path: 'debug/retrieval', label: 'aiAgent.menu.tabRetrievalDebug' },
    ],
    also: ['runs', 'test-runs', 'debug', 'billing'],
  },
];

/** The part of the pathname after `/ai-agent/` ('' on the index). */
export function aiSubPath(pathname: string): string {
  const i = pathname.indexOf('/ai-agent');
  if (i === -1) return '';
  return pathname.slice(i + '/ai-agent'.length).replace(/^\/+|\/+$/g, '');
}

export function aiTabMatches(sub: string, tabPath: string): boolean {
  return sub === tabPath || sub.startsWith(`${tabPath}/`);
}

export function aiSectionForPath(sub: string, sections: AiMenuSection[] = AI_MENU): AiMenuSection | undefined {
  const first = sub.split('/')[0];
  return sections.find((s) => s.tabs.some((tab) => aiTabMatches(sub, tab.path)) || s.also?.includes(first));
}

/**
 * The sections a member sees: the Super Admin's flags hide tabs, empty
 * sections drop out, the advanced one needs AdvancedAiAgentGuard's access,
 * and the cap (customers only) counts the customer sections.
 */
export function visibleAiMenu(opts: {
  navFlags: Partial<Record<CustomerNavKey, boolean>>;
  advancedAllowed: boolean;
  /** max_customer_visible_nav_items when it applies (not for super admins), else null. */
  cap: number | null;
}): AiMenuSection[] {
  const withTabs = AI_MENU
    .filter((s) => !s.advanced || opts.advancedAllowed)
    .map((s) => ({ ...s, tabs: s.tabs.filter((tab) => !tab.navFlag || opts.navFlags[tab.navFlag] !== false) }))
    .filter((s) => s.tabs.length > 0);
  if (opts.cap === null || opts.cap <= 0) return withTabs;
  return [
    ...withTabs.filter((s) => !s.advanced).slice(0, opts.cap),
    ...withTabs.filter((s) => s.advanced),
  ];
}
