import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdminProfiles, useAdminProfileCount, useAdminUserRoles, useAssignRole, useRemoveRole } from '@/hooks/useAdmin';
import { format } from 'date-fns';

function UserRolesCell({ userId }: { userId: string }) {
  const { data: roles } = useAdminUserRoles(userId);
  const assignRole = useAssignRole();
  const removeRole = useRemoveRole();
  const [selectedRole, setSelectedRole] = useState<string>('');

  const currentRoles = roles?.map(r => r.role) ?? [];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {currentRoles.length === 0 && <span className="text-slate-500 text-xs">No roles</span>}
      {currentRoles.map(role => (
        <Badge
          key={role}
          variant={role === 'admin' ? 'destructive' : 'secondary'}
          className="cursor-pointer text-xs"
          onClick={() => removeRole.mutate({ userId, role })}
        >
          {role} ×
        </Badge>
      ))}
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="h-6 text-xs border-slate-700">+</Button>
        </DialogTrigger>
        <DialogContent className="bg-slate-900 border-slate-700">
          <DialogHeader>
            <DialogTitle className="text-white">Assign Role</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Select value={selectedRole} onValueChange={setSelectedRole}>
              <SelectTrigger className="border-slate-700 bg-slate-800 text-white">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="moderator">moderator</SelectItem>
                <SelectItem value="user">user</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!selectedRole}
              onClick={() => {
                if (selectedRole) {
                  assignRole.mutate({ userId, role: selectedRole as any });
                  setSelectedRole('');
                }
              }}
            >
              Assign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminUsersPage() {
  const [page, setPage] = useState(0);
  const limit = 25;
  const { data: profiles, isLoading } = useAdminProfiles(limit, page * limit);
  const { data: count } = useAdminProfileCount();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <span className="text-sm text-slate-400">{count ?? 0} total users</span>
      </div>

      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-slate-800/50">
                <TableHead className="text-slate-400">Email</TableHead>
                <TableHead className="text-slate-400">Name</TableHead>
                <TableHead className="text-slate-400">Roles</TableHead>
                <TableHead className="text-slate-400">Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500">Loading…</TableCell></TableRow>
              )}
              {profiles?.map(p => (
                <TableRow key={p.id} className="border-slate-800 hover:bg-slate-800/50">
                  <TableCell className="text-white font-mono text-sm">{p.email}</TableCell>
                  <TableCell className="text-slate-300">{p.full_name || '—'}</TableCell>
                  <TableCell><UserRolesCell userId={p.id} /></TableCell>
                  <TableCell className="text-slate-400 text-sm">
                    {p.created_at ? format(new Date(p.created_at), 'yyyy-MM-dd') : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex justify-between items-center">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}
          className="border-slate-700">
          Previous
        </Button>
        <span className="text-sm text-slate-400">Page {page + 1}</span>
        <Button variant="outline" size="sm"
          disabled={!profiles || profiles.length < limit}
          onClick={() => setPage(p => p + 1)}
          className="border-slate-700">
          Next
        </Button>
      </div>
    </div>
  );
}
