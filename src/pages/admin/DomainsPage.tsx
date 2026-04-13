import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';

export default function AdminDomainsPage() {
  const { data: domains, isLoading } = useQuery({
    queryKey: ['admin-all-domains'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_domains')
        .select('*, workspaces(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Domains</h1>
      <p className="text-slate-400 text-sm">All custom domains registered across all workspaces.</p>

      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800">
                <TableHead className="text-slate-400">Domain</TableHead>
                <TableHead className="text-slate-400">Workspace</TableHead>
                <TableHead className="text-slate-400">Verified</TableHead>
                <TableHead className="text-slate-400">Primary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500">Loading…</TableCell></TableRow>
              )}
              {(!isLoading && (!domains || domains.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500">No domains registered</TableCell></TableRow>
              )}
              {domains?.map((d: any) => (
                <TableRow key={d.id} className="border-slate-800 hover:bg-slate-800/50">
                  <TableCell className="text-white font-mono text-sm">{d.domain}</TableCell>
                  <TableCell className="text-slate-300 text-sm">{d.workspaces?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={d.verified ? 'bg-green-900 text-green-300' : 'bg-yellow-900 text-yellow-300'}>
                      {d.verified ? 'Verified' : 'Pending'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-400 text-sm">{d.is_primary ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
