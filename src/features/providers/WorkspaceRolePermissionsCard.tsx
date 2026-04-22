/**
 * Phase 8C — Workspace overrides for call channel role permissions.
 *
 * Each cell shows three states: "inherit" (platform default), "allow",
 * "deny". Switching to inherit clears the workspace override row.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  fetchWorkspaceRolePermissions,
  setWorkspaceRolePermission,
  type WorkspaceRolePermissionsResponse,
} from '@/lib/workspace-calls-api';
import type { CallPermissionKey, RoleSlug } from '@/lib/admin-calls-api';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const PERMISSION_LABELS: Record<CallPermissionKey, string> = {
  can_start_audio_call: 'Start audio',
  can_start_video_call: 'Start video',
  can_receive_audio_call: 'Receive audio',
  can_receive_video_call: 'Receive video',
  can_record_calls: 'Record',
  can_transfer_calls: 'Transfer',
  can_join_queue_calls: 'Queue',
  can_manage_call_queue: 'Manage queue',
};

type Tri = 'inherit' | 'allow' | 'deny';

function readTri(value: boolean | null): Tri {
  if (value === null) return 'inherit';
  return value ? 'allow' : 'deny';
}

function nextTri(t: Tri): Tri {
  if (t === 'inherit') return 'allow';
  if (t === 'allow') return 'deny';
  return 'inherit';
}

function triToGranted(t: Tri): boolean | null {
  if (t === 'inherit') return null;
  return t === 'allow';
}

export function WorkspaceRolePermissionsCard({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<WorkspaceRolePermissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await fetchWorkspaceRolePermissions(workspaceId));
    } catch (e: any) {
      toast({ title: 'Failed to load permissions', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId]);

  async function cycle(role: RoleSlug, perm: CallPermissionKey) {
    if (!data) return;
    const current = readTri(data.workspace[role][perm]);
    const next = nextTri(current);
    const cellKey = `${role}::${perm}`;
    setPending(cellKey);
    const prev = data.workspace[role][perm];
    setData({
      ...data,
      workspace: { ...data.workspace, [role]: { ...data.workspace[role], [perm]: triToGranted(next) } },
    });
    try {
      await setWorkspaceRolePermission(workspaceId, {
        role_slug: role,
        permission_key: perm,
        granted: triToGranted(next),
      });
    } catch (e: any) {
      setData(d => d && ({
        ...d,
        workspace: { ...d.workspace, [role]: { ...d.workspace[role], [perm]: prev } },
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
          <ShieldCheck className="h-5 w-5" /> Role permissions (workspace)
        </CardTitle>
        <CardDescription>
          Click a cell to cycle: inherit → allow → deny → inherit. Inherited cells use the platform default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left font-medium text-xs text-muted-foreground px-2 py-2">Permission</th>
                {data.roles.map((r) => (
                  <th key={r} className="text-center font-medium text-xs text-muted-foreground px-2 py-2 capitalize">{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.permissions.map((p) => (
                <tr key={p} className="border-b border-border/50 last:border-0">
                  <td className="px-2 py-2 text-[12px] font-medium text-foreground">
                    {PERMISSION_LABELS[p]}
                  </td>
                  {data.roles.map((r) => {
                    const tri = readTri(data.workspace[r][p]);
                    const platformValue = data.platform[r][p];
                    const cellKey = `${r}::${p}`;
                    return (
                      <td key={r} className="px-2 py-2 text-center">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending === cellKey}
                          onClick={() => void cycle(r, p)}
                          className="h-7 px-2 min-w-[68px]"
                        >
                          {pending === cellKey ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px] capitalize border',
                                tri === 'allow' && 'bg-success/15 text-success border-success/30',
                                tri === 'deny' && 'bg-destructive/15 text-destructive border-destructive/30',
                                tri === 'inherit' && 'bg-muted/40 text-muted-foreground border-border',
                              )}
                            >
                              {tri === 'inherit'
                                ? `inherit (${platformValue ? 'allow' : 'deny'})`
                                : tri}
                            </Badge>
                          )}
                        </Button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}