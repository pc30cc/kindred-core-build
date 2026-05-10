import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCallbacks } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';

export default function CallbacksPage() {
  const { workspace } = useActiveWorkspace();
  const { data } = useCallCenterCallbacks(workspace?.id);
  const qc = useQueryClient();

  async function act(id: string, fn: 'assignCallback' | 'completeCallback' | 'cancelCallback') {
    if (!workspace) return;
    await callCenterApi[fn](workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center', 'callbacks'] });
  }

  const items = data?.callbacks || [];
  if (items.length === 0) return <Card className="p-8 text-center text-sm text-muted-foreground">No callbacks.</Card>;

  return (
    <div className="space-y-3">
      {items.map((c) => (
        <Card key={c.id} className="p-4 flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{c.name || c.email || c.phone || 'Anonymous'}</div>
            <div className="text-xs text-muted-foreground truncate">
              {c.subject || '—'} · {new Date(c.created_at).toLocaleString()}
            </div>
            {c.phone && <div className="text-xs text-muted-foreground">📞 {c.phone}</div>}
            {c.email && <div className="text-xs text-muted-foreground">✉ {c.email}</div>}
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{c.status}</span>
          <div className="flex gap-2">
            {c.status !== 'assigned' && c.status !== 'called' && c.status !== 'cancelled' && (
              <Button size="sm" variant="outline" onClick={() => act(c.id, 'assignCallback')}>Assign me</Button>
            )}
            {c.status !== 'called' && c.status !== 'cancelled' && (
              <Button size="sm" onClick={() => act(c.id, 'completeCallback')}>Complete</Button>
            )}
            {c.status !== 'cancelled' && c.status !== 'called' && (
              <Button size="sm" variant="ghost" onClick={() => act(c.id, 'cancelCallback')}>Cancel</Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
