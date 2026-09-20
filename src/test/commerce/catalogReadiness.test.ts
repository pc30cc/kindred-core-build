/**
 * `commerce_connections.catalog_ready` is the assistant's only guard against
 * answering from an index that has not been filled yet: gateway.ts refuses
 * live reads with `catalog_syncing` while it is false, and the AI runner
 * short-circuits the whole turn.
 *
 * It therefore has exactly one legitimate writer for the `true` value — a
 * sync job that walked the catalogue to completion (sync.ts). The capability
 * handshake reads a field with the SAME NAME off the store's /health, but
 * that one answers a different question ("can this store serve its
 * catalogue?") and the connector plugin hardcodes it to true. Copying it
 * across raised the flag at pairing time, so the guard never fired and the
 * assistant reported an empty catalogue as a complete one.
 *
 * This is the regression guard for that: a handshake may LOWER the flag,
 * never raise it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
const connections: Row[] = [];
const updates: Row[] = [];
let handshakeCatalogReady = true;
let handshakeProtocol = 'webyar-commerce/1';

function fakeClient() {
  return {
    from(table: string) {
      const builder: any = {
        _filters: [] as Array<(r: Row) => boolean>,
        _update: null as Row | null,
        select: () => builder,
        eq(col: string, val: any) {
          builder._filters.push((r: Row) => r[col] === val);
          // Supabase applies the filter at `await` time; `update()` here has
          // no thenable of its own in the real client either, so record on eq.
          if (builder._update && table === 'commerce_connections') updates.push(builder._update);
          return builder;
        },
        update(patch: Row) { builder._update = patch; return builder; },
        maybeSingle: async () => {
          const m = connections.filter((r) => builder._filters.every((f: any) => f(r)));
          return { data: m[0] ?? null, error: null };
        },
        then: (resolve: any) => resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  storeInstallationSecret: async () => {},
  readInstallationSecret: async () => 'a-secret',
}));
vi.mock('../../../server/services/commerce/audit.js', () => ({ writeCommerceAudit: async () => {} }));
vi.mock('../../../server/services/plugins/state.js', () => ({ installPlugin: async () => {} }));
vi.mock('../../../server/services/commerce/connectors/woocommerce.js', () => ({
  WooCommerceConnector: class {
    async negotiateCapabilities() {
      return {
        protocolVersion: handshakeProtocol,
        connectorVersion: '1.0.0',
        woocommerceVersion: '11.1.1',
        wordpressVersion: '7.1.1',
        hposEnabled: true,
        capabilities: ['products.read'],
        catalogReady: handshakeCatalogReady,
      };
    }
  },
}));

const { runCapabilityHandshake } = await import('../../../server/services/commerce/pairing.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

beforeEach(() => {
  connections.length = 0;
  updates.length = 0;
  handshakeCatalogReady = true;
  handshakeProtocol = 'webyar-commerce/1';
  connections.push({ id: 'conn-1', installation_id: 'inst-1', approved_origin: 'https://shop.example.com', workspace_id: 'ws-1', revoked_at: null, catalog_ready: false });
});

describe('catalog_ready is only raised by a completed sync', () => {
  it('does not raise the flag when the store reports its catalogue is ready', async () => {
    // The live plugin answers /health with a constant catalog_ready:true, so
    // this is the ordinary case, not an edge case.
    await runCapabilityHandshake(CONFIG, 'conn-1');

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('catalog_ready');
    expect(updates[0].health).toBe('connected');
  });

  it('still lowers the flag when the store reports it cannot serve its catalogue', async () => {
    handshakeCatalogReady = false;
    await runCapabilityHandshake(CONFIG, 'conn-1');

    expect(updates[0].catalog_ready).toBe(false);
  });

  it('records the rest of the handshake either way', async () => {
    await runCapabilityHandshake(CONFIG, 'conn-1');

    expect(updates[0]).toMatchObject({
      connector_version: '1.0.0',
      woocommerce_version: '11.1.1',
      wordpress_version: '7.1.1',
      hpos_enabled: true,
      protocol_version: 'webyar-commerce/1',
    });
  });

  it('flags a protocol mismatch without touching readiness', async () => {
    handshakeProtocol = 'webyar-commerce/999';
    await runCapabilityHandshake(CONFIG, 'conn-1');

    expect(updates[0].health).toBe('protocol_mismatch');
    expect(updates[0]).not.toHaveProperty('catalog_ready');
  });
});
