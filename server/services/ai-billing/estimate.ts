/**
 * Pre-execution cost estimation. Used only to size the reservation; the real
 * charge always comes from the recorded usage events at settlement.
 */

import * as D from './decimal.js';
import type { RateCardSnapshot } from './rates.js';
import { priceComponent } from './rates.js';

export interface EstimateInput {
  promptChars: number;
  maxTokens?: number | null;
}

/** ~4 characters per token, plus a safety headroom of 25%. */
export function estimateTokens(input: EstimateInput): { inputTokens: number; outputTokens: number } {
  const inputTokens = Math.ceil(Math.max(input.promptChars, 0) / 4);
  const outputTokens = Math.max(input.maxTokens ?? 0, 512);
  return { inputTokens, outputTokens };
}

/** Estimated provider cost in the rate card currency. */
export function estimateProviderCost(card: RateCardSnapshot, est: { inputTokens: number; outputTokens: number }): D.Dec {
  const headroom = D.fromString('1.25');
  const input = priceComponent(card, 'INPUT_TOKENS', est.inputTokens).amount;
  const output = priceComponent(card, 'OUTPUT_TOKENS', est.outputTokens).amount;
  return D.mul(D.add(input, output), headroom);
}
