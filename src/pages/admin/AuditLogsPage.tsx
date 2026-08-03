import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminAuditLogs } from '@/hooks/useAdmin';
import { formatPattern as format } from '@/lib/date';

export default function AdminAuditLogsPage() {
  const { data: logs, isLoading } = useAdminAuditLogs(100);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Audit Logs</h1>
      <p className="text-muted-foreground text-sm">Platform-wide audit trail of all significant actions.</p>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border">
                <TableHead className="text-muted-foreground">Time</TableHead>
                <TableHead className="text-muted-foreground">Action</TableHead>
                <TableHead className="text-muted-foreground">Entity</TableHead>
                <TableHead className="text-muted-foreground">User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {(!isLoading && (!logs || logs.length === 0)) && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">No audit logs yet</TableCell></TableRow>
              )}
              {logs?.map(l => (
                <TableRow key={l.id} className="border-border hover:bg-muted/50">
                  <TableCell className="text-muted-foreground text-xs">
                    {l.created_at ? format(new Date(l.created_at), 'yyyy-MM-dd HH:mm:ss') : '—'}
                  </TableCell>
                  <TableCell className="text-foreground text-sm">{l.action}</TableCell>
                  <TableCell className="text-foreground/80 text-sm font-mono">
                    {l.entity_type}{l.entity_id ? `:${l.entity_id.slice(0, 8)}` : ''}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs font-mono">{l.user_id.slice(0, 8)}…</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
