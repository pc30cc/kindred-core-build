/**
 * Rollout mode of the AI billing domain.
 *
 *  METER_ONLY  — usage is measured and priced, but never blocks execution and
 *                never touches the wallet. Missing pricing config marks the run
 *                UNRESOLVED instead of failing.
 *  ENFORCED    — pricing must resolve BEFORE any billable provider execution,
 *                budget is reserved up front, and a zero balance denies the run.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type BillingMode = 'METER_ONLY' | 'ENFORCED';

const RUNTIME_KEY = 'ai_billing_mode';
const TTL_MS = 30_000;

let cached: { value: BillingMode; at: number } | null = null;

export function resetBillingModeCache(): void {
  cached = null;
}

export async function getBillingMode(config: ServerConfig): Promise<BillingMode> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value: BillingMode = 'METER_ONLY';
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', RUNTIME_KEY)
      .maybeSingle();
    const raw = (data?.value as any)?.mode ?? (data?.value as any);
    if (raw === 'ENFORCED' || raw === 'METER_ONLY') value = raw;
  } catch {
    value = 'METER_ONLY';
  }
  cached = { value, at: now };
  return value;
}

export async function setBillingMode(config: ServerConfig, mode: BillingMode): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('app_runtime_config').upsert(
    { key: RUNTIME_KEY, value: { mode } },
    { onConflict: 'key' },
  );
  cached = { value: mode, at: Date.now() };
}
