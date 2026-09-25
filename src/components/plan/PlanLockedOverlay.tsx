import type { ReactNode } from 'react';
import { EntitlementAccessGate, type EntitlementRequirement } from './EntitlementAccessGate';

/**
 * Phase 6-S5-R4 — `knowledge_base` is deliberately ABSENT: the Knowledge Base
 * is a core product and is never locked by a plan.
 */
type ModuleKey =
  | 'ai_assistant'
  | 'call_center'
  | 'visitor_tracking'
  | 'contacts'
  | 'seo'
  | 'seo_backlinks'
  | 'seo_keywords'
  | 'seo_rank_tracking'
  | 'seo_performance'
  | 'seo_gsc_insights'
  | 'seo_site_explorer'
  | 'web_analytics'
  | 'bot_analytics'
  | 'brand_radar'
  | 'email_inbox';

interface Props {
  /** Locks on a plan module (Sidebar-level product areas). */
  moduleKey?: ModuleKey;
  /** Locks on a plan channel (e.g. `chat_widget`). */
  channelKey?: string;
  /**
   * Locks on a plan *feature* capability key (e.g. `widget_smart_engagement`).
   * Used for tab-level surfaces inside an otherwise available module.
   */
  featureKey?: string;
  /** Name shown in the upgrade message; defaults to the capability's localized name. */
  featureLabel?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Wrap a page or section the plan decides. It is the same non-mounting gate
 * as EntitlementAccessGate: the content is never rendered — so it never
 * fetches or holds data — unless the plan snapshot says `true`. Locked shows
 * the upgrade card (page-sized for a module or channel, inline for a
 * feature); loading shows a skeleton; an unreadable plan offers a retry.
 */
export function PlanLockedOverlay({ moduleKey, channelKey, featureKey, featureLabel, children, className }: Props) {
  const requirement: EntitlementRequirement | null = featureKey
    ? { type: 'feature', key: featureKey }
    : moduleKey
      ? { type: 'module', key: moduleKey }
      : channelKey
        ? { type: 'channel', key: channelKey }
        : null;
  if (!requirement) return <>{children}</>;
  return (
    <EntitlementAccessGate
      requirements={[requirement]}
      mode={featureKey ? 'inline' : 'page'}
      showBack={!featureKey}
      className={className}
      capabilityName={featureLabel}
    >
      {children}
    </EntitlementAccessGate>
  );
}
