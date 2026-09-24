import type { ServerConfig } from '../../../config.js';
import { getPlatformState } from '../../plugins/state.js';
import { WHMCS_CONNECTION_PERMISSIONS, type WhmcsConnectionPermission } from '../../../../shared/commerce/whmcs.js';

export interface WhmcsPolicy {
  enabled: boolean;
  sections: Partial<Record<WhmcsConnectionPermission, boolean>>;
}

// One entry per server config, coalesced across concurrent turns. No source
// content or visitor data is stored here. Other workers observe changes in 15s.
let cache = new WeakMap<ServerConfig, { until: number; value: Promise<WhmcsPolicy> }>();

export function invalidateWhmcsPolicy(config?: ServerConfig): void {
  if (config) cache.delete(config);
  else cache = new WeakMap();
}

export function getWhmcsPolicy(config: ServerConfig): Promise<WhmcsPolicy> {
  const hit = cache.get(config);
  if (hit && Date.now() < hit.until) return hit.value;
  const value = getPlatformState(config, 'whmcs').then((state) => {
    const raw = state.policy?.whmcsSections;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const sections: WhmcsPolicy['sections'] = {};
    for (const key of WHMCS_CONNECTION_PERMISSIONS) sections[key] = source[key] !== false;
    return { enabled: state.enabled && !state.maintenance_mode && state.policy?.aiEnabled !== false, sections };
  }).catch(() => ({ enabled: false, sections: {} }));
  cache.set(config, { until: Date.now() + 15_000, value });
  return value;
}
