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
import { useTranslation } from '@/i18n';

export function RolePermissionsPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [data, setData] = useState<RolePermissionMatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await fetchPlatformRolePermissions());
    } catch (e: any) {
      toast({
        title: t('admin.voiceVideo.permissions.loadFailed' as any),
        description: e.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
      setData(
        (d) =>
          d && {
            ...d,
            matrix: { ...d.matrix, [role]: { ...d.matrix[role], [perm]: prev } },
          },
      );
      toast({ title: t('admin.voiceVideo.control.saveFailed' as any), description: e.message, variant: 'destructive' });
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
          <ShieldCheck className="h-5 w-5" /> {t('admin.voiceVideo.permissions.title' as any)}
        </CardTitle>
        <CardDescription>{t('admin.voiceVideo.permissions.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-start font-medium text-xs text-muted-foreground px-2 py-2">
                  {t('admin.voiceVideo.permissions.permission' as any)}
                </th>
                {data.roles.map((r) => (
                  <th key={r} className="text-center font-medium text-xs text-muted-foreground px-2 py-2 capitalize">
                    {t(`admin.voiceVideo.permissions.roles.${r}` as any)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.permissions.map((p) => {
                return (
                  <tr key={p} className="border-b border-border/50 last:border-0">
                    <td className="px-2 py-2.5">
                      <div className="font-medium text-foreground text-[13px]">
                        {t(`admin.voiceVideo.permissions.items.${p}.label` as any)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {t(`admin.voiceVideo.permissions.items.${p}.hint` as any)}
                      </div>
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
