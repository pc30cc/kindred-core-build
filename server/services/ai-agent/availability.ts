/**
 * AI Agent — operator availability proxy.
 *
 * Reuses the widget's authoritative availability resolver so the AI runtime
 * sees the same online/offline state visitors see.
 */
import type { ServerConfig } from '../../config.js';
import { resolveAvailability } from '../widget/availability.js';

export type AvailabilityState = 'online' | 'offline';

export interface AvailabilityInfo {
  state: AvailabilityState;
  reason: string;
  source: 'widget_resolver';
}

export async function getOperatorAvailability(
  config: ServerConfig,
  workspaceId: string,
  locale = 'en',
): Promise<AvailabilityInfo> {
  try {
    const snap = await resolveAvailability(config, { workspaceId, locale });
    return { state: snap.state, reason: snap.reason, source: 'widget_resolver' };
  } catch {
    // Fail safe: assume offline so AI can help while operators are unreachable.
    return { state: 'offline', reason: 'resolver_failed', source: 'widget_resolver' };
  }
}
