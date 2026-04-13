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
        <h1 className="text-2xl font-bold">Workspaces</h1>
        <span className="text-sm text-slate-400">{count ?? 0} total workspaces</span>
      </div>

      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-slate-800/50">
                <TableHead className="text-slate-400">Name</TableHead>
                <TableHead className="text-slate-400">Slug</TableHead>
                <TableHead className="text-slate-400">Owner</TableHead>
                <TableHead className="text-slate-400">Members</TableHead>
                <TableHead className="text-slate-400">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={5} className="text-center text-slate-500">Loading…</TableCell></TableRow>
              )}
              {workspaces?.map(w => (
                <TableRow key={w.id} className="border-slate-800 hover:bg-slate-800/50">
                  <TableCell className="text-white font-medium">{w.name}</TableCell>
                  <TableCell className="text-slate-300 font-mono text-sm">{w.slug}</TableCell>
                  <TableCell className="text-slate-300 text-sm">{w.owner_email}</TableCell>
                  <TableCell className="text-slate-300">{w.member_count}</TableCell>
                  <TableCell className="text-slate-400 text-sm">
                    {format(new Date(w.created_at), 'yyyy-MM-dd')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="border-slate-700">Previous</Button>
        <span className="text-sm text-slate-400">Page {page + 1}</span>
        <Button variant="outline" size="sm" disabled={!workspaces || workspaces.length < limit} onClick={() => setPage(p => p + 1)} className="border-slate-700">Next</Button>
      </div>
    </div>
  );
}
