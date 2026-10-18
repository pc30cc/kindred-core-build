/**
 * The order card builders (server/services/ai-agent/commerce-tools/orderCard.ts):
 * pure functions from the objects the commerce stage already fetched to the
 * `metadata.order` a t2 widget draws. Every WooCommerce status, every OpenCart
 * status category, the field rules (number, summary, more, arrives, tracking
 * link) and "never throws".
 */
import { describe, it, expect } from 'vitest';
import {
  orderCardFromStore,
  orderCardFromDirect,
  stepFor,
  safeTrackingUrl,
  arrivalDay,
} from '../../../server/services/ai-agent/commerce-tools/orderCard.js';
import type { DirectOrderDetail, DirectTrackingResult, TrackingResult } from '../../../shared/commerce/types.js';

const money = { amountMinor: '1000', currency: 'IRT' };
const line = (title: string) => ({ productExternalId: '1', title, quantity: 1, total: money });

function tracking(extra: Partial<TrackingResult> = {}): TrackingResult {
  return { externalOrderId: '48213', carrier: 'Post', trackingNumber: 'RR123', trackingUrl: 'https://tracking.post.ir/?id=RR123', status: 'in transit', updatedAt: null, ...extra };
}

function detail(category: 'processing' | 'complete' | 'other', name: string | null = 'Processing', extra: Partial<DirectOrderDetail> = {}): DirectOrderDetail {
  const display = { amount: '1', currency: 'USD', formatted: '$1' };
  return {
    externalId: '5002', createdAt: null, updatedAt: null, status: { name, category }, total: display, itemCount: 1,
    currency: 'USD', items: [{ productExternalId: '7', name: 'MacBook Air', model: null, quantity: 1, options: [], total: display }],
    itemsTruncated: false, totals: [], shippingMethod: null, paymentMethod: null, paymentStatus: 'not_reported_by_store', history: [], viewUrl: null,
    ...extra,
  };
}

function shipments(list: DirectTrackingResult['shipments'], available = true): DirectTrackingResult {
  return { externalOrderId: '5002', available, reason: null, shipments: list, status: { name: 'Shipped', category: 'processing' } };
}

describe('status → step (WooCommerce)', () => {
  it.each([
    ['pending', false, 'pending', 0],
    ['on_hold', false, 'on_hold', 0],
    ['processing', false, 'processing', 1],
    ['processing', true, 'shipped', 2],
    ['completed', false, 'completed', 3],
    ['completed', true, 'completed', 3],
    ['cancelled', false, 'cancelled', null],
    ['cancelled', true, 'cancelled', null],
    ['refunded', false, 'refunded', null],
    ['failed', false, 'failed', null],
    ['unknown', false, 'unknown', null],
    ['unknown', true, 'shipped', 2],
    ['wc-custom-status', false, 'unknown', null],
    ['pending', true, 'pending', 0],
  ] as const)('%s (tracking %s) → %s, step %s', (status, hasTracking, cardStatus, step) => {
    expect(stepFor(status, hasTracking)).toEqual({ status: cardStatus, step });
  });
});

describe('orderCardFromStore', () => {
  it('the latest order with tracking: shipped, step 2, the link, no label', () => {
    expect(orderCardFromStore({ externalId: '48213', status: 'processing' }, tracking())).toEqual({
      v: 1, number: '48213', summary: null, more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null,
      trackingUrl: 'https://tracking.post.ir/?id=RR123',
    });
  });

  it('completed: all four steps (step 3) and the completed status', () => {
    const card = orderCardFromStore({ externalId: 48213, status: 'completed' }, null);
    expect(card).toMatchObject({ number: '48213', status: 'completed', step: 3, trackingUrl: null });
  });

  it('a tracking row with neither a number nor a usable link does not make it shipped', () => {
    const card = orderCardFromStore({ externalId: '1', status: 'processing' }, tracking({ trackingNumber: null, trackingUrl: 'javascript:alert(1)' }));
    expect(card).toMatchObject({ status: 'processing', step: 1, trackingUrl: null });
  });

  it('a full order: the first product line as the summary, the other lines counted', () => {
    const card = orderCardFromStore({ externalId: '9', status: 'on_hold', lineItems: [line('کفش رانینگ، سایز ۴۲'), line('جوراب'), line('بند کفش')] }, null);
    expect(card).toMatchObject({ summary: 'کفش رانینگ، سایز ۴۲', more: 2, status: 'on_hold', step: 0 });
  });

  it('the plugin summary fields (optional) when there are no line items', () => {
    expect(orderCardFromStore({ externalId: '9', status: 'pending', itemSummary: 'Hat', itemCount: 3 }, null)).toMatchObject({ summary: 'Hat', more: 2 });
    expect(orderCardFromStore({ externalId: '9', status: 'pending', itemSummary: 'Hat' }, null)).toMatchObject({ summary: 'Hat', more: 0 });
    expect(orderCardFromStore({ externalId: '9', status: 'pending', itemCount: 3 }, null)).toMatchObject({ summary: null, more: 0 });
  });

  it('summaries are sanitized and capped at 80 characters', () => {
    const long = 'x'.repeat(200);
    const card = orderCardFromStore({ externalId: '9', status: 'pending', lineItems: [line(`<img src=x onerror=alert(1)>${long}`)] }, null);
    expect(card?.summary).not.toContain('<');
    expect(card?.summary?.length).toBeLessThanOrEqual(81);
    expect(card?.summary?.endsWith('…')).toBe(true);
    const ctrl = orderCardFromStore({ externalId: '9', status: 'pending', lineItems: [line('a\u0000b\u0007c')] }, null);
    expect(ctrl?.summary).toBe('abc');
  });

  it('only a plain order number makes a card', () => {
    for (const bad of ['1 OR 1', 'x'.repeat(40), '', '<b>', '12/34', null, undefined, {}, '۴۸۲۱۳']) {
      expect(orderCardFromStore({ externalId: bad, status: 'pending' }, null)).toBeNull();
    }
    for (const ok of ['48213', '#48213', 'WC-1.2_3', 'x'.repeat(32)]) {
      expect(orderCardFromStore({ externalId: ok, status: 'pending' }, null)?.number).toBe(ok);
    }
  });

  it('the delivery day only from a real YYYY-MM-DD at the start of estimatedDelivery', () => {
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, tracking({ estimatedDelivery: '2026-10-23T10:00:00Z' }))?.arrives).toBe('2026-10-23');
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, tracking({ estimatedDelivery: '23/10/2026' }))?.arrives).toBeNull();
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, tracking({ estimatedDelivery: '2026-02-30' }))?.arrives).toBeNull();
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, tracking())?.arrives).toBeNull();
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, null)?.arrives).toBeNull();
  });

  it('WooCommerce never carries a status label', () => {
    expect(orderCardFromStore({ externalId: '1', status: 'processing' }, tracking())?.statusLabel).toBeNull();
  });

  it('never throws, whatever the input', () => {
    const hostile = { get externalId() { throw new Error('boom'); }, status: 'pending' };
    expect(orderCardFromStore(hostile as never, null)).toBeNull();
    expect(orderCardFromStore(null, null)).toBeNull();
    expect(orderCardFromStore({ externalId: '1', status: 'pending', lineItems: [null, 3] as never }, null)).toMatchObject({ summary: null });
  });
});

describe('orderCardFromDirect (OpenCart)', () => {
  it('processing → step 1 with the store’s own status name', () => {
    expect(orderCardFromDirect(detail('processing', 'در حال پردازش'), null)).toEqual({
      v: 1, number: '5002', summary: 'MacBook Air', more: 0, status: 'processing', statusLabel: 'در حال پردازش', step: 1, arrives: null, trackingUrl: null,
    });
  });

  it('processing with a shipment number or link → shipped, step 2', () => {
    const withUrl = orderCardFromDirect(detail('processing', 'Shipped'), shipments([{ carrier: 'DHL', trackingNumber: null, trackingUrl: 'https://dhl.example/t/1', status: null, updatedAt: null, source: 'x' }]));
    expect(withUrl).toMatchObject({ status: 'shipped', step: 2, trackingUrl: 'https://dhl.example/t/1' });
    const withNumber = orderCardFromDirect(detail('processing'), shipments([{ carrier: 'DHL', trackingNumber: 'Z9', trackingUrl: null, status: null, updatedAt: null, source: 'x' }]));
    expect(withNumber).toMatchObject({ status: 'shipped', step: 2, trackingUrl: null });
  });

  it('an unavailable tracking answer is no tracking', () => {
    const card = orderCardFromDirect(detail('processing'), shipments([{ carrier: null, trackingNumber: 'Z9', trackingUrl: 'https://x.example/', status: null, updatedAt: null, source: 'x' }], false));
    expect(card).toMatchObject({ status: 'processing', step: 1, trackingUrl: null });
  });

  it('complete → completed, step 3', () => {
    expect(orderCardFromDirect(detail('complete', 'Complete'), null)).toMatchObject({ status: 'completed', step: 3, statusLabel: 'Complete' });
  });

  it('other (pending, canceled, custom) → unknown with no progress row, the label kept for the pill', () => {
    expect(orderCardFromDirect(detail('other', 'Canceled'), null)).toMatchObject({ status: 'unknown', step: null, statusLabel: 'Canceled' });
    expect(orderCardFromDirect(detail('other', null), null)).toMatchObject({ status: 'unknown', step: null, statusLabel: null });
  });

  it('the label is sanitized and capped at 40', () => {
    const card = orderCardFromDirect(detail('other', `<b>${'y'.repeat(60)}</b>`), null);
    expect(card?.statusLabel).not.toContain('<');
    expect(card?.statusLabel?.length).toBeLessThanOrEqual(41);
  });

  it('more counts the other product lines, also beyond the truncated item list', () => {
    const display = { amount: '1', currency: 'USD', formatted: '$1' };
    const item = (name: string) => ({ productExternalId: '1', name, model: null, quantity: 2, options: [], total: display });
    expect(orderCardFromDirect(detail('processing', 'P', { items: [item('A'), item('B')], itemCount: 2 }), null)?.more).toBe(1);
    expect(orderCardFromDirect(detail('processing', 'P', { items: [item('A')], itemCount: 5, itemsTruncated: true }), null)?.more).toBe(4);
    expect(orderCardFromDirect(detail('processing', 'P', { items: [], itemCount: 3 }), null)).toMatchObject({ summary: null, more: 0 });
  });

  it('an unsafe tracking link is skipped for the next safe one', () => {
    const card = orderCardFromDirect(detail('processing'), shipments([
      { carrier: null, trackingNumber: null, trackingUrl: 'http://plain.example/1', status: null, updatedAt: null, source: 'x' },
      { carrier: null, trackingNumber: null, trackingUrl: 'https://safe.example/2', status: null, updatedAt: null, source: 'x' },
    ]));
    expect(card?.trackingUrl).toBe('https://safe.example/2');
  });

  it('never throws', () => {
    expect(orderCardFromDirect(null, null)).toBeNull();
    expect(orderCardFromDirect({ externalId: '1' } as never, { available: true, shipments: 'x' } as never)).toMatchObject({ number: '1', status: 'unknown' });
  });
});

describe('safeTrackingUrl', () => {
  it('accepts an absolute https URL', () => {
    expect(safeTrackingUrl('https://tracking.post.ir/?id=RR123')).toBe('https://tracking.post.ir/?id=RR123');
    expect(safeTrackingUrl('  https://x.example/a b ')).toBe('https://x.example/a%20b');
  });

  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'http://x.example/', '/track/1', 'track/1',
    '//x.example/1', 'https://user:pass@x.example/', 'vbscript:msgbox(1)', 'https://' + 'a'.repeat(500) + '.example/', '', 42, null,
  ])('rejects %s', (raw) => {
    expect(safeTrackingUrl(raw)).toBeNull();
  });
});

describe('arrivalDay', () => {
  it.each([
    ['2026-10-23', '2026-10-23'], ['2026-10-23T08:00:00+03:30', '2026-10-23'], ['2028-02-29', '2028-02-29'],
    ['2026-13-01', null], ['2026-00-10', null], ['20261023', null], ['tomorrow', null], [null, null],
  ])('%s → %s', (raw, day) => {
    expect(arrivalDay(raw)).toBe(day);
  });
});
