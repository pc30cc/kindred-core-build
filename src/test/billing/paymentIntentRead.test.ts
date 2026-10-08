/**
 * readPaymentIntent tells "this database has no such intent" from "the read
 * failed". The webhook acknowledges an event as another installation's only
 * on the first; on the second it answers 5xx so the provider retries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queried: string[] = [];
let answer: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (_c: string, v: string) => {
        queried.push(`${table}:${v}`);
        return b;
      };
      b.maybeSingle = async () => answer;
      return b;
    },
  }),
}));

const { readPaymentIntent, getPaymentIntent, PaymentIntentReadError, isProcessingInFlight, PROCESSING_RECLAIM_MS } =
  await import('../../../server/services/billing/paymentIntent.js');

const CFG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queried.length = 0;
  answer = { data: null, error: null };
});

describe('readPaymentIntent', () => {
  it('returns the row', async () => {
    answer = { data: { id: ID, status: 'pending' }, error: null };
    expect(await readPaymentIntent(CFG, ID)).toEqual({ id: ID, status: 'pending' });
    expect(queried).toEqual([`billing_payment_intents:${ID}`]);
  });

  it('null when no row exists', async () => {
    expect(await readPaymentIntent(CFG, ID)).toBeNull();
  });

  it('throws when the read fails — never null', async () => {
    answer = { data: null, error: { message: 'connection reset' } };
    await expect(readPaymentIntent(CFG, ID)).rejects.toBeInstanceOf(PaymentIntentReadError);
    await expect(readPaymentIntent(CFG, ID)).rejects.toThrow(/payment_intent_read_failed:connection reset/);
    // The lenient read the other routes use still swallows it (unchanged).
    expect(await getPaymentIntent(CFG, ID)).toBeNull();
  });

  it.each(['', 'order-42', `${ID}x`, '33333333333343338333333333333333'])('an id that is not a UUID (%j) is absent, without a query', async (id) => {
    answer = { data: null, error: { message: 'invalid input syntax for type uuid' } };
    expect(await readPaymentIntent(CFG, id)).toBeNull();
    expect(queried).toEqual([]);
  });
});

describe('isProcessingInFlight', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('only a processing claim younger than the reclaim window', () => {
    expect(isProcessingInFlight({ status: 'processing', processing_at: at(1_000) }, now)).toBe(true);
    expect(isProcessingInFlight({ status: 'processing', processing_at: at(PROCESSING_RECLAIM_MS - 1) }, now)).toBe(true);
    expect(isProcessingInFlight({ status: 'processing', processing_at: at(PROCESSING_RECLAIM_MS) }, now)).toBe(false);
    expect(isProcessingInFlight({ status: 'processing', processing_at: null }, now)).toBe(false);
    expect(isProcessingInFlight({ status: 'pending', processing_at: at(1_000) }, now)).toBe(false);
  });
});
