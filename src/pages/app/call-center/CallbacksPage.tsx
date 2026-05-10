import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCallbacks } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMemo, useState } from 'react';
import { PhoneCall, Mail, Globe, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

const TAB_DEFS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: 'requested', label: 'Requested', match: (s) => s === 'requested' },
  { key: 'in_progress', label: 'In progress', match: (s) => s === 'in_progress' },
  { key: 'scheduled', label: 'Scheduled', match: (s) => s === 'scheduled' },
  { key: 'completed', label: 'Completed', match: (s) => s === 'completed' },
  { key: 'cancelled', label: 'Cancelled', match: (s) => s === 'cancelled' },
];

export default function CallbacksPage() {
  const { workspace } = useActiveWorkspace();
  const { data } = useCallCenterCallbacks(workspace?.id);
  const qc = useQueryClient();
  const [tab, setTab] = useState('requested');

  async function act(id: string, fn: 'assignCallback' | 'completeCallback' | 'cancelCallback') {
    if (!workspace) return;
    await callCenterApi[fn](workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center', 'callbacks'] });
  }

  const items = data?.callbacks || [];
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of items) m[c.status] = (m[c.status] || 0) + 1;
    return m;
  }, [items]);

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList className="bg-muted/50">
        {TAB_DEFS.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}{counts[t.key] ? <span className="ms-1.5 text-[10px] bg-background rounded px-1.5 py-0.5">{counts[t.key]}</span> : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {TAB_DEFS.map((t) => {
        const list = items.filter((c) => t.match(c.status));
        return (
          <TabsContent key={t.key} value={t.key} className="space-y-3">
            {list.length === 0 ? (
              <Card className="p-8 text-center space-y-2">
                <PhoneCall className="h-7 w-7 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No {t.label.toLowerCase()} callbacks.</p>
              </Card>
            ) : list.map((c) => {
              const meta = (c.metadata || {}) as any;
              const name = meta.name || c.contact_email || c.contact_phone || 'Anonymous';
              const subject = meta.subject || c.notes || '—';
              const pageUrl = meta.page_url as string | undefined;
              const when = c.requested_at || c.created_at;
              return (
                <Card key={c.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 text-primary p-2"><PhoneCall className="h-4 w-4" /></div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{name}</div>
                      <div className="text-xs text-muted-foreground truncate">{subject}</div>
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-1.5">
                        {c.contact_phone && <span className="inline-flex items-center gap-1"><PhoneCall className="h-3 w-3" />{c.contact_phone}</span>}
                        {c.contact_email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{c.contact_email}</span>}
                        {pageUrl && <span className="inline-flex items-center gap-1 truncate max-w-[200px]"><Globe className="h-3 w-3" />{pageUrl}</span>}
                        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(when).toLocaleString()}</span>
                        {c.scheduled_for && <span className="inline-flex items-center gap-1">Scheduled: {new Date(c.scheduled_for).toLocaleString()}</span>}
                      </div>
                    </div>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full',
                      c.status === 'completed' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' :
                      c.status === 'cancelled' ? 'bg-muted text-muted-foreground' :
                      'bg-amber-500/15 text-amber-700 dark:text-amber-300',
                    )}>{c.status}</span>
                  </div>
                  <div className="flex gap-2 mt-3 justify-end">
                    {c.status === 'requested' && (
                      <Button size="sm" variant="outline" onClick={() => act(c.id, 'assignCallback')}>Assign me</Button>
                    )}
                    {c.status !== 'completed' && c.status !== 'cancelled' && (
                      <Button size="sm" onClick={() => act(c.id, 'completeCallback')}>Mark completed</Button>
                    )}
                    {c.status !== 'cancelled' && c.status !== 'completed' && (
                      <Button size="sm" variant="ghost" onClick={() => act(c.id, 'cancelCallback')}>Cancel</Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
