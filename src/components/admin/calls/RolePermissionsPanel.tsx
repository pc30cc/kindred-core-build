/**
 * Phase 8C — Platform-default role permissions for call channels.
 *
 * 4 roles (owner/admin/agent/viewer) × 8 permission keys. Each cell is
 * a switch that PUTs to /api/admin/calls/role-permissions. Workspace
 * admins can override these per-workspace via the workspace UI.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Loader2, ShieldCheck } from 'lucide-react';
import {
  fetchPlatformRolePermissions,
  updatePlatformRolePermission,
  type CallPermissionKey,
  type RoleSlug,
  type RolePermissionMatrixResponse,
} from '@/lib/admin-calls-api';
import { useToast } from '@/hooks/use-toast';

const PERMISSION_LABELS: Record<CallPermissionKey, { label: string; hint: string }> = {
  can_start_audio_call: { label: 'Start audio', hint: 'Initiate outbound audio calls' },
  can_start_video_call: { label: 'Start video', hint: 'Initiate outbound video calls' },
  can_receive_audio_call: { label: 'Receive audio', hint: 'Accept inbound audio calls' },
  can_receive_video_call: { label: 'Receive video', hint: 'Accept inbound video calls' },
  can_record_calls: { label: 'Record', hint: 'Start/stop call recording' },
  can_transfer_calls: { label: 'Transfer', hint: 'Transfer calls to teammates' },
  can_join_queue_calls: { label: 'Queue', hint: 'See and accept queued calls' },
  can_manage_call_queue: { label: 'Manage queue', hint: 'Cancel / reroute queue entries' },
};

export function RolePermissionsPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<RolePermissionMatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await fetchPlatformRolePermissions());
    } catch (e: any) {
      toast({ title: 'Failed to load permissions', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function toggle(role: RoleSlug, perm: CallPermissionKey, granted: boolean) {
    if (!data) return;
    const cellKey = `${role}::${perm}`;
    setPending(cellKey);
    // Optimistic update so the UI feels immediate.
    const prev = data.matrix[role][perm];
    setData({
      ...data,
      matrix: { ...data.matrix, [role]: { ...data.matrix[role], [perm]: granted } },
    });
    try {
      await updatePlatformRolePermission({ role_slug: role, permission_key: perm, granted });
    } catch (e: any) {
      // Roll back.
      setData((d) => d && ({
        ...d,
        matrix: { ...d.matrix, [role]: { ...d.matrix[role], [perm]: prev } },
      }));
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    } finally {
      setPending(null);
    }
  }

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Call channel permissions
        </CardTitle>
        <CardDescription>
          Platform-wide defaults per role. Workspaces can override these for their own members.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left font-medium text-xs text-muted-foreground px-2 py-2">Permission</th>
                {data.roles.map((r) => (
                  <th key={r} className="text-center font-medium text-xs text-muted-foreground px-2 py-2 capitalize">
                    {r}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.permissions.map((p) => {
                const meta = PERMISSION_LABELS[p];
                return (
                  <tr key={p} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-2.5">
                      <div className="font-medium text-foreground text-[13px]">{meta?.label || p}</div>
                      <div className="text-[11px] text-muted-foreground">{meta?.hint}</div>
                    </td>
                    {data.roles.map((r) => {
                      const cellKey = `${r}::${p}`;
                      return (
                        <td key={r} className="px-2 py-2.5 text-center">
                          <div className="inline-flex items-center justify-center">
                            <Switch
                              checked={data.matrix[r][p]}
                              disabled={pending === cellKey}
                              onCheckedChange={(v) => void toggle(r, p, v)}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}