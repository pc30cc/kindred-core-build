import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useEmailLogs } from '@/hooks/useEmailLogs';
import { useActiveProviderName } from '@/providers';
import { createApiEmailProvider } from '@/providers/email/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Mail, Send, CheckCircle, XCircle, Clock, Activity } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';

async function integrationsFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body as T;
}

const statusBadge = (status: string) => {
  switch (status) {
    case 'sent': return <Badge className="bg-success/10 text-success border-success/20"><CheckCircle className="h-3 w-3 mr-1" />Sent</Badge>;
    case 'failed': return <Badge className="bg-destructive/10 text-destructive border-destructive/20"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
    case 'pending': return <Badge className="bg-warning/10 text-warning border-warning/20"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
};

export default function EmailPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const activeProvider = useActiveProviderName('email', workspace?.id);
  const { data: logs, isLoading: logsLoading } = useEmailLogs({ limit: 50 });
  const qc = useQueryClient();

  const { data: templates } = useQuery({
    queryKey: ['email-templates', workspace?.id],
    queryFn: async () => {
      const { templates } = await integrationsFetch<{ templates: any[] }>(
        `/api/workspace-integrations/${workspace!.id}/email-templates`,
      );
      return templates;
    },
    enabled: !!workspace?.id,
  });

  const [testOpen, setTestOpen] = useState(false);
  const [testForm, setTestForm] = useState({ to: '', subject: 'Test Email', html: '<h1>Hello!</h1><p>This is a test email.</p>' });

  const sendTestEmail = useMutation({
    mutationFn: async () => {
      if (!workspace?.id) throw new Error('No workspace');
      const provider = createApiEmailProvider(workspace.id);
      const result = await provider.send({ to: testForm.to, subject: testForm.subject, html: testForm.html });
      if (result.error) throw result.error;
      return result;
    },
    onSuccess: () => {
      toast({ title: 'Test email sent', description: 'Check the delivery logs below.' });
      setTestOpen(false);
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (err) => toast({ title: 'Send failed', description: err.message, variant: 'destructive' }),
  });

  const sent = logs?.filter(l => l.status === 'sent').length || 0;
  const failed = logs?.filter(l => l.status === 'failed').length || 0;
  const total = logs?.length || 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-header">{t('email.title')}</h1>
          <p className="page-subtitle mt-1">
            Active provider: <Badge variant="outline" className="text-xs">{activeProvider || 'none'}</Badge>
          </p>
        </div>
        <Dialog open={testOpen} onOpenChange={setTestOpen}>
          <DialogTrigger asChild>
            <Button><Send className="h-4 w-4 me-2" />Send Test Email</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Send Test Email</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2"><Label>Recipient</Label><Input type="email" placeholder="test@example.com" value={testForm.to} onChange={e => setTestForm(p => ({ ...p, to: e.target.value }))} /></div>
              <div className="space-y-2"><Label>Subject</Label><Input value={testForm.subject} onChange={e => setTestForm(p => ({ ...p, subject: e.target.value }))} /></div>
              <div className="space-y-2"><Label>HTML Body</Label><Textarea rows={4} value={testForm.html} onChange={e => setTestForm(p => ({ ...p, html: e.target.value }))} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTestOpen(false)}>Cancel</Button>
              <Button onClick={() => sendTestEmail.mutate()} disabled={!testForm.to || sendTestEmail.isPending}>
                {sendTestEmail.isPending ? 'Sending...' : 'Send'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10"><Mail className="h-5 w-5 text-primary" /></div>
            <div><p className="text-2xl font-bold text-foreground">{total}</p><p className="text-xs text-muted-foreground">Total Emails</p></div>
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-success/10"><CheckCircle className="h-5 w-5 text-success" /></div>
            <div><p className="text-2xl font-bold text-foreground">{sent}</p><p className="text-xs text-muted-foreground">Delivered</p></div>
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-destructive/10"><XCircle className="h-5 w-5 text-destructive" /></div>
            <div><p className="text-2xl font-bold text-foreground">{failed}</p><p className="text-xs text-muted-foreground">Failed</p></div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList className="bg-secondary/50 border border-border">
          <TabsTrigger value="logs">Delivery Logs</TabsTrigger>
          <TabsTrigger value="templates">Templates ({templates?.length || 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="logs">
          <Card className="card-elevated">
            <CardContent className="p-0">
              {logsLoading ? <div className="p-8 text-center text-muted-foreground">Loading...</div> : !logs?.length ? (
                <div className="text-center py-12">
                  <Activity className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-muted-foreground font-medium">No emails sent yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Send a test email to verify your provider</p>
                </div>
              ) : (
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Recipient</TableHead><TableHead>Subject</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Time</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{logs.map(log => (
                    <TableRow key={log.id} className="hover:bg-muted/30">
                      <TableCell className="font-mono text-xs">{log.recipient_email}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm">{log.subject}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{log.provider_name}</Badge></TableCell>
                      <TableCell>{statusBadge(log.status)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(log.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="templates">
          <Card className="card-elevated">
            <CardContent className="p-0">
              {!templates?.length ? (
                <div className="text-center py-12"><Mail className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" /><p className="text-muted-foreground">No email templates yet.</p></div>
              ) : (
                <Table><TableHeader><TableRow><TableHead>Slug</TableHead><TableHead>Subject</TableHead><TableHead>Locale</TableHead></TableRow></TableHeader>
                  <TableBody>{templates.map(tpl => (
                    <TableRow key={tpl.id} className="hover:bg-muted/30"><TableCell className="font-mono text-xs">{tpl.slug}</TableCell><TableCell className="text-sm">{tpl.subject}</TableCell><TableCell><Badge variant="outline" className="text-xs">{tpl.locale}</Badge></TableCell></TableRow>
                  ))}</TableBody></Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
