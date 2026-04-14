import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useAdminWorkspaces, useAdminWorkspaceCount } from '@/hooks/useAdmin';
import { format } from 'date-fns';

export default function AdminWorkspacesPage() {
  const [page, setPage] = useState(0);
  const limit = 25;
  const { data: workspaces, isLoading } = useAdminWorkspaces(limit, page * limit);
  const { data: count } = useAdminWorkspaceCount();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-admin-foreground">Workspaces</h1>
        <span className="text-sm text-admin-muted-foreground">{count ?? 0} total workspaces</span>
      </div>

      <Card className="bg-admin-card border-admin-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-admin-border">
                <TableHead className="text-admin-muted-foreground">Name</TableHead>
                <TableHead className="text-admin-muted-foreground">Slug</TableHead>
                <TableHead className="text-admin-muted-foreground">Owner</TableHead>
                <TableHead className="text-admin-muted-foreground">Members</TableHead>
                <TableHead className="text-admin-muted-foreground">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={5} className="text-center text-admin-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {workspaces?.map(w => (
                <TableRow key={w.id} className="border-admin-border hover:bg-admin-muted/50">
                  <TableCell className="text-admin-foreground font-medium">{w.name}</TableCell>
                  <TableCell className="text-admin-foreground/80 font-mono text-sm">{w.slug}</TableCell>
                  <TableCell className="text-admin-foreground/80 text-sm">{w.owner_email}</TableCell>
                  <TableCell className="text-admin-foreground/80">{w.member_count}</TableCell>
                  <TableCell className="text-admin-muted-foreground text-sm">
                    {format(new Date(w.created_at), 'yyyy-MM-dd')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="border-admin-border">Previous</Button>
        <span className="text-sm text-admin-muted-foreground">Page {page + 1}</span>
        <Button variant="outline" size="sm" disabled={!workspaces || workspaces.length < limit} onClick={() => setPage(p => p + 1)} className="border-admin-border">Next</Button>
      </div>
    </div>
  );
}
