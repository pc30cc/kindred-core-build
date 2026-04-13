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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { Mail, Send, CheckCircle, XCircle, Clock, Activity } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

const statusBadge = (status: string) => {
  switch (status) {
    case 'sent': return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-700"><CheckCircle className="h-3 w-3 mr-1" />Sent</Badge>;
    case 'failed': return <Badge className="bg-red-500/20 text-red-400 border-red-700"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
    case 'pending': return <Badge className="bg-amber-500/20 text-amber-400 border-amber-700"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
};

export default function EmailPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const activeProvider = useActiveProviderName('email', workspace?.id);
  const { data: logs, isLoading: logsLoading } = useEmailLogs({ limit: 50 });
  const qc = useQueryClient();

  // Templates
  const { data: templates } = useQuery({
    queryKey: ['email-templates', workspace?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_templates')
        .select('*')
        .eq('workspace_id', workspace!.id)
        .order('slug');
      if (error) throw error;
      return data;
    },
    enabled: !!workspace?.id,
  });

  // Test email state
  const [testOpen, setTestOpen] = useState(false);
  const [testForm, setTestForm] = useState({ to: '', subject: 'Test Email', html: '<h1>Hello!</h1><p>This is a test email sent via the self-hosted backend.</p>' });

  const sendTestEmail = useMutation({
    mutationFn: async () => {
      if (!workspace?.id) throw new Error('No workspace');
      // Send via self-hosted backend API — NOT edge function
      const provider = createApiEmailProvider(workspace.id);
      const result = await provider.send({
        to: testForm.to,
        subject: testForm.subject,
        html: testForm.html,
      });
      if (result.error) throw result.error;
      return result;
    },
    onSuccess: () => {
      toast({ title: 'Test email sent', description: 'Check the delivery logs below.' });
      setTestOpen(false);
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (err) => {
      toast({ title: 'Send failed', description: err.message, variant: 'destructive' });
    },
  });

  const sent = logs?.filter(l => l.status === 'sent').length || 0;
  const failed = logs?.filter(l => l.status === 'failed').length || 0;
  const total = logs?.length || 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('email.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Active provider: <Badge variant="outline">{activeProvider || 'none'}</Badge>
            <span className="ml-2 text-xs">(self-hosted backend)</span>
          </p>
        </div>
        <Dialog open={testOpen} onOpenChange={setTestOpen}>
          <DialogTrigger asChild>
            <Button><Send className="h-4 w-4 me-2" />Send Test Email</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Send Test Email</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Recipient</Label>
                <Input type="email" placeholder="test@example.com" value={testForm.to} onChange={e => setTestForm(p => ({ ...p, to: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input value={testForm.subject} onChange={e => setTestForm(p => ({ ...p, subject: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>HTML Body</Label>
                <Textarea rows={4} value={testForm.html} onChange={e => setTestForm(p => ({ ...p, html: e.target.value }))} />
              </div>
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

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-primary/10"><Mail className="h-5 w-5 text-primary" /></div><div><p className="text-2xl font-bold text-foreground">{total}</p><p className="text-xs text-muted-foreground">Total Emails</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-emerald-500/10"><CheckCircle className="h-5 w-5 text-emerald-400" /></div><div><p className="text-2xl font-bold text-foreground">{sent}</p><p className="text-xs text-muted-foreground">Delivered</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><div className="p-2 rounded-lg bg-red-500/10"><XCircle className="h-5 w-5 text-red-400" /></div><div><p className="text-2xl font-bold text-foreground">{failed}</p><p className="text-xs text-muted-foreground">Failed</p></div></div></CardContent></Card>
      </div>

      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="logs">Delivery Logs</TabsTrigger>
          <TabsTrigger value="templates">Templates ({templates?.length || 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="logs">
          <Card><CardContent className="pt-6">
            {logsLoading ? <p className="text-muted-foreground">Loading...</p> : !logs?.length ? (
              <div className="text-center py-8"><Activity className="h-12 w-12 text-muted-foreground mx-auto mb-3" /><p className="text-muted-foreground">No emails sent yet. Send a test email to verify your provider.</p></div>
            ) : (
              <Table><TableHeader><TableRow><TableHead>Recipient</TableHead><TableHead>Subject</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Time</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
                <TableBody>{logs.map(log => (
                  <TableRow key={log.id}><TableCell className="font-mono text-xs">{log.recipient_email}</TableCell><TableCell className="max-w-[200px] truncate">{log.subject}</TableCell><TableCell><Badge variant="outline" className="text-xs">{log.provider_name}</Badge></TableCell><TableCell>{statusBadge(log.status)}</TableCell><TableCell className="text-xs text-muted-foreground">{new Date(log.created_at).toLocaleString()}</TableCell><TableCell className="text-xs text-red-400 max-w-[200px] truncate">{log.error_message}</TableCell></TableRow>
                ))}</TableBody></Table>
            )}
          </CardContent></Card>
        </TabsContent>
        <TabsContent value="templates">
          <Card><CardContent className="pt-6">
            {!templates?.length ? (
              <div className="text-center py-8"><Mail className="h-12 w-12 text-muted-foreground mx-auto mb-3" /><p className="text-muted-foreground">No email templates yet.</p></div>
            ) : (
              <Table><TableHeader><TableRow><TableHead>Slug</TableHead><TableHead>Subject</TableHead><TableHead>Locale</TableHead></TableRow></TableHeader>
                <TableBody>{templates.map(tpl => (
                  <TableRow key={tpl.id}><TableCell className="font-mono text-xs">{tpl.slug}</TableCell><TableCell>{tpl.subject}</TableCell><TableCell><Badge variant="outline">{tpl.locale}</Badge></TableCell></TableRow>
                ))}</TableBody></Table>
            )}
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
