import {
  LayoutDashboard, MessageSquareText, Workflow, Sparkles, Activity, Wrench,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import type { AiAccent } from '@/components/ai-agent/AiPageHeader';
import type { AiAgentCapabilities } from '@/lib/ai-agent/assistant';

/**
 * The AI section's menu: a few plain sections, each opening its pages as
 * tabs (AiAgentLayout). Every customer page of the section is in exactly one
 * section (src/test/ai-agent/aiSectionMenu.test.ts), so none is reachable
 * only by typing its URL.
 *
 * Knowledge is not in it (owner, 2026-11-01): sources, files, web pages, Q&A
 * and learning from operators are managed in the workspace's Knowledge Base
 * only, whose tabs the section's old knowledge pages became
 * (src/components/app/knowledge/knowledgeBaseTabs.ts). The section's
 * settings, once four pages, are one: «شخصیت و رفتار» (`behavior`). Their
 * old URLs redirect (App.tsx).
 *
 * `navFlags` are the Super Admin's per-entry switches (capabilities.customer_nav,
 * server/services/ai-agent/platformSettings.ts): a tab shows while any of its
 * switches is on, and a section without a visible tab is hidden. Pages
 * without a switch are always offered, as they always were by URL. The
 * `knowledge` switch is the Knowledge Base's status tab now. The Super
 * Admin's cap on visible entries (max_customer_visible_nav_items) counts
 * sections.
 */
export type CustomerNavKey = keyof AiAgentCapabilities['customer_nav'];

export interface AiMenuTab {
  /** The page's path under /ai-agent/ (also matches its sub-paths). */
  path: string;
  label: TranslationKey;
  /** Shown while any of these switches is on; none: always shown. */
  navFlags?: readonly CustomerNavKey[];
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
  /**
   * The Advanced tools: AdvancedAiAgentGuard's rule (shared/aiAdvancedTools.ts),
   * the Super Admin, or a plan with `ai_advanced_tools` and the workspace's
   * owner or an admin.
   */
  advanced?: boolean;
}

export const AI_MENU: AiMenuSection[] = [
  {
    id: 'overview', label: 'aiAgent.menu.overview', desc: 'aiAgent.menu.overviewDesc', icon: LayoutDashboard, accent: 'indigo',
    tabs: [
      { path: 'overview', label: 'aiAgent.menu.tabOverview', navFlags: ['overview'] },
      { path: 'playground', label: 'aiAgent.menu.tabPlayground' },
    ],
  },
  {
    // One page, so no tab rail. It holds what the Behavior and the Settings
    // pages did, so either switch offers it.
    id: 'behavior', label: 'aiAgent.menu.behavior', desc: 'aiAgent.menu.behaviorDesc', icon: MessageSquareText, accent: 'violet',
    tabs: [
      { path: 'behavior', label: 'aiAgent.menu.behavior', navFlags: ['behavior', 'settings'] },
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
      { path: 'operator-assist', label: 'aiAgent.menu.tabOperatorAssist', navFlags: ['operatorAssist'] },
      { path: 'operator-assist-analytics', label: 'aiAgent.menu.tabAssistAnalytics', navFlags: ['operatorAssist'] },
    ],
  },
  {
    id: 'activity', label: 'aiAgent.menu.activity', desc: 'aiAgent.menu.activityDesc', icon: Activity, accent: 'sky',
    tabs: [
      { path: 'activity', label: 'aiAgent.menu.tabActivity', navFlags: ['activity'] },
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

/** A tab without switches, or with one of them on (an unknown switch counts as on). */
export function aiTabOffered(tab: AiMenuTab, navFlags: Partial<Record<CustomerNavKey, boolean>>): boolean {
  return !tab.navFlags?.length || tab.navFlags.some((flag) => navFlags[flag] !== false);
}

/**
 * The sections a member sees: the Super Admin's flags hide tabs, empty
 * sections drop out, the advanced one needs AdvancedAiAgentGuard's access
 * (useAiAdvancedToolsAccess: the Super Admin, or the plan's
 * `ai_advanced_tools` and an owner or admin), and the cap (customers only)
 * counts the customer sections, never the advanced one.
 */
export function visibleAiMenu(opts: {
  navFlags: Partial<Record<CustomerNavKey, boolean>>;
  advancedAllowed: boolean;
  /** max_customer_visible_nav_items when it applies (not for super admins), else null. */
  cap: number | null;
}): AiMenuSection[] {
  const withTabs = AI_MENU
    .filter((s) => !s.advanced || opts.advancedAllowed)
    .map((s) => ({ ...s, tabs: s.tabs.filter((tab) => aiTabOffered(tab, opts.navFlags)) }))
    .filter((s) => s.tabs.length > 0);
  if (opts.cap === null || opts.cap <= 0) return withTabs;
  return [
    ...withTabs.filter((s) => !s.advanced).slice(0, opts.cap),
    ...withTabs.filter((s) => s.advanced),
  ];
}
