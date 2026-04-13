import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminAuditLogs } from '@/hooks/useAdmin';
import { format } from 'date-fns';

export default function AdminAuditLogsPage() {
  const { data: logs, isLoading } = useAdminAuditLogs(100);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit Logs</h1>
      <p className="text-slate-400 text-sm">Platform-wide audit trail of all significant actions.</p>

      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800">
                <TableHead className="text-slate-400">Time</TableHead>
                <TableHead className="text-slate-400">Action</TableHead>
                <TableHead className="text-slate-400">Entity</TableHead>
                <TableHead className="text-slate-400">User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500">Loading…</TableCell></TableRow>
              )}
              {(!isLoading && (!logs || logs.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-slate-500">No audit logs yet</TableCell></TableRow>
              )}
              {logs?.map(l => (
                <TableRow key={l.id} className="border-slate-800 hover:bg-slate-800/50">
                  <TableCell className="text-slate-400 text-xs">
                    {l.created_at ? format(new Date(l.created_at), 'yyyy-MM-dd HH:mm:ss') : '—'}
                  </TableCell>
                  <TableCell className="text-white text-sm">{l.action}</TableCell>
                  <TableCell className="text-slate-300 text-sm font-mono">
                    {l.entity_type}{l.entity_id ? `:${l.entity_id.slice(0, 8)}` : ''}
                  </TableCell>
                  <TableCell className="text-slate-400 text-xs font-mono">{l.user_id.slice(0, 8)}…</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
