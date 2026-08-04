/**
 * Super Admin → Widget Settings → Advanced Routing.
 *
 * Global owner-fallback / general-pool policy applied to ALL workspaces.
 * No workspace picker, no membership requirement — these are platform-wide
 * defaults sourced from `app_runtime_config.global_advanced_routing`.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { Activity, Info, Loader2 } from 'lucide-react';

import {
  getGlobalAdvancedRouting,
  updateGlobalAdvancedRouting,
  type GlobalAdvancedRoutingPolicy,
} from '@/lib/admin-advanced-routing-api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const QUERY_KEY = ['admin-global-advanced-routing'] as const;

export function AdvancedRoutingSection() {
  const qc = useQueryClient();

  const { data: policy, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getGlobalAdvancedRouting,
    retry: false,
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<GlobalAdvancedRoutingPolicy>) =>
      updateGlobalAdvancedRouting(patch),
    onSuccess: (next) => {
      qc.setQueryData(QUERY_KEY, next);
      toast.success('Advanced routing policy updated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" /> Advanced Routing
            </CardTitle>
            <span className="text-[10px] uppercase tracking-wider rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-muted-foreground">
              Global
            </span>
          </div>
          <CardDescription>
            Platform-wide fallback defaults applied to every workspace on this
            install. Workspace owners cannot see or override them.
            Fallback order: General Pool → Owner → Queue → Callback → Offline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading || !policy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
                  Owner fallback
                </p>
              <ToggleRow
                  label="Enable owner fallback"
                  description="Route to the workspace owner when no eligible operator is available."
                checked={policy.owner_fallback_enabled}
                onChange={(v) => updateMut.mutate({ owner_fallback_enabled: v })}
              />
                <div className="ms-4 ps-3 border-s border-border/50 space-y-2">
                  <ToggleRow
                    label="Owner answers chat"
                    checked={policy.owner_fallback_for_chat}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_chat: v })}
                  />
                  <ToggleRow
                    label="Owner answers audio calls"
                    checked={policy.owner_fallback_for_audio}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_audio: v })}
                  />
                  <ToggleRow
                    label="Owner answers video calls"
                    checked={policy.owner_fallback_for_video}
                    disabled={!policy.owner_fallback_enabled}
                    onChange={(v) => updateMut.mutate({ owner_fallback_for_video: v })}
                  />
                </div>
              </div>
              <div className="space-y-2 pt-2 border-t border-border/40">
                <p className="text-xs font-medium text-foreground/80 uppercase tracking-wide">
                  General Pool
                </p>
                <ToggleRow
                  label="Use General Pool when no department selected"
                  description="When a visitor doesn't pick a department, fall back to members not assigned to any department."
                  checked={policy.general_pool_enabled}
                  onChange={(v) => updateMut.mutate({ general_pool_enabled: v })}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-muted/20 border-border/60">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            These defaults apply to every workspace on this install. Stored under{' '}
            <code className="mx-0.5 px-1 rounded bg-muted text-foreground">app_runtime_config.global_advanced_routing</code>.
            Legacy per-workspace fallback rows are ignored by the routing engine.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleRow({
  label, description, checked, onChange, disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
      <div className="space-y-0.5">
        <Label className={`text-sm ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>
          {label}
        </Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}