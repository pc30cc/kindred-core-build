/**
 * Event ingestion — idempotency (spec §16/§62) and out-of-order protection
 * (spec §61/§65). A fake DB simulates the two invariants the real Postgres
 * migration (148_commerce_platform.sql) enforces structurally:
 *   - a UNIQUE (installation_id, event_id) index on commerce_event_receipts
 *   - commerce_upsert_product's `WHERE EXCLUDED.entity_version > ...`
 * so this test proves the SERVICE-LAYER logic drives those primitives
 * correctly, without requiring a live Postgres instance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CommerceEvent } from '../../../shared/commerce/types.js';

type Row = Record<string, any>;
const receipts: Row[] = [];
const products: Row[] = [];
let upsertCallCount = 0;

function fakeClient() {
  return {
    from(table: string) {
      const builder: any = {
        insert(row: Row) {
          if (table === 'commerce_event_receipts') {
            const dup = receipts.find((r) => r.installation_id === row.installation_id && r.event_id === row.event_id);
            if (dup) {
              return { select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) };
            }
            receipts.push({ ...row });
            return { select: () => ({ maybeSingle: async () => ({ data: { id: String(receipts.length) }, error: null }) }) };
          }
          return { select: () => ({ maybeSingle: async () => ({ data: {}, error: null }) }) };
        },
        update() { return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
        eq() { return builder; },
      };
      return builder;
    },
    rpc: async (fn: string, params: Record<string, any>) => {
      if (fn === 'commerce_upsert_product') {
        upsertCallCount += 1;
        const existing = products.find((p) => p.connection_id === params.p_connection_id && p.external_id === params.p_external_id);
        if (existing && !(params.p_entity_version > existing.entity_version)) {
          // Out-of-order / stale write — no-op, exactly like the real
          // `WHERE EXCLUDED.entity_version > commerce_products.entity_version`.
          return { data: [{ product_id: existing.id, written: false }], error: null };
        }
        const id = existing?.id ?? `p-${products.length + 1}`;
        const row = { id, connection_id: params.p_connection_id, external_id: params.p_external_id, title: params.p_title, entity_version: params.p_entity_version };
        if (existing) Object.assign(existing, row); else products.push(row);
        return { data: [{ product_id: id, written: true }], error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

const { ingestCommerceEvent } = await import('../../../server/services/commerce/events.js');

const config = {} as any;
const WORKSPACE_ID = 'ws-1';
const CONNECTION_ID = 'conn-1';
const INSTALLATION_ID = 'inst-1';

function productEvent(overrides: Partial<CommerceEvent> = {}): CommerceEvent {
  return {
    event_id: 'evt-1',
    installation_id: INSTALLATION_ID,
    type: 'product.updated',
    entity_id: '101',
    entity_version: '2026-01-01T00:00:00.000Z',
    occurred_at: '2026-01-01T00:00:00.000Z',
    protocol_version: 'webyar-commerce/1',
    payload: { externalId: '101', title: 'Shoe', currency: 'IRR', updatedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

beforeEach(() => {
  receipts.length = 0;
  products.length = 0;
  upsertCallCount = 0;
});

describe('commerce event ingestion', () => {
  it('processes a fresh event exactly once', async () => {
    const outcome = await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent());
    expect(outcome.status).toBe('processed');
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('Shoe');
  });

  it('the SAME event_id delivered twice has exactly one effective state transition', async () => {
    await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent());
    const second = await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent());

    expect(second.status).toBe('duplicate');
    expect(products).toHaveLength(1); // no duplicate side effect
    expect(upsertCallCount).toBe(1); // the duplicate never even reached the upsert
  });

  it('an OLDER event landing after a newer one does not regress state (out-of-order protection)', async () => {
    await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent({
      event_id: 'evt-new', entity_version: '2026-02-01T00:00:00.000Z',
      payload: { externalId: '101', title: 'New Title', currency: 'IRR', updatedAt: '2026-02-01T00:00:00.000Z' },
    }));
    // A stale page from an initial sync racing behind the live update above.
    await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent({
      event_id: 'evt-old', entity_version: '2026-01-01T00:00:00.000Z',
      payload: { externalId: '101', title: 'Old Title', currency: 'IRR', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));

    expect(products).toHaveLength(1);
    expect(products[0].title).toBe('New Title'); // the OLDER write never overwrote the newer state
  });

  it('a newer event correctly supersedes an older one delivered first', async () => {
    await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent({
      event_id: 'evt-1', entity_version: '2026-01-01T00:00:00.000Z',
      payload: { externalId: '101', title: 'v1', currency: 'IRR', updatedAt: '2026-01-01T00:00:00.000Z' },
    }));
    await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent({
      event_id: 'evt-2', entity_version: '2026-03-01T00:00:00.000Z',
      payload: { externalId: '101', title: 'v2', currency: 'IRR', updatedAt: '2026-03-01T00:00:00.000Z' },
    }));
    expect(products[0].title).toBe('v2');
  });

  it('order events are receipted for idempotency but never mirrored into the product index (PII minimization, spec §31)', async () => {
    const outcome = await ingestCommerceEvent(config, WORKSPACE_ID, CONNECTION_ID, productEvent({
      event_id: 'evt-order', type: 'order.status_changed', entity_id: '9001',
      payload: { externalId: '9001', from: 'pending', to: 'processing' },
    }));
    expect(outcome.status).toBe('processed');
    expect(products).toHaveLength(0); // no product-table write ever happens for an order event
  });
});
