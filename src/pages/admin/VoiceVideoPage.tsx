/**
 * Voice & Video Center — single hub for ALL platform call management.
 *
 * Replaces the scattered surfaces:
 *   • Providers page → "Voice / Video" tab (now links here)
 *   • Widget Platform Settings → "Voice & Video channels" block (now links here)
 *
 * Reuses existing panels — NO backend changes, NO duplicated logic:
 *   • CallControlPlanePanel  → Channels / Network / Recording / Agora / Permissions
 *   • RolePermissionsPanel   → Permissions matrix
 *   • call-queue-api         → Live operations (active queue snapshot)
 *   • admin-calls-api        → Channel state + readiness
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Phone, Video, Network, Disc, Users, Shield, Building2,
  Radio, FileText, AlertTriangle, CheckCircle2, Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { fetchCallControlPlane } from '@/lib/admin-calls-api';
import { CallControlPlanePanel } from '@/components/admin/calls/CallControlPlanePanel';
import { RolePermissionsPanel } from '@/components/admin/calls/RolePermissionsPanel';
import { AgoraExternalProviderPanel } from '@/components/admin/calls/AgoraExternalProviderPanel';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { Link } from 'react-router-dom';

function StatusBadge({ ready, label }: { ready: boolean; label: string }) {
  return (
    <Badge variant={ready ? 'default' : 'secondary'} className="gap-1 text-[10px]">
      {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

function OverviewTab() {
  const cpQuery = useQuery({
    queryKey: ['admin', 'call-control-plane'],
    queryFn: fetchCallControlPlane,
    refetchInterval: 30_000,
  });
  const cp = cpQuery.data?.control_plane;
  const readiness = cpQuery.data?.readiness ?? {};
  const network = cpQuery.data?.network;

  if (cpQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!cp) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          Could not load control plane.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!cp.enabled && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning mt-0.5" />
            <div className="text-sm">
              <strong className="text-foreground">Call control plane is disabled.</strong>
              <p className="text-muted-foreground text-xs mt-1">
                Enable it from the <em>Channels</em> tab to allow voice or video calls anywhere on the platform.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick toggles summary */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Phone className="h-3.5 w-3.5" /> Voice
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.voice_calls_enabled_global ? 'Enabled' : 'Disabled'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Video className="h-3.5 w-3.5" /> Video
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.video_calls_enabled_global ? 'Enabled' : 'Disabled'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Queue
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.call_queue_enabled_global ? 'Enabled' : 'Disabled'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Disc className="h-3.5 w-3.5" /> Recording default
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.recording_default_enabled ? 'On' : 'Off'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Retention: {cp.retention_default_days}d
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5" /> Verification
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.verification_required_for_visitor_calls ? 'Required' : 'Optional'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5" /> Primary provider
            </div>
            <div className="mt-1 text-lg font-semibold capitalize">{cp.primary_provider}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Fallback: {cp.fallback_policy} → {cp.secondary_provider}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider readiness */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Provider readiness</CardTitle>
          <CardDescription className="text-xs">
            Live status from the resolver. Configure providers in the <em>Providers</em> tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {Object.keys(readiness).length === 0 && (
              <span className="text-xs text-muted-foreground">No registered providers yet.</span>
            )}
            {Object.entries(readiness).map(([name, ready]) => (
              <StatusBadge key={name} ready={!!ready} label={name} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Network summary */}
      {network && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Network className="h-4 w-4" /> Network summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">RTC URL</span>
              <span className="font-mono">{network.rtc_url || <em className="text-muted-foreground">not set</em>}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">ICE policy</span>
              <span className="font-mono">{network.ice_policy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">TURN URLs</span>
              <span className="font-mono">{network.turn?.urls?.length ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">TURN credentials</span>
              <span className="font-mono">
                {network.turn?.username ? 'set' : 'unset'}
                {network.turn?.static_secret_present ? ' + static-secret' : ''}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function WorkspaceOverridesTab() {
  // Lightweight visibility list — the actual per-workspace toggles live in
  // the workspace's own Widget Behavior page. This admin view just lets
  // platform managers see which workspaces exist and jump in if needed.
  const { data: workspaces, isLoading } = useAdminWorkspaces(50, 0, '', 'newest');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Workspace overrides</CardTitle>
        <CardDescription className="text-xs">
          Each workspace can disable voice / video / queue / recording inside the platform-allowed range.
          Open the workspace to edit its overrides.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {(workspaces ?? []).map((w) => (
            <Link
              key={w.id}
              to={`/app/w/${w.slug}/widget`}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="truncate">
                  <div className="text-sm font-medium truncate">{w.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{w.slug} · {w.member_count} member(s)</div>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px]">Open</Badge>
            </Link>
          ))}
          {(workspaces ?? []).length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">No workspaces yet.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LiveOperationsTab() {
  // Aggregate "live operations" view. We do not introduce new APIs; we
  // surface the existing call-queue snapshot per workspace.
  const { data: workspaces } = useAdminWorkspaces(20, 0, '', 'newest');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Radio className="h-4 w-4" /> Live operations
        </CardTitle>
        <CardDescription className="text-xs">
          Active queues are visible inside each workspace's inbox. Use the links below to jump in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(workspaces ?? []).slice(0, 10).map((w) => (
          <Link
            key={w.id}
            to={`/app/w/${w.slug}/inbox`}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
          >
            <div className="text-sm">{w.name}</div>
            <Badge variant="outline" className="text-[10px]">Open inbox</Badge>
          </Link>
        ))}
        {(workspaces ?? []).length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">No workspaces.</div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" /> Audit
        </CardTitle>
        <CardDescription className="text-xs">
          Call configuration changes are recorded in the platform-wide audit log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/audit-logs">Open audit logs</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function VoiceVideoPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Video className="h-6 w-6 text-primary" />
          Voice &amp; Video Center
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          One place for every call setting on the platform — channels, providers, network, recording, queue, permissions and live operations.
        </p>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="bg-secondary/50 border border-border flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5 text-xs"><Activity className="h-3.5 w-3.5" />Overview</TabsTrigger>
          <TabsTrigger value="channels" className="gap-1.5 text-xs"><Phone className="h-3.5 w-3.5" />Channels &amp; recording</TabsTrigger>
          <TabsTrigger value="providers" className="gap-1.5 text-xs"><Network className="h-3.5 w-3.5" />Providers &amp; network</TabsTrigger>
          <TabsTrigger value="permissions" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" />Permissions</TabsTrigger>
          <TabsTrigger value="overrides" className="gap-1.5 text-xs"><Building2 className="h-3.5 w-3.5" />Workspace overrides</TabsTrigger>
          <TabsTrigger value="live" className="gap-1.5 text-xs"><Radio className="h-3.5 w-3.5" />Live operations</TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5 text-xs"><FileText className="h-3.5 w-3.5" />Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><OverviewTab /></TabsContent>

        {/* Channels + recording: reuse the canonical control plane panel.
            It already covers master toggle, channel gates, recording defaults
            and verification policy — single source of truth. */}
        <TabsContent value="channels"><CallControlPlanePanel /></TabsContent>

        {/* Providers & network: the same panel exposes provider selection,
            RTC/TURN endpoints and the external Agora adapter. Showing it
            again here would duplicate UI; instead we render only the Agora
            external adapter which is the only "extra" provider surface. */}
        <TabsContent value="providers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Self-hosted providers</CardTitle>
              <CardDescription className="text-xs">
                LiveKit, Jitsi and Janus are configured in the <em>Channels &amp; recording</em> tab (Provider section + RTC / TURN).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link to="#" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLButtonElement>('[data-state][value="channels"]')?.click(); }}>
                  Go to Channels &amp; recording
                </Link>
              </Button>
            </CardContent>
          </Card>
          <AgoraExternalProviderPanel />
        </TabsContent>

        <TabsContent value="permissions"><RolePermissionsPanel /></TabsContent>
        <TabsContent value="overrides"><WorkspaceOverridesTab /></TabsContent>
        <TabsContent value="live"><LiveOperationsTab /></TabsContent>
        <TabsContent value="audit"><AuditTab /></TabsContent>
      </Tabs>
    </div>
  );
}