import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { useAdminFeatureFlags } from '@/hooks/useAdmin';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';

export default function AdminFeatureFlagsPage() {
  const { data: flags, isLoading } = useAdminFeatureFlags();
  const qc = useQueryClient();

  const toggleFlag = async (id: string, enabled: boolean) => {
    const { error } = await supabase
      .from('feature_flags')
      .update({ enabled })
      .eq('id', id);
    if (error) {
      toast.error('Failed to update flag');
      return;
    }
    toast.success('Flag updated');
    qc.invalidateQueries({ queryKey: ['admin-feature-flags'] });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Feature Flags</h1>
      <p className="text-muted-foreground text-sm">Global feature flags (workspace_id = null). Toggle features on/off across the entire platform.</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">Key</TableHead>
                <TableHead className="text-muted-foreground">Description</TableHead>
                <TableHead className="text-muted-foreground">Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
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
