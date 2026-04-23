/**
 * Super Admin → Widget Settings → Advanced Routing.
 *
 * Global owner-fallback / general-pool policy applied to ALL workspaces.
 * No workspace picker, no membership requirement — these are platform-wide
 * defaults sourced from `app_runtime_config.global_advanced_routing`.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" /> Advanced Routing
          </CardTitle>
          <CardDescription>
            <strong className="text-foreground">Platform-wide routing defaults.</strong>{' '}
            These settings apply globally to every workspace on this install —
            workspace owners do not see or override them. Fallback order when
            no eligible department member is available:
            General Pool → Owner → Queue → Callback → Offline.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading || !policy ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <ToggleRow
                label="Enable owner fallback"
                description="Route to the workspace owner when no eligible operator is available."
                checked={policy.owner_fallback_enabled}
                onChange={(v) => updateMut.mutate({ owner_fallback_enabled: v })}
              />
              <div className="ms-6 space-y-2 opacity-95">
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
              <ToggleRow
                label="Use General Pool when no department selected"
                description="When a visitor doesn't pick a department, fall back to members not assigned to any department."
                checked={policy.general_pool_enabled}
                onChange={(v) => updateMut.mutate({ general_pool_enabled: v })}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="bg-muted/20 border-border/60">
        <CardContent className="p-4 flex items-start gap-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Stored under <code className="mx-1 px-1 rounded bg-muted text-foreground">app_runtime_config.global_advanced_routing</code>.
            Workspace owners no longer see fallback policy in their normal Team &amp; Departments view —
            it is managed here as a platform-wide default. Per-workspace fallback rows from older
            installs are ignored by the routing engine.
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