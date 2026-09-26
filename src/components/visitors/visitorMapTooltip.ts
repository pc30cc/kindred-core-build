/**
 * Pure helpers for the visitor map: status colours and the tooltip HTML.
 * Kept out of VisitorMap.tsx so that file only exports components (fast refresh).
 */
import type { MapMarker } from '@/lib/visitors-api';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';
import { isolateBidi } from '@/lib/bidi';
export const STATUS_COLORS: Record<string, string> = {
  // Deliberately NOT green: map tiles are full of green landmass, so an
  // online visitor needs a hue that never occurs on the basemap.
  online: 'hsl(340, 85%, 52%)',
  idle: 'hsl(38, 92%, 50%)',
  offline: 'hsl(215, 20%, 55%)',
  unknown: 'hsl(215, 20%, 55%)',
};

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  offline: 'Offline',
  unknown: 'Unknown',
};

/**
 * Own-key lookup in a constant map. `status` arrives over the wire, so a
 * value like `constructor` or `__proto__` must not resolve to an inherited
 * property and end up interpolated into markup.
 */
export function lookup(map: Record<string, string>, key: string | null | undefined, fallback: string): string {
  return key != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

/**
 * Escape a value for HTML text content or a quoted attribute. Tooltip
 * content is handed to Leaflet as an HTML string (innerHTML), and every
 * dynamic field in it — page URL, city/country, country code — is
 * visitor-controlled.
 */
function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** Trim a URL/path for the tooltip — host + first path segment is enough. */
function shortPage(p: string | null | undefined): string {
  if (!p) return '';
  try {
    const u = new URL(p, 'http://x');
    const host = u.host && u.host !== 'x' ? u.host : '';
    const path = u.pathname.length > 28 ? u.pathname.slice(0, 28) + '…' : u.pathname;
    return host ? `${host}${path}` : path;
  } catch {
    return p.length > 32 ? p.slice(0, 32) + '…' : p;
  }
}

function relTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Compact, label-driven HTML tooltip with location + status + page.
 * Every dynamic value is HTML-escaped: the result is rendered as markup.
 */
export function buildTooltipHtml(m: MapMarker, locale: string): string {
  // Raw HTML string, not a React text node — bidi-isolate the localized
  // place name so it can't be visually reordered by whatever direction the
  // page/tooltip container happens to inherit (see src/lib/bidi.ts).
  // The isolate marks are plain Unicode control characters, so escaping the
  // wrapped string leaves them intact.
  const loc = escapeHtml(isolateBidi(
    localizedLocationLabel(
      { city: m.city, country: m.country, country_code: m.country_code },
      locale,
    ) || 'Unknown location',
  ));
  // Both come from the constant maps above, never from the payload.
  const statusColor = lookup(STATUS_COLORS, m.status, STATUS_COLORS.unknown);
  const statusLabel = escapeHtml(lookup(STATUS_LABEL, m.status, 'Unknown'));
  const page = escapeHtml(shortPage(m.current_page));
  const flag = m.country_code
    ? `<span class="vm-flag">${escapeHtml(String(m.country_code).toUpperCase())}</span>`
    : '';
  const when = escapeHtml(relTime(m.last_activity_at));
  return `
    <div class="vm-tip">
      <div class="vm-tip-row vm-tip-head">
        <span class="vm-status-dot" style="background:${statusColor}"></span>
        <span class="vm-status-label">${statusLabel}</span>
        ${when ? `<span class="vm-when">· ${when}</span>` : ''}
      </div>
      <div class="vm-tip-row vm-tip-loc">
        ${flag}<span class="vm-loc-text">${loc}</span>
      </div>
      ${page ? `<div class="vm-tip-row vm-page">${page}</div>` : ''}
      ${m.source === 'centroid'
        ? `<div class="vm-tip-row vm-approx">Approximate location</div>` : ''}
    </div>
  `;
}
