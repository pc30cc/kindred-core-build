import type { ServerConfig } from '../../config.js';
import { getPlatformState } from '../plugins/state.js';
import { CommerceError } from '../../../shared/commerce/types.js';

type Policy = { enabled: boolean; sections: Record<string, boolean> };
const cache = new WeakMap<ServerConfig, { until: number; value: Promise<Policy> }>();
export function getOpenCartPolicy(config: ServerConfig): Promise<Policy> {
  const hit = cache.get(config);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = getPlatformState(config, 'opencart').then(state => ({
    enabled: state.enabled && !state.maintenance_mode && state.policy?.aiEnabled !== false,
    sections: (state.policy?.opencartSections ?? {}) as Record<string, boolean>,
  })).catch(() => ({ enabled: false, sections: {} }));
  cache.set(config, { until: Date.now() + 15_000, value });
  return value;
}
export async function assertOpenCartPolicy(config: ServerConfig, section?: string): Promise<void> {
  const policy = await getOpenCartPolicy(config);
  if (!policy.enabled || (section && policy.sections[section] === false)) {
    throw new CommerceError('commerce_permission_denied', 'OpenCart feature disabled by platform');
  }
}
