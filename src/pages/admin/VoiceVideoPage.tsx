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
  Activity,
  Phone,
  Video,
  Network,
  Disc,
  Users,
  Shield,
  Building2,
  Radio,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  GitBranch,
  Timer,
  Voicemail,
  CalendarClock,
  Archive,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { fetchCallControlPlane, fetchPlatformCallbackSummary, fetchUpcomingCallbacks } from '@/lib/admin-calls-api';
import { CallControlPlanePanel } from '@/components/admin/calls/CallControlPlanePanel';
import { RolePermissionsPanel } from '@/components/admin/calls/RolePermissionsPanel';
import { AgoraExternalProviderPanel } from '@/components/admin/calls/AgoraExternalProviderPanel';
import { LiveKitSelfHostedProviderPanel } from '@/components/admin/calls/LiveKitSelfHostedProviderPanel';
import { RecordingRetentionPanel } from '@/components/admin/calls/RecordingRetentionPanel';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { Link } from 'react-router-dom';
import { callbacksApi, type CallbackRow } from '@/lib/callbacks-api';
import { useTranslation } from '@/i18n';

function StatusBadge({ ready, label }: { ready: boolean; label: string }) {
  return (
    <Badge variant={ready ? 'default' : 'secondary'} className="gap-1 text-[10px]">
      {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

function OverviewTab() {
  const { t } = useTranslation();
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
        <CardContent className="py-6 text-sm text-destructive">{t('admin.voiceVideo.loadFailed' as any)}</CardContent>
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
              <strong className="text-foreground">{t('admin.voiceVideo.overview.disabledTitle' as any)}</strong>
              <p className="text-muted-foreground text-xs mt-1">{t('admin.voiceVideo.overview.disabledHint' as any)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick toggles summary */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Phone className="h-3.5 w-3.5" /> {t('admin.voiceVideo.voice' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.voice_calls_enabled_global
                ? t('admin.voiceVideo.enabled' as any)
                : t('admin.voiceVideo.disabled' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Video className="h-3.5 w-3.5" /> {t('admin.voiceVideo.video' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.video_calls_enabled_global
                ? t('admin.voiceVideo.enabled' as any)
                : t('admin.voiceVideo.disabled' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> {t('admin.voiceVideo.queue' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.call_queue_enabled_global
                ? t('admin.voiceVideo.enabled' as any)
                : t('admin.voiceVideo.disabled' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Disc className="h-3.5 w-3.5" /> {t('admin.voiceVideo.overview.recordingDefault' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.recording_default_enabled ? t('admin.voiceVideo.on' as any) : t('admin.voiceVideo.off' as any)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('admin.voiceVideo.overview.retentionDays' as any, { count: cp.retention_default_days })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Shield className="h-3.5 w-3.5" /> {t('admin.voiceVideo.verification' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold">
              {cp.verification_required_for_visitor_calls
                ? t('admin.voiceVideo.required' as any)
                : t('admin.voiceVideo.optional' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5" /> {t('admin.voiceVideo.overview.primaryProvider' as any)}
            </div>
            <div className="mt-1 text-lg font-semibold capitalize">{cp.primary_provider}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('admin.voiceVideo.overview.fallback' as any)}: {cp.fallback_policy} → {cp.secondary_provider}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider readiness */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('admin.voiceVideo.overview.providerReadiness' as any)}</CardTitle>
          <CardDescription className="text-xs">
            {t('admin.voiceVideo.overview.providerReadinessHint' as any)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {Object.keys(readiness).length === 0 && (
              <span className="text-xs text-muted-foreground">{t('admin.voiceVideo.overview.noProviders' as any)}</span>
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
              <Network className="h-4 w-4" /> {t('admin.voiceVideo.overview.networkSummary' as any)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">RTC URL</span>
              <span className="font-mono">
                {network.rtc_url || <em className="text-muted-foreground">{t('admin.voiceVideo.notSet' as any)}</em>}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('admin.voiceVideo.overview.icePolicy' as any)}</span>
              <span className="font-mono">{network.ice_policy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">TURN URLs</span>
              <span className="font-mono">{network.turn?.urls?.length ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('admin.voiceVideo.overview.turnCredentials' as any)}</span>
              <span className="font-mono">
                {network.turn?.username ? t('admin.voiceVideo.set' as any) : t('admin.voiceVideo.unset' as any)}
                {network.turn?.static_secret_present ? ` + ${t('admin.voiceVideo.overview.staticSecret' as any)}` : ''}
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function WorkspaceOverridesTab() {
  const { t } = useTranslation();
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
        <CardTitle className="text-sm">{t('admin.voiceVideo.overrides.title' as any)}</CardTitle>
        <CardDescription className="text-xs">{t('admin.voiceVideo.overrides.description' as any)}</CardDescription>
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
                  <div className="text-[10px] text-muted-foreground truncate">
                    {w.slug} · {t('admin.voiceVideo.overrides.members' as any, { count: w.member_count })}
                  </div>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px]">
                {t('admin.voiceVideo.open' as any)}
              </Badge>
            </Link>
          ))}
          {(workspaces ?? []).length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-6">
              {t('admin.voiceVideo.noWorkspaces' as any)}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LiveOperationsTab() {
  const { t } = useTranslation();
  // Aggregate "live operations" view. We do not introduce new APIs; we
  // surface the existing call-queue snapshot per workspace.
  const { data: workspaces } = useAdminWorkspaces(20, 0, '', 'newest');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Radio className="h-4 w-4" /> {t('admin.voiceVideo.live.title' as any)}
        </CardTitle>
        <CardDescription className="text-xs">{t('admin.voiceVideo.live.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {(workspaces ?? []).slice(0, 10).map((w) => (
          <Link
            key={w.id}
            to={`/app/w/${w.slug}/inbox`}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
          >
            <div className="text-sm">{w.name}</div>
            <Badge variant="outline" className="text-[10px]">
              {t('admin.voiceVideo.live.openInbox' as any)}
            </Badge>
          </Link>
        ))}
        {(workspaces ?? []).length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-6">
            {t('admin.voiceVideo.noWorkspaces' as any)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditTab() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <FileText className="h-4 w-4" /> {t('admin.voiceVideo.audit.title' as any)}
        </CardTitle>
        <CardDescription className="text-xs">{t('admin.voiceVideo.audit.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/audit-logs">{t('admin.voiceVideo.audit.openLogs' as any)}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function RoutingTab() {
  const { t } = useTranslation();
  const cpQuery = useQuery({
    queryKey: ['admin', 'call-control-plane'],
    queryFn: fetchCallControlPlane,
    refetchInterval: 60_000,
  });
  const cp = cpQuery.data?.control_plane;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <GitBranch className="h-4 w-4" /> {t('admin.voiceVideo.routing.title' as any)}
        </CardTitle>
        <CardDescription className="text-xs">{t('admin.voiceVideo.routing.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="rounded-md border border-border p-3 space-y-1">
          <div className="font-semibold text-foreground">{t('admin.voiceVideo.routing.eligibility' as any)}</div>
          <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
            <li>{t('admin.voiceVideo.routing.memberRule' as any)}</li>
            <li>
              {t('admin.voiceVideo.routing.audioRule' as any)} → <code>can_receive_audio_call</code>
            </li>
            <li>
              {t('admin.voiceVideo.routing.videoRule' as any)} → <code>can_receive_video_call</code>
            </li>
            <li>
              {t('admin.voiceVideo.routing.queueRule' as any)} → <code>can_join_queue_calls</code>
            </li>
            <li>
              {t('admin.voiceVideo.routing.notInCall' as any)} (<code>in_call=false</code>)
            </li>
            <li>{t('admin.voiceVideo.routing.readinessRule' as any)}</li>
          </ul>
        </div>
        <div className="rounded-md border border-border p-3 space-y-1">
          <div className="font-semibold text-foreground">{t('admin.voiceVideo.routing.decisionOrder' as any)}</div>
          <ol className="list-decimal list-inside text-muted-foreground space-y-0.5">
            <li>{t('admin.voiceVideo.routing.direct' as any)}</li>
            <li>{t('admin.voiceVideo.routing.enqueue' as any)}</li>
            <li>{t('admin.voiceVideo.routing.callback' as any)}</li>
            <li>{t('admin.voiceVideo.routing.unavailable' as any)}</li>
          </ol>
        </div>
        {cp && (
          <div className="rounded-md border border-border p-3 grid grid-cols-2 gap-2">
            <div>
              {t('admin.voiceVideo.routing.queueGlobal' as any)}:{' '}
              <strong>
                {cp.call_queue_enabled_global ? t('admin.voiceVideo.yes' as any) : t('admin.voiceVideo.no' as any)}
              </strong>
            </div>
            <div>
              {t('admin.voiceVideo.routing.voiceEnabled' as any)}:{' '}
              <strong>
                {cp.voice_calls_enabled_global ? t('admin.voiceVideo.yes' as any) : t('admin.voiceVideo.no' as any)}
              </strong>
            </div>
            <div>
              {t('admin.voiceVideo.routing.videoEnabled' as any)}:{' '}
              <strong>
                {cp.video_calls_enabled_global ? t('admin.voiceVideo.yes' as any) : t('admin.voiceVideo.no' as any)}
              </strong>
            </div>
            <div>
              {t('admin.voiceVideo.verification' as any)}:{' '}
              <strong>
                {cp.verification_required_for_visitor_calls
                  ? t('admin.voiceVideo.required' as any)
                  : t('admin.voiceVideo.optional' as any)}
              </strong>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QueueSlaTab() {
  const { t, locale } = useTranslation();
  const cpQuery = useQuery({
    queryKey: ['admin', 'call-control-plane'],
    queryFn: fetchCallControlPlane,
    refetchInterval: 60_000,
  });
  const cp = cpQuery.data?.control_plane as any;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Timer className="h-4 w-4" /> {t('admin.voiceVideo.queueSla.title' as any)}
        </CardTitle>
        <CardDescription className="text-xs">{t('admin.voiceVideo.queueSla.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        {!cp ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">{t('admin.voiceVideo.queueSla.offerTimeout' as any)}</div>
              <div className="text-lg font-semibold mt-1">
                {(cp.queue_offer_timeout_seconds ?? 25).toLocaleString(locale)} {t('admin.voiceVideo.seconds' as any)}
              </div>
              <div className="text-[10px] text-muted-foreground">{t('admin.voiceVideo.queueSla.offerHint' as any)}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">{t('admin.voiceVideo.queueSla.maxWait' as any)}</div>
              <div className="text-lg font-semibold mt-1">
                {(cp.queue_max_wait_seconds ?? 180).toLocaleString(locale)} {t('admin.voiceVideo.seconds' as any)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {t('admin.voiceVideo.queueSla.maxWaitHint' as any)}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">{t('admin.voiceVideo.queueSla.autoExpire' as any)}</div>
              <div className="text-lg font-semibold mt-1">
                {(cp.auto_expire_queue_after_seconds ?? 600).toLocaleString(locale)}{' '}
                {t('admin.voiceVideo.seconds' as any)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {t('admin.voiceVideo.queueSla.autoExpireHint' as any)}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">{t('admin.voiceVideo.queueSla.callbackFallback' as any)}</div>
              <div className="text-lg font-semibold mt-1">
                {cp.callback_offer_after_timeout
                  ? t('admin.voiceVideo.enabled' as any)
                  : t('admin.voiceVideo.disabled' as any)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {t('admin.voiceVideo.queueSla.callbackHint' as any)}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CallbacksTab() {
  const { t, locale } = useTranslation();
  const { data: workspaces } = useAdminWorkspaces(50, 0, '', 'newest');
  const [counts, setCounts] = useState<Record<string, { open: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const summaryQuery = useQuery({
    queryKey: ['admin', 'callbacks-summary'],
    queryFn: fetchPlatformCallbackSummary,
    refetchInterval: 30_000,
  });
  const summary = summaryQuery.data;
  const completionPct = summary ? Math.round((summary.completion_rate || 0) * 100) : 0;
  const upcomingQuery = useQuery({
    queryKey: ['admin', 'callbacks-upcoming'],
    queryFn: fetchUpcomingCallbacks,
    refetchInterval: 60_000,
  });
  const upcoming = upcomingQuery.data?.items ?? [];
  const scheduledCount = upcomingQuery.data?.scheduled_count ?? 0;

  useEffect(() => {
    if (!workspaces) return;
    let cancelled = false;
    void (async () => {
      const out: Record<string, { open: number; total: number }> = {};
      for (const w of workspaces.slice(0, 25)) {
        try {
          const c = await callbacksApi.getCounts(w.id);
          if (cancelled) return;
          out[w.id] = {
            open: (c.requested ?? 0) + (c.scheduled ?? 0) + (c.in_progress ?? 0),
            total:
              (c.requested ?? 0) + (c.scheduled ?? 0) + (c.in_progress ?? 0) + (c.completed ?? 0) + (c.cancelled ?? 0),
          };
        } catch {
          /* skip */
        }
      }
      if (!cancelled) {
        setCounts(out);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  return (
    <div className="space-y-4">
      {/* Phase 8D+ — Platform-wide summary cards */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Voicemail className="h-3.5 w-3.5" /> {t('admin.voiceVideo.callbacks.open' as any)}
            </div>
            <div className="mt-1 text-2xl font-semibold">{summary?.open ?? '—'}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('admin.voiceVideo.callbacks.acrossWorkspaces' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" /> {t('admin.voiceVideo.callbacks.completed' as any)}
            </div>
            <div className="mt-1 text-2xl font-semibold">{summary?.counts?.completed ?? '—'}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('admin.voiceVideo.callbacks.last30Days' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" /> {t('admin.voiceVideo.callbacks.cancelled' as any)}
            </div>
            <div className="mt-1 text-2xl font-semibold">{summary?.counts?.cancelled ?? '—'}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t('admin.voiceVideo.callbacks.last30Days' as any)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Activity className="h-3.5 w-3.5" /> {t('admin.voiceVideo.callbacks.completionRate' as any)}
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {summary && summary.total > 0 ? `${completionPct}%` : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {summary
                ? t('admin.voiceVideo.callbacks.total' as any, { count: summary.total })
                : t('admin.voiceVideo.callbacks.last30Days' as any)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Phase 8E — Scheduled / upcoming callbacks (visitor-chosen times). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-info" />
            {t('admin.voiceVideo.callbacks.upcoming' as any)}
            <Badge variant="secondary" className="ms-auto text-[10px]">
              {scheduledCount.toLocaleString(locale)}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">{t('admin.voiceVideo.callbacks.upcomingHint' as any)}</CardDescription>
        </CardHeader>
        <CardContent>
          {upcomingQuery.isLoading ? (
            <div className="flex items-center justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : upcoming.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('admin.voiceVideo.callbacks.noUpcoming' as any)}
            </div>
          ) : (
            <div className="space-y-1">
              {upcoming.slice(0, 10).map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{new Date(u.scheduled_for).toLocaleString(locale)}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {u.channel} ·{' '}
                        {u.contact_phone || u.contact_email || t('admin.voiceVideo.callbacks.noContact' as any)}
                      </div>
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {t(`admin.voiceVideo.callbacks.status.${u.status}` as any)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Voicemail className="h-4 w-4" /> {t('admin.voiceVideo.callbacks.requests' as any)}
          </CardTitle>
          <CardDescription className="text-xs">{t('admin.voiceVideo.callbacks.requestsHint' as any)}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <div className="space-y-1">
              {(workspaces ?? []).slice(0, 25).map((w) => {
                const c = counts[w.id];
                return (
                  <Link
                    key={w.id}
                    to={`/app/w/${w.slug}/inbox`}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <div className="text-sm truncate">{w.name}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={c && c.open > 0 ? 'default' : 'secondary'} className="text-[10px]">
                        {c ? t('admin.voiceVideo.callbacks.openCount' as any, { count: c.open }) : '—'}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {c ? t('admin.voiceVideo.callbacks.total30' as any, { count: c.total }) : '—'}
                      </Badge>
                    </div>
                  </Link>
                );
              })}
              {(workspaces ?? []).length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-6">
                  {t('admin.voiceVideo.noWorkspaces' as any)}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function VoiceVideoPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Video className="h-6 w-6 text-primary" />
          {t('admin.voiceVideo.title' as any)}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('admin.voiceVideo.subtitle' as any)}</p>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="bg-secondary/50 border border-border flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5 text-xs">
            <Activity className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.overview' as any)}
          </TabsTrigger>
          <TabsTrigger value="channels" className="gap-1.5 text-xs">
            <Phone className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.channels' as any)}
          </TabsTrigger>
          <TabsTrigger value="providers" className="gap-1.5 text-xs">
            <Network className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.providers' as any)}
          </TabsTrigger>
          <TabsTrigger value="routing" className="gap-1.5 text-xs">
            <GitBranch className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.routing' as any)}
          </TabsTrigger>
          <TabsTrigger value="queue-sla" className="gap-1.5 text-xs">
            <Timer className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.queueSla' as any)}
          </TabsTrigger>
          <TabsTrigger value="callbacks" className="gap-1.5 text-xs">
            <Voicemail className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.callbacks' as any)}
          </TabsTrigger>
          <TabsTrigger value="permissions" className="gap-1.5 text-xs">
            <Shield className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.permissions' as any)}
          </TabsTrigger>
          <TabsTrigger value="overrides" className="gap-1.5 text-xs">
            <Building2 className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.overrides' as any)}
          </TabsTrigger>
          <TabsTrigger value="recordings" className="gap-1.5 text-xs">
            <Archive className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.recordings' as any)}
          </TabsTrigger>
          <TabsTrigger value="live" className="gap-1.5 text-xs">
            <Radio className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.live' as any)}
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5 text-xs">
            <FileText className="h-3.5 w-3.5" />
            {t('admin.voiceVideo.tabs.audit' as any)}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>

        {/* Channels + recording: reuse the canonical control plane panel.
            It already covers master toggle, channel gates, recording defaults
            and verification policy — single source of truth. */}
        <TabsContent value="channels">
          <CallControlPlanePanel />
        </TabsContent>

        {/* Providers & network: the same panel exposes provider selection,
            RTC/TURN endpoints and the external Agora adapter. Showing it
            again here would duplicate UI; instead we render only the Agora
            external adapter which is the only "extra" provider surface. */}
        <TabsContent value="providers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('admin.voiceVideo.providers.title' as any)}</CardTitle>
              <CardDescription className="text-xs">
                {t('admin.voiceVideo.providers.description' as any)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link
                  to="#"
                  onClick={(e) => {
                    e.preventDefault();
                    document.querySelector<HTMLButtonElement>('[data-state][value="channels"]')?.click();
                  }}
                >
                  {t('admin.voiceVideo.providers.openNetwork' as any)}
                </Link>
              </Button>
            </CardContent>
          </Card>
          <LiveKitSelfHostedProviderPanel />
          <AgoraExternalProviderPanel />
        </TabsContent>

        <TabsContent value="permissions">
          <RolePermissionsPanel />
        </TabsContent>
        <TabsContent value="overrides">
          <WorkspaceOverridesTab />
        </TabsContent>
        <TabsContent value="recordings">
          <RecordingRetentionPanel />
        </TabsContent>
        <TabsContent value="live">
          <LiveOperationsTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="routing">
          <RoutingTab />
        </TabsContent>
        <TabsContent value="queue-sla">
          <QueueSlaTab />
        </TabsContent>
        <TabsContent value="callbacks">
          <CallbacksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
