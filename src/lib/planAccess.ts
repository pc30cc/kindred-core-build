/**
 * The one set of rules every web surface applies to a workspace's plan.
 *
 * The snapshot is GET /api/plans/workspace/:id/effective, which the server
 * resolves exactly as it enforces (override ?? plan ?? registry default, see
 * server/services/billing/effectiveEntitlements.ts). Everything that decides
 * whether a section, a tab, a button or a link exists reads it through here —
 * the sidebar, the command palette, the mobile nav, the dashboard, the route
 * guards and the pages themselves — so one surface can never offer what
 * another hides.
 *
 * The rules:
 *  - available only when the snapshot is in and the value is exactly `true`;
 *  - while it is loading nothing gated is offered (no flash of a section that
 *    then disappears), and pages show a skeleton;
 *  - when it cannot be read nothing gated is offered either, and pages offer
 *    a retry — the server would refuse the requests anyway;
 *  - a key the snapshot does not carry is not available: the server denies
 *    keys it does not know.
 * Core products (Inbox, Knowledge Base, Team, Settings) are never plan-gated.
 */
import type { WorkspaceEffectiveEntitlements } from './entitlements-api';

export type PlanStatus = 'loading' | 'ready' | 'unavailable';

export interface PlanAccess {
  status: PlanStatus;
  module(key: string): boolean;
  channel(key: string): boolean;
  feature(key: string): boolean;
  /** The effective limit: -1 is unlimited; null while the snapshot is not in. */
  limit(key: string): number | null;
}

type Bucket = Record<string, { value: unknown } | undefined> | undefined;

export function planAccessOf(
  snapshot: WorkspaceEffectiveEntitlements | null | undefined,
  failed: boolean,
): PlanAccess {
  const on = (bucket: Bucket) => (key: string) => bucket?.[key]?.value === true;
  return {
    status: snapshot ? 'ready' : failed ? 'unavailable' : 'loading',
    module: on(snapshot?.modules),
    channel: on(snapshot?.channels),
    feature: on(snapshot?.features),
    limit: (key) => {
      const value = snapshot?.limits?.[key]?.value;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    },
  };
}

/** What the member's role and the platform add to the plan. */
export interface SectionContext {
  plan: PlanAccess;
  /** Workspace owner or admin. */
  isAdmin: boolean;
  /** The AI agent is switched on and shown to this workspace's customers; null while unknown. */
  aiSurface: boolean | null;
  /** The AI agent answers by itself; null while unknown. */
  aiAutoAnswer: boolean | null;
  /** The call center is switched on for this workspace; null while unknown. */
  callCenterEnabled: boolean | null;
}

export const APP_SECTIONS = [
  'aiAgent',
  'callCenter',
  'visitors',
  'contacts',
  'seo',
  'webAnalytics',
  'emailInbox',
  'widget',
  'plugins',
  'billing',
] as const;

export type AppSection = (typeof APP_SECTIONS)[number];

/** The plan key a section lives or dies by (null: role-only). */
export const SECTION_PLAN_KEY: Record<AppSection, { module?: string; channel?: string } | null> = {
  aiAgent: { module: 'ai_assistant' },
  callCenter: { module: 'call_center' },
  visitors: { module: 'visitor_tracking' },
  contacts: { module: 'contacts' },
  seo: { module: 'seo' },
  webAnalytics: { module: 'web_analytics' },
  emailInbox: { module: 'email_inbox' },
  widget: { channel: 'chat_widget' },
  plugins: null,
  billing: null,
};

const ADMIN_ONLY: ReadonlySet<AppSection> = new Set(['aiAgent', 'seo', 'webAnalytics', 'emailInbox', 'widget', 'plugins', 'billing']);

export function sectionInPlan(section: AppSection, plan: PlanAccess): boolean {
  const key = SECTION_PLAN_KEY[section];
  if (!key) return true;
  if (key.module) return plan.module(key.module);
  return key.channel ? plan.channel(key.channel) : true;
}

export function sectionVisible(section: AppSection, ctx: SectionContext): boolean {
  if (ADMIN_ONLY.has(section) && !ctx.isAdmin) return false;
  if (!sectionInPlan(section, ctx.plan)) return false;
  if (section === 'aiAgent') return ctx.aiSurface === true;
  if (section === 'callCenter') return ctx.callCenterEnabled === true;
  return true;
}

/**
 * The inbox's AI queue: in the plan, the AI switched on and shown to
 * customers, and either answering by itself or already holding threads.
 */
export function aiQueueVisible(ctx: Pick<SectionContext, 'plan' | 'aiSurface' | 'aiAutoAnswer'>, automatedCount: number): boolean {
  return (
    ctx.plan.feature('inbox_ai_queue') &&
    ctx.aiSurface === true &&
    (ctx.aiAutoAnswer === true || automatedCount > 0)
  );
}

export function needsHumanQueueVisible(plan: PlanAccess): boolean {
  return plan.feature('inbox_needs_human');
}

export function colleaguesQueueVisible(plan: PlanAccess): boolean {
  return plan.feature('inbox_team_chat');
}

/** Channel keys the plan itself governs (the rest are decided by the plugin's own plan check). */
const PLAN_CHANNELS: ReadonlySet<string> = new Set([
  'chat_widget', 'email', 'whatsapp', 'sms', 'instagram', 'telegram', 'bale', 'gmail', 'yahoomail', 'voice', 'video',
]);

/** A channel inbox from the plugin catalog: installed, able to hold an inbox, and allowed by the plan. */
export function channelInboxVisible(
  item: { slug?: string | null; id: string; installed: boolean; supportsInbox: boolean; planAllowed?: boolean },
  plan: PlanAccess,
): boolean {
  if (!item.installed || !item.supportsInbox || item.planAllowed === false) return false;
  const key = (item.slug || item.id).toLowerCase();
  return !PLAN_CHANNELS.has(key) || plan.channel(key);
}
