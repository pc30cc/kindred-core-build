/**
 * Visitor map canvas — Leaflet-based, provider-driven tile source.
 * Falls back to a list-only "no-map" placeholder when the resolved
 * map_tiles provider is disabled.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapMarker, MapTilesConfig } from '@/lib/visitors-api';
import { Globe2 } from 'lucide-react';

interface Props {
  config: MapTilesConfig | undefined;
  markers: MapMarker[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function VisitorMap({ config, markers, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

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
    });
    L.tileLayer(config.tile_url, {
      attribution: config.attribution,
      maxZoom: config.max_zoom,
      minZoom: config.min_zoom,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [config?.enabled, config?.tile_url, config?.attribution, config?.max_zoom, config?.min_zoom]);

  // Refresh markers when data changes
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markers.forEach(m => {
      const color =
        m.status === 'online' ? 'hsl(142, 71%, 45%)' :
        m.status === 'idle'   ? 'hsl(38, 92%, 50%)'  :
                                'hsl(215, 20%, 65%)';
      const isSelected = m.id === selectedId;
      const marker = L.circleMarker([m.lat, m.lng], {
        radius: isSelected ? 9 : 6,
        weight: isSelected ? 3 : 2,
        color: '#fff',
        fillColor: color,
        fillOpacity: 0.85,
      });
      marker.on('click', () => onSelect(m.id));
      const label = [m.city, m.country].filter(Boolean).join(', ') || 'Unknown';
      marker.bindTooltip(label, { direction: 'top', offset: [0, -6] });
      marker.addTo(layer);
    });
  }, [markers, selectedId, onSelect]);

  if (!config || !config.enabled || config.fallback_no_map) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-muted/30 text-muted-foreground p-8 text-center">
        <Globe2 className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-medium text-foreground mb-1">Map disabled</p>
        <p className="text-xs max-w-xs">
          No map_tiles provider is configured. Visitors are still listed on the left.
          Configure a map provider in Admin → Providers.
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" style={{ background: 'hsl(var(--muted))' }} />;
}