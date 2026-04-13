import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations, useConversationMessages, useSendMessage, useUpdateConversation } from '@/hooks/useConversations';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Inbox, Send, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function InboxPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const { data: conversations, isLoading } = useConversations(workspace?.id, filter);
  const { data: messages } = useConversationMessages(selectedId ?? undefined);
  const sendMessage = useSendMessage(selectedId ?? undefined);
  const updateConv = useUpdateConversation();

  const selected = conversations?.find(c => c.id === selectedId);

  const handleSend = async () => {
    if (!message.trim() || !selectedId || !user) return;
    await sendMessage.mutateAsync({ body: message, senderId: user.id });
    setMessage('');
  };

  const filters = [
    { key: 'all', label: t('inbox.all') },
    { key: 'open', label: t('inbox.open') },
    { key: 'pending', label: t('inbox.pending') },
    { key: 'resolved', label: t('inbox.resolved') },
    { key: 'closed', label: t('inbox.closed') },
  ];

  const statusColors: Record<string, string> = {
    open: 'bg-info text-info-foreground',
    pending: 'bg-warning text-warning-foreground',
    resolved: 'bg-success text-success-foreground',
    closed: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 animate-fade-in">
      {/* Conversation list */}
      <div className="w-80 flex flex-col border rounded-lg overflow-hidden">
        <div className="p-3 border-b">
          <h2 className="font-semibold text-foreground mb-2">{t('inbox.conversations')}</h2>
          <div className="flex flex-wrap gap-1">
            {filters.map(f => (
              <Button
                key={f.key}
                variant={filter === f.key ? 'default' : 'ghost'}
                size="sm"
                className="text-xs h-7"
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        <ScrollArea className="flex-1">
          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !conversations?.length ? (
            <div className="p-8 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{t('inbox.noMessages')}</p>
            </div>
          ) : (
            conversations.map(conv => (
              <button
                key={conv.id}
                className={cn(
                  'w-full text-start p-3 border-b hover:bg-accent transition-colors',
                  selectedId === conv.id && 'bg-accent'
                )}
                onClick={() => setSelectedId(conv.id)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium truncate">
                    {conv.contacts?.name || conv.contacts?.email || conv.subject || `#${conv.id.slice(0, 8)}`}
                  </span>
                  <Badge className={cn('text-xs', statusColors[conv.status])}>
                    {conv.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {conv.subject || t('inbox.noMessages')}
                </p>
              </button>
            ))
          )}
        </ScrollArea>
      </div>

      {/* Message thread */}
      <div className="flex-1 flex flex-col border rounded-lg overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Inbox className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">{t('inbox.noMessages')}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="p-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-semibold">{selected?.contacts?.name || selected?.subject || `#${selectedId.slice(0, 8)}`}</h3>
                <p className="text-xs text-muted-foreground">{selected?.contacts?.email}</p>
              </div>
              <div className="flex gap-2">
                {selected?.status === 'open' && (
                  <Button size="sm" variant="outline" onClick={() => updateConv.mutate({ id: selectedId, status: 'resolved' })}>
                    <CheckCircle className="h-4 w-4 me-1" />{t('inbox.resolve')}
                  </Button>
                )}
                {selected?.status === 'resolved' && (
                  <Button size="sm" variant="outline" onClick={() => updateConv.mutate({ id: selectedId, status: 'open' })}>
                    {t('inbox.reopen')}
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-3">
                {messages?.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'max-w-[70%] rounded-lg p-3 text-sm',
                      msg.sender_type === 'agent'
                        ? 'ms-auto bg-primary text-primary-foreground'
                        : 'bg-muted'
                    )}
                  >
                    <p>{msg.body}</p>
                    <p className="text-xs opacity-70 mt-1">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Input */}
            <div className="p-3 border-t flex gap-2">
              <Input
                placeholder={t('inbox.typeMessage')}
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <Button onClick={handleSend} disabled={sendMessage.isPending}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
