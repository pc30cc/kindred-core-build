import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { useAdminFeatureFlags } from '@/hooks/useAdmin';
import { supabase } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

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
      <h1 className="text-2xl font-bold">Feature Flags</h1>
      <p className="text-slate-400 text-sm">Global feature flags (workspace_id = null). Toggle features on/off across the entire platform.</p>

      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800">
                <TableHead className="text-slate-400">Key</TableHead>
                <TableHead className="text-slate-400">Description</TableHead>
                <TableHead className="text-slate-400">Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={3} className="text-center text-slate-500">Loading…</TableCell></TableRow>
              )}
              {flags?.map(f => (
                <TableRow key={f.id} className="border-slate-800 hover:bg-slate-800/50">
                  <TableCell className="text-white font-mono text-sm">{f.key}</TableCell>
                  <TableCell className="text-slate-400 text-sm">{f.description || '—'}</TableCell>
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
