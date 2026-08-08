// ============================================
// VISITOR INTELLIGENCE SECTION
//
// Visibility & guidance layer for Geo Enrichment + Map Tiles providers.
// Does NOT duplicate provider configuration — it surfaces the active vendor
// for each, classifies it as self-hosted / cloud / built-in, indicates when
// the system is currently relying on the centroid fallback, and shows the
// recommended self-host vs simple combinations.
//
// The actual "Configure" buttons remain on the underlying AdminProviderCard
// instances rendered alongside this section.
// ============================================

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, Map as MapIcon, ShieldCheck, Cloud, Server, Power, AlertTriangle, CheckCircle2, ArrowRightLeft } from 'lucide-react';
import { getGlobalDefaultProvider } from '@/providers';
import { getVendorSchema } from './schemas';

type Deployment = 'selfhosted' | 'external' | 'builtin' | 'disabled' | 'unknown';

function deploymentBadge(d: Deployment) {
  switch (d) {
    case 'selfhosted':
      return (
        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] h-5">
          <Server className="h-3 w-3 me-1" /> Self-hosted
        </Badge>
      );
    case 'external':
      return (
        <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30 text-[10px] h-5">
          <Cloud className="h-3 w-3 me-1" /> Cloud / External
        </Badge>
      );
    case 'builtin':
      return (
        <Badge className="bg-muted text-muted-foreground border-border text-[10px] h-5">
          <ShieldCheck className="h-3 w-3 me-1" /> Built-in
        </Badge>
      );
    case 'disabled':
      return (
        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px] h-5">
          <Power className="h-3 w-3 me-1" /> Disabled
        </Badge>
      );
    default:
      return null;
  }
}

function StatusRow({
  icon: Icon,
  title,
  vendorName,
  vendorLabel,
  deployment,
  fallbackReason,
}: {
  icon: typeof MapPin;
  title: string;
  vendorName: string;
  vendorLabel: string;
  deployment: Deployment;
  fallbackReason?: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-md border border-border bg-muted/20">
      <div className="p-1.5 rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{title}</span>
          {deploymentBadge(deployment)}
        </div>
        <div className="mt-1 text-[12px] text-foreground truncate">
          <span className="text-muted-foreground">Active:</span>{' '}
          <span className="font-medium">{vendorLabel}</span>{' '}
          <span className="text-muted-foreground text-[10px]">({vendorName})</span>
        </div>
        {fallbackReason && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            {fallbackReason}
          </div>
        )}
      </div>
    </div>
  );
}

function ComboCard({
  title,
  geo,
  map,
  recommended,
}: {
  title: string;
  geo: string;
  map: string;
  recommended?: boolean;
}) {
  return (
    <div
      className={`p-3 rounded-md border ${
        recommended ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-muted/10'
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        {recommended && (
          <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] h-4">
            <CheckCircle2 className="h-3 w-3 me-1" /> Recommended
          </Badge>
        )}
      </div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center gap-1.5">
          <MapPin className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">Geo:</span>
          <span className="text-foreground font-medium">{geo}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <MapIcon className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">Tiles:</span>
          <span className="text-foreground font-medium">{map}</span>
        </div>
      </div>
    </div>
  );
}

export function VisitorIntelligenceSection() {
  const { data: geoCfg } = useQuery({
    queryKey: ['global-provider', 'geo_enrichment'],
    queryFn: () => getGlobalDefaultProvider('geo_enrichment'),
  });
  const { data: mapCfg } = useQuery({
    queryKey: ['global-provider', 'map_tiles'],
    queryFn: () => getGlobalDefaultProvider('map_tiles'),
  });

  // Geo: when nothing is set, system uses centroid fallback automatically.
  const geoVendorName = geoCfg?.provider_name ?? 'centroid';
  const geoSchema = getVendorSchema('geo_enrichment', geoVendorName);
  const geoDeployment: Deployment =
    (geoSchema?.deployment as Deployment) ??
    (geoVendorName === 'centroid' ? 'builtin' : 'unknown');
  const geoLabel = geoSchema?.label ?? geoVendorName;
  const geoFallback =
    geoVendorName === 'maxmind_local'
      ? 'MaxMind Local is platform infrastructure — its database path, reload and auto-update are owned by Super Admin → Map & Geo. Fields set here are ignored by the runtime.'
      : geoVendorName === 'centroid' || geoVendorName === 'none'
        ? 'Using centroid fallback — country-level precision only. Enable MaxMind Local in Super Admin → Map & Geo for city-level self-hosted accuracy.'
        : 'External provider — only consulted when MaxMind Local (Map & Geo) returns no result.';

  // Map tiles: default when unset is osm_public.
  const mapVendorName = mapCfg?.provider_name ?? 'osm_public';
  const mapSchema = getVendorSchema('map_tiles', mapVendorName);
  const mapDeployment: Deployment =
    (mapSchema?.deployment as Deployment) ??
    (mapVendorName === 'osm' || mapVendorName === 'osm_public' ? 'builtin' : 'unknown');
  const mapLabel = mapSchema?.label ?? mapVendorName;
  const mapFallback =
    mapVendorName === 'osm' || mapVendorName === 'osm_public'
      ? 'Using public OpenStreetMap tiles. For production self-host, configure TileServer GL or OpenMapTiles.'
      : mapVendorName === 'none'
        ? 'Map canvas disabled — visitors are listed without geographic display.'
        : undefined;

  // Detect a silent fallback caused by missing required config (e.g. tileserver
  // selected but `tile_url` not set). The map config endpoint enforces this at
  // request time; here we approximate it by checking for the presence of the
  // most-essential field in the stored config so admins see a warning *before*
  // visitors hit the map page.
  const mapMissing = (() => {
    if (!mapCfg) return null;
    const cfg = (mapCfg.config ?? {}) as Record<string, any>;
    if (mapVendorName === 'tileserver_selfhosted' || mapVendorName === 'openmaptiles_selfhosted' || mapVendorName === 'custom') {
      if (!cfg.tile_url) return 'tile_url';
    }
    if (mapVendorName === 'maptiler' && !cfg.api_key) return 'api_key';
    if (mapVendorName === 'mapbox' && !cfg.access_token) return 'access_token';
    return null;
  })();
  const mapEffectiveLabel = mapMissing
    ? `${mapLabel} → OpenStreetMap (public)`
    : mapLabel;
  const mapFallbackComputed = mapMissing
    ? `Configured provider "${mapLabel}" is missing required field "${mapMissing}" — silently falling back to public OSM tiles. Visitors page will show a "Fallback" badge.`
    : mapFallback;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm text-foreground flex items-center gap-2">
          <MapPin className="h-4 w-4 text-admin-accent" />
          Visitor Intelligence — Geo &amp; Map
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-1">
          Visibility layer for the Geo Enrichment + Map Tiles providers powering the Visitors module.
          Configuration lives in the cards below.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 md:grid-cols-2">
          <StatusRow
            icon={MapPin}
            title="Geo Enrichment"
            vendorName={geoVendorName}
            vendorLabel={geoLabel}
            deployment={geoDeployment}
            fallbackReason={geoFallback}
          />
          <StatusRow
            icon={MapIcon}
            title="Map Tiles"
            vendorName={mapVendorName}
            vendorLabel={mapEffectiveLabel}
            deployment={mapMissing ? 'builtin' : mapDeployment}
            fallbackReason={mapFallbackComputed}
          />
        </div>

        {mapMissing && (
          <div className="flex items-start gap-2 p-2.5 rounded-md border border-warning/30 bg-warning/5 text-[11px]">
            <ArrowRightLeft className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
            <div className="text-foreground">
              <strong className="text-warning">Silent fallback active.</strong>{' '}
              Configured: <code className="font-mono">{mapVendorName}</code>{' '}
              · Effective: <code className="font-mono">osm_public</code>{' '}
              · Reason: missing <code className="font-mono">{mapMissing}</code>.
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Recommended Combinations
          </h4>
          <div className="grid gap-2 md:grid-cols-3">
            <ComboCard
              title="Simple install"
              geo="Centroid (built-in)"
              map="OpenStreetMap (public)"
            />
            <ComboCard
              title="Production self-host"
              geo="MaxMind Local DB"
              map="TileServer GL / OpenMapTiles"
              recommended
            />
            <ComboCard
              title="Cloud / managed"
              geo="IPinfo or ipgeolocation"
              map="MapTiler / Mapbox"
            />
          </div>
        </div>

        <div className="text-[11px] text-muted-foreground border-t border-border pt-2 leading-relaxed">
          <strong className="text-foreground">Resolution order</strong> · workspace override → platform default → centroid fallback (geo) / OSM public (tiles) → explicit none.
          When a configured provider is missing required fields, the system silently falls back and surfaces a <strong>Fallback</strong> badge on the map and a warning here.
          Operators can re-enrich recent visitor sessions from the Visitors page header (admin role only).
        </div>
      </CardContent>
    </Card>
  );
}