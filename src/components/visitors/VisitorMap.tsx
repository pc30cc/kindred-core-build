/**
 * Visitor map canvas — Leaflet-based, provider-driven tile source.
 *
 * - `map_tiles` provider drives the tile URL/attribution.
 * - `leaflet.markercluster` groups nearby markers and shows the count.
 *   Clicking a cluster zooms in / spiderfies; clicking a single marker
 *   selects the visitor in the parent page.
 * - Falls back to a list-only "no-map" placeholder when the resolved
 *   provider is disabled.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { MapMarker, MapTilesConfig } from '@/lib/visitors-api';
import { Globe2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';
import { isolateBidi } from '@/lib/bidi';

interface Props {
  config: MapTilesConfig | undefined;
  markers: MapMarker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  online: 'hsl(142, 71%, 45%)',
  idle: 'hsl(38, 92%, 50%)',
  offline: 'hsl(215, 20%, 65%)',
  unknown: 'hsl(215, 20%, 65%)',
};

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  offline: 'Offline',
  unknown: 'Unknown',
};

/**
 * Build a richer Leaflet divIcon for a visitor marker.
 *
 * Why divIcon over circleMarker:
 *  - Lets us layer a CSS pulse halo for "online" without canvas tricks.
 *  - Keeps the inner dot crisp and gives us a real DOM node we can style
 *    with semantic tokens (selected ring, status colors).
 *
 * The HTML is intentionally tiny so the cluster plugin stays cheap even
 * with hundreds of markers — no images, no SVG, just two divs + box-shadow.
 */
function buildVisitorIcon(status: MapMarker['status'], selected: boolean): L.DivIcon {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
  const size = selected ? 18 : 14;
  const ring = selected
    ? `0 0 0 3px hsl(var(--primary) / 0.55), 0 0 12px ${color}`
    : `0 0 0 2px #fff, 0 0 8px ${color}aa`;
  // Two staggered rings + a soft glow give the "live signal" feel without
  // overwhelming the map. Idle uses a gentler single ring; offline is static.
  const rings = status === 'online'
    ? `<span class="vm-ring vm-ring-1" style="background:${color}"></span>
       <span class="vm-ring vm-ring-2" style="background:${color}"></span>
       <span class="vm-glow" style="background:radial-gradient(circle, ${color}66 0%, transparent 70%)"></span>`
    : status === 'idle'
      ? `<span class="vm-ring vm-ring-slow" style="background:${color}"></span>`
      : '';
  const core = status === 'online'
    ? `<span class="vm-core-online" style="background:${color}; box-shadow:${ring}"></span>`
    : `<span class="visitor-dot" style="background:${color}; box-shadow:${ring}; width:${size}px; height:${size}px"></span>`;
  const html = `
    <span class="visitor-marker-wrap" style="width:${size}px;height:${size}px">
      ${rings}
      ${core}
    </span>
  `;
  return L.divIcon({
    className: 'visitor-marker',
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [0, -size / 2 - 4],
  });
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

/** Compact, label-driven HTML tooltip with location + status + page. */
function buildTooltipHtml(m: MapMarker, locale: string): string {
  // Raw HTML string, not a React text node — bidi-isolate the localized
  // place name so it can't be visually reordered by whatever direction the
  // page/tooltip container happens to inherit (see src/lib/bidi.ts).
  const loc = isolateBidi(
    localizedLocationLabel(
      { city: m.city, country: m.country, country_code: m.country_code },
      locale,
    ) || 'Unknown location',
  );
  const statusColor = STATUS_COLORS[m.status] ?? STATUS_COLORS.unknown;
  const statusLabel = STATUS_LABEL[m.status] ?? 'Unknown';
  const page = shortPage(m.current_page);
  const flag = m.country_code
    ? `<span class="vm-flag">${m.country_code.toUpperCase()}</span>`
    : '';
  const when = relTime(m.last_activity_at);
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

export function VisitorMap({ config, markers, selectedId, onSelect }: Props) {
  const { t, locale } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  // Track existing markers by id so we can diff incrementally instead of
  // tearing down the whole cluster on every realtime patch / filter change.
  const markerIndex = useRef<Map<string, L.Marker>>(new Map());
  // Stable click handler ref so per-marker listeners don't need rebinding.
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  // Auto-fit guard: only frame to visitor bounds the first time we see a
  // non-empty marker set after init. Subsequent realtime patches must not
  // hijack the user's pan/zoom — operators should stay in control once
  // they've interacted with the map.
  const didAutoFitRef = useRef(false);
  const userInteractedRef = useRef(false);

  // Init / teardown
  useEffect(() => {
    if (!containerRef.current || !config?.enabled || !config.tile_url) return;
    if (mapRef.current) return;
    const center: [number, number] = [
      config.default_center?.lat ?? 20,
      config.default_center?.lng ?? 0,
    ];
    const zoom = config.default_center?.zoom ?? 1;
    const map = L.map(containerRef.current, {
      center,
      zoom,
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true, // Better perf with hundreds of markers.
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer(config.tile_url, {
      attribution: config.attribution,
      maxZoom: config.max_zoom,
      minZoom: Math.min(config.min_zoom, 1),
    }).addTo(map);

    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 8,
      maxClusterRadius: 48,
      chunkedLoading: true,
    });
    map.addLayer(cluster);
    clusterRef.current = cluster;
    mapRef.current = map;

    // Treat any manual zoom/drag as "user took control" — stop auto-fitting.
    const markInteracted = () => { userInteractedRef.current = true; };
    map.on('dragstart', markInteracted);
    map.on('zoomstart', (e: any) => {
      // Programmatic fitBounds also fires zoomstart; ignore those by checking
      // the originalEvent presence (only set for user-driven zooms).
      if (e?.originalEvent) markInteracted();
    });

    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
      markerIndex.current.clear();
      didAutoFitRef.current = false;
      userInteractedRef.current = false;
    };
  }, [
    config?.enabled, config?.tile_url, config?.attribution, config?.max_zoom, config?.min_zoom,
    config?.default_center?.lat, config?.default_center?.lng, config?.default_center?.zoom,
  ]);

  // Diff markers when data changes — add new, update existing, remove gone.
  // Avoids full clearLayers rebuilds (jank + memory churn at 200–500 markers).
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    const next = new Set<string>();
    const toAdd: L.Marker[] = [];

    for (const m of markers) {
      next.add(m.id);
      const isSelected = m.id === selectedId;
      const existing = markerIndex.current.get(m.id);
      if (existing) {
        // Patch in place: swap icon for status/selection changes, reposition
        // when realtime moves the visitor.
        existing.setIcon(buildVisitorIcon(m.status, isSelected));
        existing.setTooltipContent(buildTooltipHtml(m, locale));
        const ll = existing.getLatLng();
        if (ll.lat !== m.lat || ll.lng !== m.lng) existing.setLatLng([m.lat, m.lng]);
      } else {
        const marker = L.marker([m.lat, m.lng], {
          icon: buildVisitorIcon(m.status, isSelected),
          riseOnHover: true,
          keyboard: false,
        });
        const id = m.id;
        marker.on('click', () => onSelectRef.current?.(id));
        marker.bindTooltip(buildTooltipHtml(m, locale), {
          direction: 'top',
          offset: [0, -4],
          opacity: 1,
          className: 'vm-tooltip',
        });
        markerIndex.current.set(id, marker);
        toAdd.push(marker);
      }
    }

    // Remove markers that are no longer present.
    const toRemove: L.Marker[] = [];
    for (const [id, marker] of markerIndex.current) {
      if (!next.has(id)) {
        toRemove.push(marker);
        markerIndex.current.delete(id);
      }
    }
    if (toRemove.length) cluster.removeLayers(toRemove);
    if (toAdd.length) cluster.addLayers(toAdd);

    // Auto-fit to visible visitors the first time we have markers, so the
    // map always opens framed on the actual online crowd rather than the
    // generic country/world default. After this, the configured default
    // center is only used when there are zero markers.
    const map = mapRef.current;
    if (map && !didAutoFitRef.current && !userInteractedRef.current && markers.length > 0) {
      const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng] as [number, number]));
      if (bounds.isValid()) {
        // Cap maxZoom so a single-city cluster doesn't slam to street level.
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8, animate: false });
        didAutoFitRef.current = true;
      }
    }
  }, [markers, selectedId, t, locale]);

  // Compute a small status badge so operators can tell at a glance whether
  // the map is using their configured provider, a silent fallback, or is off.
  const statusBadge = (() => {
    if (!config) return null;
    if (config.health_status === 'fallback') {
      return {
        label: t('visitors.mapStatusFallback'),
        cls: 'bg-warning/15 text-warning border-warning/30',
        title: [
          t('visitors.mapFallbackPrefix', { provider: config.resolved_provider || config.provider }),
          config.fallback_reason ? t('visitors.mapFallbackReason', { reason: config.fallback_reason }) : '',
        ].filter(Boolean).join(' · '),
      };
    }
    return null; // 'healthy' / 'unconfigured' / 'disabled' don't need an inline badge.
  })();

  if (!config || !config.enabled || config.fallback_no_map) {
    return (
      <div className="relative h-full w-full overflow-hidden bg-muted/20">
        {/* Semantic grid placeholder — no external tile fetch. */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
          aria-hidden
        />
        <div className="relative h-full w-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
          <Globe2 className="w-10 h-10 mb-3 opacity-50" />
          <p className="text-sm font-medium text-foreground mb-1">{t('visitors.mapDisabledTitle')}</p>
          <p className="text-xs max-w-xs">{t('visitors.mapDisabledDesc')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" style={{ background: 'hsl(var(--muted))' }} />
      {statusBadge && (
        <div
          className={`absolute bottom-2 end-2 z-[400] inline-flex items-center gap-1 px-2 h-5 rounded-full text-[10px] border backdrop-blur ${statusBadge.cls}`}
          title={statusBadge.title}
          role="status"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />
          {statusBadge.label}
        </div>
      )}
    </div>
  );
}
