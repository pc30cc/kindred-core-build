import { useState, useCallback } from 'react';
import { Activity, CheckCircle, AlertTriangle, XCircle, RefreshCw, Search, BarChart3, Video, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProviderSummary, PROVIDER_TYPE_KEYS, providerRegistry, getFallbackLog, type ProviderTypeKey, type ProviderHealth } from '@/providers';
import { PROVIDER_SCHEMAS } from '@/features/providers/schemas';
import { AdminProviderCard } from '@/features/providers/AdminProviderCard';
import { AdminSmsProviderCard } from '@/features/providers/AdminSmsProviderCard';
import { AdminRealtimeCard } from '@/features/providers/AdminRealtimeCard';
import { PrivacyExportStorageCard } from '@/features/providers/PrivacyExportStorageCard';
import { VisitorIntelligenceSection } from '@/features/providers/VisitorIntelligenceSection';
import { Link } from 'react-router-dom';

// Phase 3: realtime is configured globally via the dedicated card.
function RenderProviderCard({ type }: { type: ProviderTypeKey }) {
  if (type === 'realtime') return <AdminRealtimeCard />;
  // SMS credentials are server-only — the generic card would read/write full
  // provider config from the browser, so SMS gets a dedicated card.
  if (type === 'sms') return <AdminSmsProviderCard />;
  if (type === 'storage') {
    return (
      <div className="space-y-4">
        <AdminProviderCard type={type} />
        <PrivacyExportStorageCard />
      </div>
    );
  }
  return <AdminProviderCard type={type} />;
}

export default function AdminProvidersPage() {
  const summary = useProviderSummary();
  const [searchQuery, setSearchQuery] = useState('');
  const [healthOverview, setHealthOverview] = useState<Record<string, Record<string, ProviderHealth>>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const fallbackLog = getFallbackLog();

  const configured = Object.entries(summary).filter(([, s]) => s.active !== null).length;
  const withEffective = Object.entries(summary).filter(([, s]) => s.effective !== null).length;
  const totalRegistered = Object.values(summary).reduce((sum, s) => sum + s.registered.length, 0);
  const totalVendors = PROVIDER_TYPE_KEYS.reduce((sum, type) => sum + (PROVIDER_SCHEMAS[type]?.vendors.length ?? 0), 0);

  const filteredTypes = PROVIDER_TYPE_KEYS.filter((type) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const schema = PROVIDER_SCHEMAS[type];
    return (
      type.includes(q) ||
      schema?.label.toLowerCase().includes(q) ||
      schema?.description.toLowerCase().includes(q) ||
      schema?.vendors.some(v => v.label.toLowerCase().includes(q) || v.name.includes(q))
    );
  });

  const checkAllProviders = useCallback(async () => {
    setCheckingAll(true);
    const results: Record<string, Record<string, ProviderHealth>> = {};
    await Promise.all(
      PROVIDER_TYPE_KEYS.map(async (type) => {
        results[type] = await providerRegistry.checkAllHealth(type);
      })
    );
    setHealthOverview(results);
    setCheckingAll(false);
  }, []);

  const healthCounts = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const typeHealth of Object.values(healthOverview)) {
    for (const h of Object.values(typeHealth)) {
      healthCounts[h]++;
    }
  }

  const coreTypes: ProviderTypeKey[] = ['auth', 'database', 'realtime'];
  const communicationTypes: ProviderTypeKey[] = ['email', 'sms', 'notification'];
  const infrastructureTypes: ProviderTypeKey[] = ['storage', 'cache', 'cdn', 'search'];
  const businessTypes: ProviderTypeKey[] = ['ai', 'billing', 'feature_flag', 'widget', 'captcha'];
  // Visitor Intelligence — visibility-only group. The actual provider cards
  // live in PROVIDER_TYPE_KEYS exactly once; this group simply re-references
  // them so admins can find geo + map config side-by-side.
  const visitorIntelTypes: ProviderTypeKey[] = (
    ['geo_enrichment', 'map_tiles'] as ProviderTypeKey[]
  ).filter((t) => (PROVIDER_TYPE_KEYS as readonly string[]).includes(t));

  const groups = [
    { label: 'Core Infrastructure', types: coreTypes },
    { label: 'Communication', types: communicationTypes },
    { label: 'Infrastructure & Storage', types: infrastructureTypes },
    { label: 'Business & Security', types: businessTypes },
    ...(visitorIntelTypes.length > 0
      ? [{ label: 'Visitor Intelligence', types: visitorIntelTypes }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Provider Control Center</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage platform-wide provider configurations, health monitoring, and fallback chains.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={checkAllProviders} disabled={checkingAll}
          className="border-border text-foreground hover:bg-muted">
          <RefreshCw className={`h-3.5 w-3.5 me-1 ${checkingAll ? 'animate-spin' : ''}`} />
          {checkingAll ? 'Checking...' : 'Check All Health'}
        </Button>
      </div>

      {/* Status Overview */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card className="bg-card border-border">
          <CardContent className="py-3 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{configured}/{PROVIDER_TYPE_KEYS.length}</p>
              <p className="text-[10px] text-muted-foreground">Explicitly Configured</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="py-3 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <CheckCircle className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{withEffective}</p>
              <p className="text-[10px] text-muted-foreground">With Active Provider</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="py-3 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{totalRegistered}</p>
              <p className="text-[10px] text-muted-foreground">Total Registered</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="py-3 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted">
              <Search className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{totalVendors}</p>
              <p className="text-[10px] text-muted-foreground">Available Vendors</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Health overview bar */}
      {Object.keys(healthOverview).length > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="py-3">
            <div className="flex items-center gap-4">
              <span className="text-xs font-medium text-muted-foreground">Health Summary:</span>
              <div className="flex items-center gap-3">
                {healthCounts.healthy > 0 && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle className="h-3 w-3" /> {healthCounts.healthy} healthy
                  </span>
                )}
                {healthCounts.degraded > 0 && (
                  <span className="flex items-center gap-1 text-xs text-amber-400">
                    <AlertTriangle className="h-3 w-3" /> {healthCounts.degraded} degraded
                  </span>
                )}
                {healthCounts.down > 0 && (
                  <span className="flex items-center gap-1 text-xs text-red-400">
                    <XCircle className="h-3 w-3" /> {healthCounts.down} down
                  </span>
                )}
                {healthCounts.unknown > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {healthCounts.unknown} unknown
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="grouped" className="space-y-4">
        <div className="flex items-center justify-between">
          <TabsList className="bg-muted">
            <TabsTrigger value="grouped" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">By Category</TabsTrigger>
            <TabsTrigger value="all" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">All Providers</TabsTrigger>
            <TabsTrigger value="calls" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">
              <Video className="h-3.5 w-3.5 me-1" /> Voice / Video
            </TabsTrigger>
            {fallbackLog.length > 0 && (
              <TabsTrigger value="fallback" className="data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground text-muted-foreground">Fallback Log ({fallbackLog.length})</TabsTrigger>
            )}
          </TabsList>

          <div className="relative w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search providers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-xs pl-8 bg-input border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Grouped view */}
        <TabsContent value="grouped" className="space-y-6">
          {groups.map((group) => {
            const types = group.types.filter(t => filteredTypes.includes(t));
            if (types.length === 0) return null;
            return (
              <div key={group.label} className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {group.label}
                </h3>
                {group.label === 'Visitor Intelligence' && (
                  <VisitorIntelligenceSection />
                )}
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {types.map((type) => (
                    <RenderProviderCard key={type} type={type} />
                  ))}
                </div>
              </div>
            );
          })}
        </TabsContent>

        {/* All providers grid */}
        <TabsContent value="all">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredTypes.map((type) => (
              <RenderProviderCard key={type} type={type} />
            ))}
          </div>
        </TabsContent>

        {/* Voice / Video control plane */}
        <TabsContent value="calls">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Video className="h-4 w-4 text-primary" /> Voice &amp; Video moved
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                All call settings — channel gates, providers, network / TURN, recording, queue and permissions —
                are now centralized in the dedicated <strong>Voice &amp; Video Center</strong>.
              </p>
              <Button asChild size="sm">
                <Link to="/admin/voice-video" className="gap-1.5">
                  Open Voice &amp; Video Center <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Fallback log */}
        {fallbackLog.length > 0 && (
          <TabsContent value="fallback">
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-foreground">Provider Fallback Events</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {fallbackLog.slice().reverse().map((entry, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-md border border-border text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[9px]">{entry.type}</Badge>
                        <span className="text-red-400 line-through">{entry.failedProvider}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-foreground font-medium">{entry.fallbackProvider}</span>
                      </div>
                      <span className="text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
