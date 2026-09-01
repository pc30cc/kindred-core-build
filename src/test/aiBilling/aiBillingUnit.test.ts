/**
 * AI Usage Billing — deterministic unit invariants.
 *
 * These cover the money-critical pure logic: fixed-point arithmetic, canonical
 * operation hashing (idempotency identity), usage normalization (single parser)
 * and rate-card pricing. Concurrency/settlement invariants live in SQL and are
 * covered by the DB-level tests in aiBillingSql.test.ts (skipped without DB).
 */
import { describe, it, expect } from 'vitest';
import * as D from '../../../server/services/ai-billing/decimal';
import { canonicalPayload, operationRequestHash, billingCycleId } from '../../../server/services/ai-billing/runContext';
import { normalizeUsage } from '../../../server/services/ai-billing/normalize';
import { priceComponent, type RateCardSnapshot } from '../../../server/services/ai-billing/rates';
import { estimateTokens } from '../../../server/services/ai-billing/estimate';

describe('decimal fixed-point', () => {
  it('does not lose precision on tiny provider costs', () => {
    const a = D.fromString('0.000000123456');
    const b = D.fromString('0.000000876544');
    expect(D.toString(D.add(a, b))).toBe('0.000001');
  });

  it('multiplies without early rounding', () => {
    const cost = D.fromString('0.0000005');
    const tokens = D.fromString('1000000');
    expect(D.toString(D.mul(cost, tokens))).toBe('0.5');
  });

  it('rounds only at storage boundary', () => {
    expect(D.toStoredIrr(D.fromString('1234.5678915'))).toBe('1234.567892');
  });

  it('treats empty values as zero and rejects garbage instead of silently mispricing', () => {
    expect(D.isZero(D.fromString(null))).toBe(true);
    expect(D.isZero(D.fromString(''))).toBe(true);
    expect(() => D.fromString('not-a-number')).toThrow(/invalid_decimal/);
  });
});

describe('operation identity', () => {
  const base = { workspaceId: 'w1', conversationId: 'c1', messageId: 'm1', prompt: 'hello' };

  it('is stable across key order', () => {
    expect(operationRequestHash(base)).toBe(
      operationRequestHash({ prompt: 'hello', messageId: 'm1', conversationId: 'c1', workspaceId: 'w1' }),
    );
  });

  it('ignores volatile fields so a retry resumes the same run', () => {
    const retry = { ...base, requestId: 'req-2', attempt: 3, timestamp: Date.now(), traceId: 'x' };
    expect(operationRequestHash(retry)).toBe(operationRequestHash(base));
  });

  it('changes when the business payload changes (conflict, not silent reuse)', () => {
    expect(operationRequestHash({ ...base, prompt: 'different' })).not.toBe(operationRequestHash(base));
  });

  it('canonicalizes nested objects deterministically', () => {
    expect(canonicalPayload({ b: { z: 1, a: 2 }, a: [3, { y: 1, x: 2 }] })).toBe(
      '{"a":[3,{"x":2,"y":1}],"b":{"a":2,"z":1}}',
    );
  });

  it('derives a UTC month cycle id', () => {
    expect(billingCycleId(new Date('2026-03-09T23:30:00Z'))).toBe('2026-03');
  });
});

describe('usage normalization', () => {
  it('produces input/output components from a completion response', () => {
    const u = normalizeUsage({
      provider: 'openai',
      requestedModel: 'gpt-5-nano',
      actualModel: 'gpt-5-nano-2026',
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      latencyMs: 900,
      kind: 'completion',
    });
    expect(u.actualModel).toBe('gpt-5-nano-2026');
    expect(u.totalTokens).toBe(1500);
    const input = u.components.find((c) => c.componentType === 'INPUT_TOKENS');
    const output = u.components.find((c) => c.componentType === 'OUTPUT_TOKENS');
    expect(Number(input?.quantity)).toBe(1200);
    expect(Number(output?.quantity)).toBe(300);
  });

  it('derives total tokens when the provider omits them', () => {
    const u = normalizeUsage({ provider: 'p', requestedModel: 'm', promptTokens: 10, completionTokens: 5, kind: 'completion' });
    expect(u.totalTokens).toBe(15);
  });

  it('emits a single embedding component', () => {
    const u = normalizeUsage({ provider: 'p', requestedModel: 'e', promptTokens: 500, kind: 'embedding' });
    expect(u.components.map((c) => c.componentType)).toEqual(['EMBEDDING_TOKENS']);
  });
});

describe('rate card pricing', () => {
  const card: RateCardSnapshot = {
    id: 'rc1',
    provider: 'openai',
    modelKey: 'gpt-5-nano',
    currency: 'USD',
    version: 1,
    components: [
      { component_type: 'INPUT_TOKENS', unit: 'TOKEN', unit_amount: '0.05', per_units: '1000000' },
      { component_type: 'OUTPUT_TOKENS', unit: 'TOKEN', unit_amount: '0.40', per_units: '1000000' },
    ],
  } as RateCardSnapshot;

  it('prices per unit block exactly', () => {
    expect(D.toString(priceComponent(card, 'INPUT_TOKENS', 1_000_000).amount)).toBe('0.05');
    expect(D.toString(priceComponent(card, 'OUTPUT_TOKENS', 500_000).amount)).toBe('0.2');
  });

  it('returns zero for a component the card does not price', () => {
    const unpriced = priceComponent(card, 'EMBEDDING_TOKENS', 1000);
    expect(unpriced.matched).toBe(false);
    expect(D.isZero(unpriced.amount)).toBe(true);
  });
});

describe('reservation estimation', () => {
  it('estimates non-zero tokens with headroom for output', () => {
    const est = estimateTokens({ promptChars: 4000, maxTokens: 500 });
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.outputTokens).toBeGreaterThanOrEqual(500);
  });
});
