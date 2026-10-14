import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { useBridgeContacts } from './hooks';
import { bridgeRequest } from './api';

export function AiReplyPanel({ workspaceId, onPrepare }: { workspaceId: string; onPrepare: (urls: string[]) => void }) {
  const { t, locale } = useTranslation();
  const contacts = useBridgeContacts(workspaceId, true, true);
  const [selected, setSelected] = useState<Record<string,string>>({});
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: (id: string) => bridgeRequest(workspaceId, `/contacts/${id}/ai-reply`, 'PUT', { aiReplied:false }),
    onSuccess: (_data,id) => {
      setSelected(current => { const next = {...current}; delete next[id]; return next; });
      void qc.invalidateQueries({queryKey:['widget-bridge-contacts']});
    },
  });
  return <section className="space-y-3 rounded-xl border p-5">
    <h2 className="font-semibold">{t('widgetBridge.ai.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('widgetBridge.ai.help')}</p>
    {(contacts.error || clear.error) && <p role="alert" className="text-destructive">{t('widgetBridge.ai.error')}</p>}
    {!contacts.isPending && !contacts.data?.contacts.length && <p className="text-sm">{t('widgetBridge.ai.empty')}</p>}
    {contacts.data?.contacts.map(contact => <div key={contact.id} className="flex flex-wrap items-center gap-3 border-t py-3">
      <label className="flex min-w-0 flex-1 items-center gap-3">
        <input type="checkbox" checked={!!selected[contact.id]} disabled={contact.deleting || !contact.enabled || (!selected[contact.id] && Object.keys(selected).length>=500)} onChange={event => {
          setSelected(current => { const next = {...current}; if (event.target.checked) next[contact.id]=contact.url; else delete next[contact.id]; return next; });
        }} />
        <span className="min-w-0"><span className="block truncate">{contact.name}</span><span dir="ltr" className="block truncate text-xs text-muted-foreground">{contact.url}</span>
          <span className="block text-xs text-muted-foreground">{contact.ai_reply_source==='manual' ? t('widgetBridge.ai.manual') : contact.ai_reply_label}
            {contact.ai_replied_at ? ` · ${new Date(contact.ai_replied_at).toLocaleString(locale)}` : ''}</span>
          {!contact.enabled && <span className="text-xs">{t('widgetBridge.status.disabled')}</span>}
        </span>
      </label>
      <Button variant="ghost" disabled={clear.isPending} onClick={()=>clear.mutate(contact.id)}>{t('widgetBridge.ai.clear')}</Button>
    </div>)}
    {contacts.hasNextPage && <Button variant="outline" disabled={contacts.isFetchingNextPage} onClick={()=>void contacts.fetchNextPage()}>{t('widgetBridge.moreSites')}</Button>}
    <Button disabled={!Object.keys(selected).length} onClick={()=>onPrepare(Object.values(selected))}>{t('widgetBridge.ai.prepare')} ({Object.keys(selected).length})</Button>
    <p className="text-xs text-muted-foreground">{t('widgetBridge.ai.review')}</p>
  </section>;
}
