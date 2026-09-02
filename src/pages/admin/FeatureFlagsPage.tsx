import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { useAdminFeatureFlags, adminFetch } from '@/hooks/useAdmin';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { useTranslation } from '@/i18n';

export default function AdminFeatureFlagsPage() {
  const { t } = useTranslation();
  const { data: flags, isLoading } = useAdminFeatureFlags();
  const qc = useQueryClient();

  const toggleFlag = async (id: string, enabled: boolean) => {
    try {
      await adminFetch(`/api/admin/management/feature-flags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
    } catch {
      toast.error(t('admin.featureFlags.updateFailed' as any));
      return;
    }
    toast.success(t('admin.featureFlags.updated' as any));
    qc.invalidateQueries({ queryKey: ['admin-feature-flags'] });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('admin.featureFlags.title' as any)}</h1>
      <p className="text-muted-foreground text-sm">{t('admin.featureFlags.subtitle' as any)}</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">{t('admin.featureFlags.key' as any)}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.common.description' as any)}</TableHead>
                <TableHead className="text-muted-foreground">{t('admin.common.enabled' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">{t('admin.common.loading' as any)}</TableCell></TableRow>
              )}
              {flags?.map(f => (
                <TableRow key={f.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground font-mono text-sm">{f.key}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{f.description || '—'}</TableCell>
                  <TableCell>
                    <Switch
                      checked={f.enabled ?? false}
                      onCheckedChange={(v) => toggleFlag(f.id, v)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
