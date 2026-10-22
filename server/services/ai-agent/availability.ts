/**
 * AI Agent — operator availability proxy.
 *
 * Reuses the widget's authoritative availability resolver so the AI runtime
 * sees the same online/offline state visitors see.
 */
import type { ServerConfig } from '../../config.js';
import { resolveAvailability, type BusinessHoursSchedule } from '../widget/availability.js';
import { listCustomerAvailableOperators, loadWorkspaceAvailabilityPrefs } from '../widget/customerAvailability.js';

export type AvailabilityState = 'online' | 'offline';

export interface AvailabilityInfo {
  state: AvailabilityState;
  reason: string;
  source: 'widget_resolver';
  /**
   * The business hours configured in the workspace panel, when they are on.
   * Described from the row the resolver reads anyway — no extra query.
   */
  schedule: BusinessHoursSchedule | null;
}

export async function getOperatorAvailability(
  config: ServerConfig,
  workspaceId: string,
  locale = 'en',
): Promise<AvailabilityInfo> {
  try {
    const snap = await resolveAvailability(config, { workspaceId, locale, includeSchedule: true });
    return { state: snap.state, reason: snap.reason, source: 'widget_resolver', schedule: snap.schedule ?? null };
  } catch {
    // Fail safe: assume offline so AI can help while operators are unreachable.
    return { state: 'offline', reason: 'resolver_failed', source: 'widget_resolver', schedule: null };
  }
}

/**
 * The availability as the AI Agent's activation page shows it (R-25): the
 * same state, also as `status` (the page reads `status`, which was never
 * sent, so it always said "Unknown" — and, in "auto-reply when operators are
 * offline", that the AI answers now), and how many of the members who count
 * (those who receive chats) are available right now, of how many. The counts
 * are left out when they cannot be read.
 */
export async function describeOperatorAvailability(
  config: ServerConfig,
  workspaceId: string,
): Promise<AvailabilityInfo & { status: AvailabilityState; online_count?: number; total_count?: number }> {
  const [info, prefs] = await Promise.all([
    getOperatorAvailability(config, workspaceId, 'en'),
    loadWorkspaceAvailabilityPrefs(config, workspaceId).catch(() => null),
  ]);
  if (!prefs) return { ...info, status: info.state };
  try {
    const { available } = await listCustomerAvailableOperators(config, workspaceId, new Date(), prefs);
    return {
      ...info,
      status: info.state,
      online_count: available.length,
      total_count: (prefs.chatMemberIds ?? prefs.memberIds).length,
    };
  } catch {
    return { ...info, status: info.state };
  }
}
