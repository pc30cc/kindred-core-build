/**
 * Super Admin → Advanced Routing.
 *
 * Workspace owners no longer see fallback policy or routing diagnostics in
 * their normal Team & Departments view — those concerns are too low-level
 * for day-to-day operations. They live here so the platform owner can
 * inspect or tune routing behavior across workspaces.
 *
 * Backend stays per-workspace (workspace_provider_settings keyed by
 * department_routing) — this page reuses the existing
 * /api/workspace-departments/:wsId endpoints. Super admins must be a
 * member of the target workspace to mutate (the route enforces this).
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Activity, Building2, CheckCircle2, AlertCircle, Loader2,
  Info, ShieldAlert,
} from 'lucide-react';

import { useAdminWorkspaces } from '@/hooks/useAdmin';
import {
  getFallbackPolicy, updateFallbackPolicy, getDepartmentDiagnostics,
  type DepartmentChannel, type FallbackPolicy,
} from '@/lib/workspace-departments-api';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function AdminAdvancedRoutingPage() {
  const { data: workspaces = [], isLoading: loadingWs } = useAdminWorkspaces(200, 0, '', 'newest');
  const [wsId, setWsId] = useState<string>('');
  const [channel, setChannel] = useState<DepartmentChannel>('chat');
  const qc = useQueryClient();

  const sortedWs = useMemo(
    () => [...workspaces].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [workspaces],
  );

  const { data: fallback, isLoading: loadingFallback, error: fallbackError } = useQuery({
    queryKey: ['admin-advrouting-fallback', wsId],
    queryFn: () => getFallbackPolicy(wsId),
    enabled: !!wsId,
    retry: false,
  });

  const { data: diagnostics, isLoading: loadingDiag } = useQuery({
    queryKey: ['admin-advrouting-diag', wsId, channel],
    queryFn: () => getDepartmentDiagnostics(wsId, channel),
    enabled: !!wsId,
    refetchInterval: wsId ? 20_000 : false,
    retry: false,
  });

  const updateFallback = useMutation({
    mutationFn: (patch: Partial<FallbackPolicy>) => updateFallbackPolicy(wsId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-advrouting-fallback', wsId] });
      qc.invalidateQueries({ queryKey: ['admin-advrouting-diag', wsId] });
      toast.success('Fallback policy updated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const accessDenied =
    fallbackError instanceof Error && /workspace_admin_required|403/i.test(fallbackError.message);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="h-6 w-6" /> Advanced Routing
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Platform-level routing controls. These were intentionally removed
          from the workspace owner UI — workspace owners only manage
          departments and team members. Use this page to inspect or tune
          fallback behavior and diagnostics for any workspace.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Workspace
          </CardTitle>
          <CardDescription>
            Pick the workspace whose routing you want to inspect.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingWs ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Select value={wsId} onValueChange={setWsId}>
              <SelectTrigger className="max-w-md">
                <SelectValue placeholder="Select a workspace…" />
              </SelectTrigger>
              <SelectContent>
                {sortedWs.map((w: any) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name || w.slug || w.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {wsId && accessDenied && (
        <Card className="border-destructive/40">
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <ShieldAlert className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-foreground">
                You are not a member of this workspace.
              </p>
              <p className="text-muted-foreground mt-1">
                The departments API enforces workspace membership for both reads and writes.
                To inspect or tune this workspace's routing, add yourself as a member from{' '}
                <a href="/admin/workspaces" className="text-primary hover:underline">
                  Workspaces
                </a>
                .
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {wsId && !accessDenied && (
        <>
          {/* Fallback policy */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fallback policy</CardTitle>
              <CardDescription>
                Order tried when no eligible department member is available:
                General Pool → Owner → Queue → Callback → Offline.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {loadingFallback || !fallback ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <ToggleRow
                    label="Enable owner fallback"
                    checked={fallback.owner_fallback_enabled}
                    onChange={(v) => updateFallback.mutate({ owner_fallback_enabled: v })}
                  />
                  <div className="ms-6 space-y-2 opacity-90">
                    <ToggleRow
                      label="Owner answers chat"
                      checked={fallback.owner_fallback_for_chat}
                      disabled={!fallback.owner_fallback_enabled}
                      onChange={(v) => updateFallback.mutate({ owner_fallback_for_chat: v })}
                    />
                    <ToggleRow
                      label="Owner answers audio calls"
                      checked={fallback.owner_fallback_for_audio}
                      disabled={!fallback.owner_fallback_enabled}
                      onChange={(v) => updateFallback.mutate({ owner_fallback_for_audio: v })}
                    />
                    <ToggleRow
                      label="Owner answers video calls"
                      checked={fallback.owner_fallback_for_video}
                      disabled={!fallback.owner_fallback_enabled}
                      onChange={(v) => updateFallback.mutate({ owner_fallback_for_video: v })}
                    />
                  </div>
                  <ToggleRow
                    label="Use General Pool when no department selected"
                    checked={fallback.general_pool_enabled}
                    onChange={(v) => updateFallback.mutate({ general_pool_enabled: v })}
                  />
                </>
              )}
            </CardContent>
          </Card>

          {/* Diagnostics */}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">Routing diagnostics</CardTitle>
                <CardDescription>
                  Visible / hidden departments for the selected channel.
                </CardDescription>
              </div>
              <Select value={channel} onValueChange={(v) => setChannel(v as DepartmentChannel)}>
                <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">Chat</SelectItem>
                  <SelectItem value="audio">Audio</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {loadingDiag || !diagnostics ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <div className="space-y-4 text-sm">
                  <div className="flex items-center gap-4 text-muted-foreground text-xs">
                    <span>
                      Visible: <strong className="text-foreground">{diagnostics.visible_departments.length}</strong>
                    </span>
                    <span>
                      Hidden: <strong className="text-foreground">{diagnostics.hidden_departments.length}</strong>
                    </span>
                    <span>
                      General Pool: <strong className="text-foreground">{diagnostics.general_pool_size}</strong>
                    </span>
                  </div>

                  {diagnostics.visible_departments.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Visible
                      </p>
                      {diagnostics.visible_departments.map((v) => (
                        <div key={v.id} className="flex items-center gap-2 text-xs">
                          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                          <span className="text-foreground">{v.name}</span>
                          <span className="text-muted-foreground">
                            {v.available_count} available · {v.member_count} eligible
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {diagnostics.hidden_departments.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Hidden
                      </p>
                      {diagnostics.hidden_departments.map((h) => (
                        <div key={h.id} className="flex items-center gap-2 text-xs">
                          <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-foreground">{h.name}</span>
                          <Badge variant="outline" className="text-[10px]">{h.reason}</Badge>
                        </div>
                      ))}
                    </div>
                  )}

                  {diagnostics.visible_departments.length === 0 &&
                    diagnostics.hidden_departments.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        No departments configured — workspace operates in General Pool only.
                      </p>
                    )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card className="bg-muted/20 border-border/60">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Fallback policy and diagnostics are stored per workspace under
            <code className="mx-1 px-1 rounded bg-muted text-foreground">workspace_provider_settings</code>
            keyed by <code className="mx-1 px-1 rounded bg-muted text-foreground">department_routing</code>.
            The routing engine itself is unchanged — these controls only tune the order of fallbacks the engine tries.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label, checked, onChange, disabled,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className={`text-xs ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>
        {label}
      </Label>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
