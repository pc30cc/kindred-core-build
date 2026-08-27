import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { adminFetch } from '@/hooks/useAdmin';
import { useQuery } from '@tanstack/react-query';

export default function AdminDomainsPage() {
  const { data: domains, isLoading } = useQuery({
    queryKey: ['admin-all-domains'],
    queryFn: async () => {
      const body = await adminFetch<{ domains: any[] }>('/api/admin/management/domains');
      return body.domains;
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Domains</h1>
      <p className="text-muted-foreground text-sm">All custom domains registered across all workspaces.</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">Domain</TableHead>
                <TableHead className="text-muted-foreground">Workspace</TableHead>
                <TableHead className="text-muted-foreground">Verified</TableHead>
                <TableHead className="text-muted-foreground">Primary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {(!isLoading && (!domains || domains.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">No domains registered</TableCell></TableRow>
              )}
              {domains?.map((d: any) => (
                <TableRow key={d.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-foreground font-mono text-sm">{d.domain}</TableCell>
                  <TableCell className="text-foreground/80 text-sm">{d.workspaces?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={d.verified ? 'bg-green-900/50 text-green-400 border-green-500/30' : 'bg-yellow-900/50 text-yellow-400 border-yellow-500/30'}>
                      {d.verified ? 'Verified' : 'Pending'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{d.is_primary ? 'Yes' : 'No'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
