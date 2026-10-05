/**
 * AI credit top-up limits, as Super Admin sets them (PUT
 * /api/ai-billing/admin/topup-config). They are stored in app_runtime_config
 * under one key; nothing else holds them — platform_settings has no top-up
 * columns. A limit that is not stored takes the caller's own default, so a
 * path keeps the limits it always had until an admin sets them.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export const TOPUP_CONFIG_KEY = 'ai_credit_topup_config';

export interface TopupConfig {
  presetsToman: number[];
  minToman: number;
  maxToman: number;
}

export async function readTopupConfig(config: ServerConfig, defaults: TopupConfig): Promise<TopupConfig> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('app_runtime_config').select('value').eq('key', TOPUP_CONFIG_KEY).maybeSingle();
  const v = (data?.value || {}) as Partial<TopupConfig>;
  return {
    presetsToman: Array.isArray(v.presetsToman) && v.presetsToman.length ? v.presetsToman : defaults.presetsToman,
    minToman: Number.isFinite(v.minToman) ? Number(v.minToman) : defaults.minToman,
    maxToman: Number.isFinite(v.maxToman) ? Number(v.maxToman) : defaults.maxToman,
  };
}
