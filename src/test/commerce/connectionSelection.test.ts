/**
 * Scenario 9 of the WHMCS brief: WooCommerce and WHMCS in one workspace, each
 * turn about the right one — and never "the newest connection" by accident.
 */
import { describe, it, expect } from 'vitest';
import { selectConnection } from '../../../server/services/commerce/connectionSelection.js';
import type { CommerceConnectionRow } from '../../../server/services/commerce/gateway.js';

function row(over: Partial<CommerceConnectionRow>): CommerceConnectionRow {
  return {
    id: 'c', workspace_id: 'ws', installation_id: 'i', provider_type: 'woocommerce', store_id: 'https://shop.example.com',
    approved_origin: 'https://shop.example.com', capabilities: [], permissions: {}, health: 'connected', catalog_ready: true,
    revoked_at: null, protocol_version: 'webyar-commerce/1', created_at: '2026-01-01', ...over,
  };
}

const woo = row({ id: 'woo', created_at: '2026-01-01' });
const whmcs = row({ id: 'whmcs', provider_type: 'whmcs', store_id: 'https://billing.example.com/whmcs', approved_origin: 'https://billing.example.com', created_at: '2026-09-01' });
const whmcsSameHost = row({ id: 'whmcs2', provider_type: 'whmcs', store_id: 'https://shop.example.com/billing', approved_origin: 'https://shop.example.com' });

describe('which connection a turn is about', () => {
  it('a workspace with only WooCommerce behaves exactly as before', () => {
    expect(selectConnection([woo], { family: 'store' })).toEqual({ connection: woo, reason: 'only_one' });
    expect(selectConnection([woo], { family: 'store', pageOrigin: 'https://www.example.com' }).connection).toBe(woo);
    expect(selectConnection([woo], { family: 'billing' }).connection).toBeNull();
  });

  it('with both, each family resolves to its own connection — newer WHMCS does not capture the shop', () => {
    expect(selectConnection([whmcs, woo], { family: 'store' }).connection).toBe(woo);
    expect(selectConnection([whmcs, woo], { family: 'billing' }).connection).toBe(whmcs);
  });

  it('the page the visitor is on decides, and another site’s family is out of context', () => {
    expect(selectConnection([whmcs, woo], { family: 'billing', pageOrigin: 'https://billing.example.com' })).toEqual({ connection: whmcs, reason: 'page_origin' });
    expect(selectConnection([whmcs, woo], { family: 'store', pageOrigin: 'https://billing.example.com' })).toEqual({ connection: null, reason: 'other_site' });
    expect(selectConnection([whmcs, woo], { family: 'store', pageOrigin: 'https://shop.example.com' }).connection).toBe(woo);
  });

  it('two connections on one host are told apart by path', () => {
    const rows = [woo, whmcsSameHost];
    expect(selectConnection(rows, { family: 'billing', pageOrigin: 'https://shop.example.com', pagePath: '/billing/clientarea.php' }).connection).toBe(whmcsSameHost);
    expect(selectConnection(rows, { family: 'store', pageOrigin: 'https://shop.example.com', pagePath: '/product/x' }).connection).toBe(woo);
    expect(selectConnection(rows, { family: 'store', pageOrigin: 'https://shop.example.com', pagePath: '/billing/cart.php' }).reason).toBe('other_site');
  });

  it('an identity binding wins', () => {
    const other = row({ id: 'whmcs-b', provider_type: 'whmcs', store_id: 'https://b.example.com', approved_origin: 'https://b.example.com' });
    expect(selectConnection([whmcs, other], { family: 'billing', boundConnectionId: 'whmcs-b' })).toEqual({ connection: other, reason: 'bound' });
  });

  it('ambiguity selects nothing (no silent "newest" fallback)', () => {
    const woo2 = row({ id: 'woo2', store_id: 'https://shop2.example.com', approved_origin: 'https://shop2.example.com', created_at: '2027-01-01' });
    expect(selectConnection([woo, woo2], { family: 'store' })).toEqual({ connection: null, reason: 'ambiguous' });
    expect(selectConnection([woo, woo2], { family: 'store', pageOrigin: 'https://shop2.example.com' }).connection).toBe(woo2);
  });

  it('revoked or disconnected connections are never selected', () => {
    expect(selectConnection([row({ revoked_at: '2026-09-01' })], { family: 'store' }).connection).toBeNull();
    expect(selectConnection([row({ health: 'disconnected' })], { family: 'store' }).connection).toBeNull();
  });
});
