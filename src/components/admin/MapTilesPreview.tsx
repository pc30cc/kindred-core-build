/**
 * Live Leaflet preview for the Map & Geo "Tiles" tab.
 *
 * Reactively rebuilds when URL/attribution/zoom or center/zoom defaults
 * change so admins can verify their settings before saving them.
 * Renders a "not configured" placeholder when no tile URL is set.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Globe2 } from 'lucide-react';
import { useTranslation } from '@/i18n';

interface Props {
  tileUrl: string;
  attribution: string;
  minZoom: number;
  maxZoom: number;
  centerLat: number;
  centerLng: number;
  zoom: number;
  heightPx: number;
}

export function MapTilesPreview({
  tileUrl, attribution, minZoom, maxZoom, centerLat, centerLng, zoom, heightPx,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.TileLayer | null>(null);

  // Init once.
  useEffect(() => {
    if (!ref.current || mapRef.current || !tileUrl) return;
    const map = L.map(ref.current, {
      center: [centerLat || 0, centerLng || 0],
      zoom: zoom || 2,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    mapRef.current = map;
    layerRef.current = L.tileLayer(tileUrl, {
      attribution,
      minZoom: Math.max(0, minZoom || 0),
      maxZoom: maxZoom || 19,
    }).addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // Only re-init when the tile URL itself changes (cheaper than full rebuild).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileUrl]);

  // Patch attribution / zoom bounds without rebuilding.
  useEffect(() => {
    const map = mapRef.current; const layer = layerRef.current;
    if (!map || !layer) return;
    layer.options.attribution = attribution;
    map.attributionControl?.removeAttribution(layer.getAttribution() || '');
    if (attribution) map.attributionControl?.addAttribution(attribution);
    layer.options.minZoom = Math.max(0, minZoom || 0);
    layer.options.maxZoom = maxZoom || 19;
  }, [attribution, minZoom, maxZoom]);

  // Recenter when default center / zoom change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([centerLat || 0, centerLng || 0], zoom || 2, { animate: true });
  }, [centerLat, centerLng, zoom]);

  // Resize when height changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 50);
  }, [heightPx]);

  if (!tileUrl) {
    return (
      <div
        className="rounded-md border border-dashed border-border bg-muted/30 flex flex-col items-center justify-center text-muted-foreground p-6 text-center"
        style={{ height: `${heightPx}px` }}
      >
        <Globe2 className="w-8 h-8 opacity-40 mb-2" />
        <p className="text-sm font-medium text-foreground">{t('admin.mapGeo.preview.empty')}</p>
        <p className="text-xs">{t('admin.mapGeo.preview.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="rounded-md overflow-hidden border border-border"
      style={{ height: `${heightPx}px`, background: 'hsl(var(--muted))' }}
    />
  );
}
