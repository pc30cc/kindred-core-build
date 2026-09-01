/**
 * Pricing resolution for the AI billing domain.
 *
 * Snapshot semantics (locked):
 *  - sell policy (multiplier + overage policy) and the billing FX (USD→IRR)
 *    are resolved ONCE at run start and frozen on the run row;
 *  - the provider rate card is resolved PER usage event at the moment the step
 *    executes, and the provider-currency→USD FX snapshot is taken per event.
 *
 * An admin publishing a new rate card / FX / multiplier mid-run therefore has a
 * deterministic effect: the run keeps its FX and multiplier, and only steps
 * started after the change use the new rate card.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as D from './decimal.js';

export interface RateCardComponent {
  component_type: string;
  unit: string;
  unit_amount: string;
  per_units: string;
}

export interface RateCardSnapshot {
  id: string;
  provider: string;
  model_key: string;
  currency: string;
  version: number;
  components: RateCardComponent[];
}

export interface FxSnapshot {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: string;
}

export interface SellPolicySnapshot {
  id: string;
  multiplier: string;
  overage_policy: 'CAP_AND_ABSORB' | 'HALT_BILLABLE_EXECUTION';
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: any }>();

export function resetRateCache(): void {
  cache.clear();
}

async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: now, value });
  return value;
}

export async function resolveRateCard(
  config: ServerConfig,
  provider: string,
  modelKey: string,
): Promise<RateCardSnapshot | null> {
  return memo(`rc:${provider}:${modelKey}`, async () => {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('ai_rate_cards')
      .select('id, provider, model_key, currency, version, ai_rate_card_components(component_type, unit, unit_amount, per_units)')
      .eq('provider', provider)
      .eq('model_key', modelKey)
      .is('effective_to', null)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id as string,
      provider: data.provider as string,
      model_key: data.model_key as string,
      currency: (data.currency as string) || 'USD',
      version: data.version as number,
      components: ((data as any).ai_rate_card_components || []).map((c: any) => ({
        component_type: c.component_type,
        unit: c.unit,
        unit_amount: String(c.unit_amount),
        per_units: String(c.per_units),
      })),
    } as RateCardSnapshot;
  });
}

export async function resolveFx(
  config: ServerConfig,
  from: string,
  to: string,
): Promise<FxSnapshot | null> {
  if (from === to) return { id: '', from_currency: from, to_currency: to, rate: '1' };
  return memo(`fx:${from}:${to}`, async () => {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('ai_exchange_rates')
      .select('id, from_currency, to_currency, rate')
      .eq('from_currency', from)
      .eq('to_currency', to)
      .is('effective_to', null)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id as string,
      from_currency: data.from_currency as string,
      to_currency: data.to_currency as string,
      rate: String(data.rate),
    } as FxSnapshot;
  });
}

export async function resolveSellPolicy(
  config: ServerConfig,
  workspaceId: string,
): Promise<SellPolicySnapshot | null> {
  return memo(`sp:${workspaceId}`, async () => {
    const sb = getServiceClient(config);
    const ws = await sb
      .from('ai_sell_policies')
      .select('id, multiplier, overage_policy')
      .eq('scope', 'WORKSPACE')
      .eq('workspace_id', workspaceId)
      .is('effective_to', null)
      .maybeSingle();
    const row =
      ws.data ||
      (
        await sb
          .from('ai_sell_policies')
          .select('id, multiplier, overage_policy')
          .eq('scope', 'GLOBAL')
          .is('effective_to', null)
          .maybeSingle()
      ).data;
    if (!row) return null;
    return {
      id: row.id as string,
      multiplier: String(row.multiplier),
      overage_policy: row.overage_policy as SellPolicySnapshot['overage_policy'],
    } as SellPolicySnapshot;
  });
}

/** Provider-currency cost of one usage component, in the rate card currency. */
export function priceComponent(
  card: RateCardSnapshot,
  componentType: string,
  quantity: string | number,
): { amount: D.Dec; matched: boolean } {
  const comp = card.components.find((c) => c.component_type === componentType);
  if (!comp) return { amount: 0n, matched: false };
  const qty = D.fromString(quantity);
  const unit = D.fromString(comp.unit_amount);
  const per = D.fromString(comp.per_units || '1');
  if (per === 0n) return { amount: 0n, matched: true };
  return { amount: D.div(D.mul(qty, unit), per), matched: true };
}
