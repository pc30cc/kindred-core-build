import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Settings, Globe, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBridgeSettings, useBridgeContacts } from '@/features/widget-bridge/hooks';
import { BridgeErrorNotice } from '@/features/widget-bridge/SettingsPanel';
import { bridgeRequest, type BridgeMessage } from '@/features/widget-bridge/api';

export default function WidgetBridgeInboxPage() {
  const { t, dir, locale } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const settings = useBridgeSettings(workspace?.id);
  const [aiOnly, setAiOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const draftRequest = useRef<{ body: string; contactId: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const contacts = useBridgeContacts(workspace?.id, !!settings.data, aiOnly);
  const contact = contacts.data?.contacts.find(value => value.id === selectedId && !value.deleting);
  const messages = useInfiniteQuery({
    queryKey: ['widget-bridge-messages', user?.id, workspace?.id, selectedId],
    enabled: !!workspace && !!contact, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => bridgeRequest<{ messages: BridgeMessage[]; hasMore: boolean }>(workspace!.id,
      `/contacts/${selectedId}/messages${pageParam ? `?before=${pageParam}` : ''}`),
    getNextPageParam: page => page.hasMore ? page.messages[0]?.id : undefined,
    retry: false, refetchInterval: 3000,
  });
  const send = useMutation({
    mutationFn: (value: { body: string; contactId: string; id: string }) => bridgeRequest(workspace!.id, `/contacts/${value.contactId}/messages`, 'POST', {
      body: value.body, clientMessageId: value.id,
    }),
    onSuccess: (_data, value) => {
      if (draftRequest.current?.id === value.id) { setDraft(''); draftRequest.current = null; }
      void qc.invalidateQueries({ queryKey: ['widget-bridge-messages'] });
    },
  });
  const classify = useMutation({
    mutationFn: (value: { id: string; aiReplied: boolean }) => bridgeRequest(workspace!.id, `/contacts/${value.id}/ai-reply`, 'PUT', { aiReplied: value.aiReplied }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey:['widget-bridge-contacts'] }); },
  });
  const thread = [...(messages.data?.pages || [])].reverse().flatMap(page => page.messages);
  const lastMessageId = thread[thread.length - 1]?.id;
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [lastMessageId, selectedId]);
  const canSend = settings.data?.settings.enabled && contact?.enabled && !contact.deleting && !send.isPending;
  const submit = () => {
    const body = draft.trim();
    if (!canSend || !contact || !body) return;
    if (draftRequest.current?.body !== body || draftRequest.current?.contactId !== contact.id) {
      draftRequest.current = { body, contactId: contact.id, id: crypto.randomUUID() };
    }
    send.mutate(draftRequest.current);
  };
  if (settings.error) return <div className="p-6"><BridgeErrorNotice error={settings.error} /></div>;
  return <div className="flex h-full min-h-0 flex-col" dir={dir}>
    <header className="flex items-center justify-between gap-3 border-b p-4"><div>
      <h1 className="font-semibold">{t('widgetBridge.title')}</h1><p className="text-xs text-muted-foreground">{t('widgetBridge.inboxDescription')}</p>
    </div><Button variant="outline" asChild><Link to="/admin/widget-bridge"><Settings className="me-2 h-4 w-4" />{t('widgetBridge.settings')}</Link></Button></header>
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <aside className="max-h-48 shrink-0 overflow-auto border-b sm:max-h-none sm:w-72 sm:border-b-0 sm:border-e" aria-label={t('widgetBridge.sites')}>
        <label className="flex items-center gap-2 p-3 text-sm"><input type="checkbox" checked={aiOnly} onChange={event => { setAiOnly(event.target.checked); setSelectedId(null); }} />{t('widgetBridge.ai.title')}</label>
        {contacts.error && <BridgeErrorNotice error={contacts.error} />}
        {!contacts.data?.contacts.length && <p className="p-4 text-sm text-muted-foreground">{t('widgetBridge.empty')}</p>}
        {contacts.data?.contacts.filter(value => !value.deleting).map(value => <button key={value.id}
          onClick={() => { setSelectedId(value.id); setDraft(''); draftRequest.current = null; send.reset(); }}
          className={cn('flex w-full items-start gap-3 border-b p-4 text-start hover:bg-muted/50', selectedId === value.id && 'bg-primary/10')}>
          <Globe className="mt-1 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="truncate font-medium">{value.name}</p>
            <p dir="ltr" className="truncate text-xs text-muted-foreground">{new URL(value.url).hostname}</p>
            {value.ai_replied_at && <p className="text-xs text-primary">{t('widgetBridge.ai.title')}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{t(`widgetBridge.status.${value.enabled ? value.status : 'disabled'}` as TranslationKey)}</p>
          </div></button>)}
        {contacts.hasNextPage && <Button variant="ghost" disabled={contacts.isFetchingNextPage} onClick={() => void contacts.fetchNextPage()}>{t('widgetBridge.moreSites')}</Button>}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!contact ? <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">{t('widgetBridge.selectSite')}</div> : <>
          <div className="border-b px-4 py-3"><h2 className="font-medium">{contact.name}</h2>
            <p className="text-xs text-muted-foreground">{t(`widgetBridge.status.${contact.status}` as TranslationKey)}</p>
            <Button variant="ghost" disabled={classify.isPending} onClick={()=>classify.mutate({id:contact.id,aiReplied:!contact.ai_replied_at})}>{t(contact.ai_replied_at ? 'widgetBridge.ai.clear' : 'widgetBridge.ai.mark')}</Button>
            {classify.error && <BridgeErrorNotice error={classify.error} />}
            {contact.last_error && <p className="mt-1 text-xs text-destructive">{t(`widgetBridge.remoteErrors.${contact.last_error}` as TranslationKey)}</p>}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
            {messages.hasNextPage && <Button variant="ghost" disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{t('widgetBridge.older')}</Button>}
            {messages.error && <BridgeErrorNotice error={messages.error} />}
            {thread.map(message => <div key={message.id} className={cn('flex', message.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%] rounded-xl p-3', message.direction === 'outbound' ? 'bg-primary/10' : 'bg-muted')}>
                {message.ai_label && <p className="mb-1 text-xs text-primary">{t('widgetBridge.ai.title')}: {message.ai_label}</p>}
                <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">{new Date(message.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                  {' · '}{t(`widgetBridge.delivery.${message.delivery}`)}</p>
                {message.delivery === 'uncertain' && <p className="mt-2 text-xs text-warning">{t('widgetBridge.uncertainNotice')}</p>}
              </div>
            </div>)}<div ref={bottom} />
          </div>
          <form className="space-y-2 border-t p-4" onSubmit={event => { event.preventDefault(); submit(); }}>
            {!settings.data?.settings.enabled || !contact.enabled ? <p className="text-xs text-muted-foreground">{t('widgetBridge.disabledNotice')}</p> : null}
            <div className="flex items-end gap-2"><Textarea aria-label={t('widgetBridge.message')} placeholder={t('widgetBridge.message')}
              maxLength={4000} value={draft} disabled={!canSend} className="min-h-20" onChange={event => setDraft(event.target.value)} />
              <Button type="submit" aria-label={t('widgetBridge.send')} disabled={!canSend || !draft.trim()}>{send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
            </div>{send.error && <BridgeErrorNotice error={send.error} />}
          </form>
        </>}
      </section>
    </div>
  </div>;
}
