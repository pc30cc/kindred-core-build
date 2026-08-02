/**
 * Thin wrappers over the shared, non-mounting EntitlementAccessGate core.
 * Kept as separate components so call sites stay readable.
 */
import type { ReactNode } from 'react';
import { EntitlementAccessGate } from './EntitlementAccessGate';

/**
 * Phase 6-S5-R4 — `knowledge_base` is deliberately ABSENT from this union.
 * The Knowledge Base is a core workspace product and must never be placed
 * behind a plan gate; removing the key makes that a compile-time guarantee.
 */
export type PlanModuleKey =
  | 'ai_assistant'
  | 'call_center'
  | 'visitor_tracking'
  | 'contacts';

interface CommonProps {
  children: ReactNode;
  className?: string;
  lockedTitle?: string;
  lockedDescription?: string;
  showBack?: boolean;
  mode?: 'page' | 'inline';
}

export function PlanAccessGate({ moduleKey, ...rest }: CommonProps & { moduleKey: PlanModuleKey }) {
  return <EntitlementAccessGate requirements={[{ type: 'module', key: moduleKey }]} {...rest} />;
}

export function PlanFeatureAccessGate({
  featureKey,
  ...rest
}: CommonProps & { featureKey: string }) {
  return <EntitlementAccessGate requirements={[{ type: 'feature', key: featureKey }]} {...rest} />;
}

export default PlanAccessGate;
