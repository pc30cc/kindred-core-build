import { useState } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations, useConversationMessages, useSendMessage, useUpdateConversation } from '@/hooks/useConversations';
import { useAuth } from '@/features/auth/AuthContext';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Inbox, Send, CheckCircle, Filter, Plus, MessageSquare,
  ChevronDown, Mail, Globe, Smartphone, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export default function InboxPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
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

  const brandLetter = (platformName || 'A').charAt(0);

  const getInitials = (name?: string | null, email?: string | null) => {
    if (name) return name.charAt(0).toUpperCase();
    if (email) return email.charAt(0).toUpperCase();
    return '?';
  };

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  };

  return (
    <div className="flex h-full">
      {/* Left panel — conversation list */}
      <div className="w-[380px] shrink-0 border-e border-border flex flex-col bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <div className="relative">
            <button className="flex items-center gap-1.5 text-sm font-medium text-foreground bg-muted hover:bg-muted/80 rounded-lg px-3 py-1.5 transition-colors">
              {t('inbox.all')}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5">
            <Filter className="h-3.5 w-3.5" />
            <span>{t('inbox.filters')}</span>
          </button>
          <div className="flex-1" />
          <button className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {/* Conversations */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="animate-pulse flex items-center gap-3 px-4 py-3">
                  <div className="w-10 h-10 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 bg-muted rounded w-28" />
                    <div className="h-3 bg-muted rounded w-44" />
                  </div>
                </div>
              ))}
            </div>
          ) : !conversations?.length ? (
            <div className="p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                <Inbox className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">{t('inbox.noMessages')}</p>
              <p className="text-xs text-muted-foreground">Conversations will appear here</p>
            </div>
          ) : (
            conversations.map(conv => {
              const isActive = selectedId === conv.id;
              const name = conv.contacts?.name || conv.contacts?.email || conv.subject || `#${conv.id.slice(0, 8)}`;
              const unread = conv.status === 'open';
              return (
                <button
                  key={conv.id}
                  className={cn(
                    'w-full text-start flex items-start gap-3 px-4 py-3 transition-colors border-b border-border/50',
                    isActive
                      ? 'bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                  onClick={() => setSelectedId(conv.id)}
                >
                  {/* Avatar */}
                  <div className={cn(
                    'w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-sm font-semibold',
                    isActive ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
                  )}>
                    {conv.contacts?.avatar_url ? (
                      <img src={conv.contacts.avatar_url} className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      getInitials(conv.contacts?.name, conv.contacts?.email)
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className={cn(
                        'text-sm truncate',
                        unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
                      )}>
                        {name}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {conv.updated_at ? timeAgo(conv.updated_at) : ''}
                      </span>
                    </div>
                    <p className={cn(
                      'text-xs truncate',
                      unread ? 'text-foreground/80' : 'text-muted-foreground'
                    )}>
                      {conv.subject || t('inbox.noMessages')}
                    </p>
                  </div>

                  {/* Unread badge */}
                  {unread && (
                    <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-bold">1</span>
                    </div>
                  )}
                </button>
              );
            })
          )}

          {/* Connect channels card */}
          <div className="p-4">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                {[
                  { icon: MessageSquare, color: 'bg-primary text-primary-foreground' },
                  { icon: Globe, color: 'bg-emerald-500 text-white' },
                  { icon: Mail, color: 'bg-red-500 text-white' },
                  { icon: Smartphone, color: 'bg-green-500 text-white' },
                ].map((item, i) => (
                  <div key={i} className={cn('w-9 h-9 rounded-lg flex items-center justify-center', item.color)}>
                    <item.icon className="h-4 w-4" />
                  </div>
                ))}
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-1">
                Connect messaging channels
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                Manage all your chats in one inbox by integrating WhatsApp, Messenger, Instagram and more.
              </p>
              <Button size="sm" className="gap-1.5 rounded-lg text-xs h-8">
                Get Started
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Right panel — message thread or empty state */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          /* Empty state with brand logo */
          <div className="flex-1 flex items-center justify-center bg-background">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary mx-auto mb-4 flex items-center justify-center shadow-lg shadow-primary/20">
                <MessageSquare className="h-8 w-8 text-primary-foreground" />
              </div>
              <h2 className="text-xl font-semibold text-foreground">{platformName || 'Inbox'}</h2>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-card">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-sm font-semibold text-primary">
                    {getInitials(selected?.contacts?.name, selected?.contacts?.email)}
                  </span>
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground truncate">
                    {selected?.contacts?.name || selected?.subject || `#${selectedId.slice(0, 8)}`}
                  </h3>
                  <p className="text-xs text-muted-foreground truncate">{selected?.contacts?.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selected?.status === 'open' && (
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs h-8 rounded-lg" onClick={() => updateConv.mutate({ id: selectedId, status: 'resolved' })}>
                    <CheckCircle className="h-3.5 w-3.5" />
                    {t('inbox.resolve')}
                  </Button>
                )}
                {selected?.status === 'resolved' && (
                  <Button size="sm" variant="outline" className="text-xs h-8 rounded-lg" onClick={() => updateConv.mutate({ id: selectedId, status: 'open' })}>
                    {t('inbox.reopen')}
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 bg-background">
              <div className="max-w-3xl mx-auto p-6 space-y-3">
                {messages?.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm',
                      msg.sender_type === 'agent'
                        ? 'ms-auto bg-primary text-primary-foreground rounded-br-md'
                        : 'bg-card border border-border rounded-bl-md'
                    )}
                  >
                    <p className="leading-relaxed">{msg.body}</p>
                    <p className={cn(
                      'text-[10px] mt-1',
                      msg.sender_type === 'agent' ? 'opacity-70' : 'text-muted-foreground'
                    )}>
                      {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Input */}
            <div className="px-6 py-4 border-t border-border bg-card">
              <div className="flex items-center gap-3 max-w-3xl mx-auto">
                <Input
                  placeholder={t('inbox.typeMessage')}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  className="flex-1 rounded-xl border-border h-10 text-sm"
                />
                <Button
                  onClick={handleSend}
                  disabled={sendMessage.isPending || !message.trim()}
                  size="icon"
                  className="h-10 w-10 rounded-xl shrink-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
