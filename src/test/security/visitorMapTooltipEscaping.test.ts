/**
 * The visitor map tooltip is an HTML string Leaflet assigns via innerHTML.
 * Page URL, city/country and country code all come from the visitor, so a
 * crafted value must render as text, never as markup.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet.markercluster', () => ({}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.css', () => ({}));
vi.mock('leaflet.markercluster/dist/MarkerCluster.Default.css', () => ({}));

import { buildTooltipHtml } from '@/components/visitors/visitorMapTooltip';
import type { MapMarker } from '@/lib/visitors-api';

const XSS = '<img src=x onerror="alert(1)">';

function marker(over: Partial<MapMarker>): MapMarker {
  return {
    id: 'v1',
    lat: 35.7,
    lng: 51.4,
    status: 'online',
    city: 'Tehran',
    country: 'Iran',
    country_code: 'IR',
    current_page: 'https://shop.example/products',
    last_activity_at: new Date().toISOString(),
    source: 'ip',
    ...over,
  } as MapMarker;
}

function render(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('VisitorMap tooltip', () => {
  it('renders a normal marker unchanged', () => {
    const root = render(buildTooltipHtml(marker({}), 'en'));
    expect(root.querySelector('.vm-status-label')?.textContent).toBe('Online');
    expect(root.querySelector('.vm-flag')?.textContent).toBe('IR');
    expect(root.querySelector('.vm-page')?.textContent).toBe('shop.example/products');
    // Bidi isolation marks survive escaping.
    expect(root.querySelector('.vm-loc-text')?.textContent).toMatch(/^⁨.*⁩$/);
  });

  it('escapes visitor-controlled city, country, code and page', () => {
    const html = buildTooltipHtml(
      marker({
        city: XSS,
        country: XSS,
        country_code: `"><svg onload=alert(1)>` as unknown as string,
        current_page: `javascript:${XSS}`,
      }),
      'en',
    );
    const root = render(html);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('svg')).toBeNull();
    expect(root.querySelector('[onerror],[onload]')).toBeNull();
    expect(root.querySelector('.vm-loc-text')?.textContent).toContain(XSS);
  });

  it('takes status colour/label from the constant map only', () => {
    for (const status of ['constructor', '__proto__', 'x" onmouseover="alert(1)']) {
      const root = render(buildTooltipHtml(marker({ status: status as MapMarker['status'] }), 'en'));
      expect(root.querySelector('.vm-status-label')?.textContent).toBe('Unknown');
      expect(root.querySelector('[onmouseover]')).toBeNull();
      expect(root.querySelector('.vm-status-dot')?.getAttribute('style')).toBe('background:hsl(215, 20%, 55%)');
    }
  });
});
