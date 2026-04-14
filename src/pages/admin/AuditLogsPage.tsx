import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminAuditLogs } from '@/hooks/useAdmin';
import { format } from 'date-fns';

export default function AdminAuditLogsPage() {
  const { data: logs, isLoading } = useAdminAuditLogs(100);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-admin-foreground">Audit Logs</h1>
      <p className="text-admin-muted-foreground text-sm">Platform-wide audit trail of all significant actions.</p>

      <Card className="bg-admin-card border-admin-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-admin-border">
                <TableHead className="text-admin-muted-foreground">Time</TableHead>
                <TableHead className="text-admin-muted-foreground">Action</TableHead>
                <TableHead className="text-admin-muted-foreground">Entity</TableHead>
                <TableHead className="text-admin-muted-foreground">User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-admin-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {(!isLoading && (!logs || logs.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-admin-muted-foreground">No audit logs yet</TableCell></TableRow>
              )}
              {logs?.map(l => (
                <TableRow key={l.id} className="border-admin-border hover:bg-admin-muted/50">
                  <TableCell className="text-admin-muted-foreground text-xs">
                    {l.created_at ? format(new Date(l.created_at), 'yyyy-MM-dd HH:mm:ss') : '—'}
                  </TableCell>
                  <TableCell className="text-admin-foreground text-sm">{l.action}</TableCell>
                  <TableCell className="text-admin-foreground/80 text-sm font-mono">
                    {l.entity_type}{l.entity_id ? `:${l.entity_id.slice(0, 8)}` : ''}
                  </TableCell>
                  <TableCell className="text-admin-muted-foreground text-xs font-mono">{l.user_id.slice(0, 8)}…</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
