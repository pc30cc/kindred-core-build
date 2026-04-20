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

export function VisitorMap({ config, markers, selectedId, onSelect }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);

  // Init / teardown
  useEffect(() => {
    if (!containerRef.current || !config?.enabled || !config.tile_url) return;
    if (mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true, // Better perf with hundreds of markers.
    });
    L.tileLayer(config.tile_url, {
      attribution: config.attribution,
      maxZoom: config.max_zoom,
      minZoom: config.min_zoom,
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

    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
  }, [config?.enabled, config?.tile_url, config?.attribution, config?.max_zoom, config?.min_zoom]);

  // Refresh markers when data changes
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    cluster.clearLayers();

    const layers: L.Layer[] = [];
    for (const m of markers) {
      const color = STATUS_COLORS[m.status] ?? STATUS_COLORS.unknown;
      const isSelected = m.id === selectedId;
      const marker = L.circleMarker([m.lat, m.lng], {
        radius: isSelected ? 9 : 6,
        weight: isSelected ? 3 : 2,
        color: '#fff',
        fillColor: color,
        fillOpacity: 0.85,
      });
      marker.on('click', () => onSelect(m.id));
      const label = [m.city, m.country].filter(Boolean).join(', ') || t('visitors.unknownLocation');
      marker.bindTooltip(label, { direction: 'top', offset: [0, -6] });
      layers.push(marker);
    }
    if (layers.length) cluster.addLayers(layers);
  }, [markers, selectedId, onSelect, t]);

  if (!config || !config.enabled || config.fallback_no_map) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-muted/30 text-muted-foreground p-8 text-center">
        <Globe2 className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-medium text-foreground mb-1">{t('visitors.mapDisabledTitle')}</p>
        <p className="text-xs max-w-xs">{t('visitors.mapDisabledDesc')}</p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" style={{ background: 'hsl(var(--muted))' }} />;
}
