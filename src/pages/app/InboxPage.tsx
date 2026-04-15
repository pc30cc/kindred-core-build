import { useState, useRef, useEffect } from 'react';
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
  Search, MoreHorizontal, Archive, Tag, UserCheck,
  AlertCircle, Clock, CheckCircle2, Star,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const statusColors: Record<string, string> = {
  open: 'bg-success/15 text-success border-success/20',
  pending: 'bg-warning/15 text-warning border-warning/20',
  resolved: 'bg-info/15 text-info border-info/20',
  closed: 'bg-muted text-muted-foreground',
};
const statusDots: Record<string, string> = {
  open: 'bg-success',
  pending: 'bg-warning',
  resolved: 'bg-info',
  closed: 'bg-muted-foreground',
};

export default function InboxPage() {
  const { t, dir } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading } = useConversations(workspace?.id, filter);
  const { data: rawMessages } = useConversationMessages(selectedId ?? undefined);
  const sendMessage = useSendMessage(selectedId ?? undefined);
  const updateConv = useUpdateConversation();

  const selected = conversations?.find(c => c.id === selectedId);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rawMessages?.length]);

  const handleSend = async () => {
    if (!message.trim() || !selectedId || !user) return;
    await sendMessage.mutateAsync({ body: message, senderId: user.id });
    setMessage('');
  };

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

  const filteredConvos = conversations?.filter(c => {
    if (!search) return true;
    const name = c.contacts?.name || c.contacts?.email || c.subject || '';
    return name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="flex h-full" dir={dir}>
      {/* Left panel — conversation list */}
      <div className="w-[380px] shrink-0 border-e border-border flex flex-col bg-card">
        {/* Search */}
        <div className="px-4 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="ps-9 h-9 text-sm rounded-lg bg-secondary border-0"
              placeholder="Search conversations..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50">
          <button className="flex items-center gap-1.5 text-xs font-medium text-foreground bg-secondary hover:bg-secondary/80 rounded-lg px-2.5 py-1.5 transition-colors">
            {t('inbox.all')}
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
          <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5">
            <Filter className="h-3 w-3" />
            <span>{t('inbox.filters')}</span>
          </button>
          <div className="flex-1" />
          <button className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Conversations */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="animate-pulse flex items-center gap-3 px-3 py-3">
                  <div className="w-10 h-10 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 bg-muted rounded w-28" />
                    <div className="h-3 bg-muted rounded w-44" />
                  </div>
                </div>
              ))}
            </div>
          ) : !filteredConvos?.length ? (
            <div className="py-16 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                <Inbox className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">{t('inbox.noMessages')}</p>
              <p className="text-xs text-muted-foreground">Conversations will appear here</p>
            </div>
          ) : (
            filteredConvos.map(conv => {
              const isActive = selectedId === conv.id;
              const name = conv.contacts?.name || conv.contacts?.email || conv.subject || `#${conv.id.slice(0, 8)}`;
              const unread = conv.status === 'open';
              return (
                <button
                  key={conv.id}
                  className={cn(
                    'w-full text-start flex items-start gap-3 px-4 py-3.5 transition-colors border-b border-border/30',
                    isActive ? 'bg-primary/5 border-s-2 border-s-primary' : 'hover:bg-muted/30'
                  )}
                  onClick={() => setSelectedId(conv.id)}
                >
                  {/* Avatar */}
                  <div className="relative">
                    <div className={cn(
                      'w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-sm font-semibold',
                      isActive ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
                    )}>
                      {conv.contacts?.avatar_url ? (
                        <img src={conv.contacts.avatar_url} className="w-10 h-10 rounded-full object-cover" alt="" />
                      ) : (
                        getInitials(conv.contacts?.name, conv.contacts?.email)
                      )}
                    </div>
                    {unread && (
                      <div className="absolute -top-0.5 -end-0.5 w-3 h-3 rounded-full bg-primary border-2 border-card" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className={cn('text-sm truncate', unread ? 'font-semibold text-foreground' : 'font-medium text-foreground')}>
                        {name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {conv.updated_at ? timeAgo(conv.updated_at) : ''}
                      </span>
                    </div>
                    <p className={cn('text-xs truncate', unread ? 'text-foreground/80' : 'text-muted-foreground')}>
                      {conv.subject || t('inbox.noMessages')}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Badge className={cn('text-[9px] px-1 py-0 border', statusColors[conv.status ?? 'open'])}>
                        {conv.status}
                      </Badge>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* Right panel — message thread or empty state */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center bg-background">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary mx-auto mb-4 flex items-center justify-center" style={{ boxShadow: 'var(--shadow-glow)' }}>
                <MessageSquare className="h-8 w-8 text-primary-foreground" />
              </div>
              <h2 className="text-xl font-semibold text-foreground">{platformName || 'Inbox'}</h2>
              <p className="text-sm text-muted-foreground mt-1">Select a conversation to start replying</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-6 py-3.5 border-b border-border flex items-center justify-between bg-card" style={{ boxShadow: 'var(--shadow-card)' }}>
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-primary">
                      {getInitials(selected?.contacts?.name, selected?.contacts?.email)}
                    </span>
                  </div>
                  <div className={cn('absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full border-2 border-card', statusDots[selected?.status ?? 'open'])} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground truncate">
                    {selected?.contacts?.name || selected?.subject || `#${selectedId.slice(0, 8)}`}
                  </h3>
                  <p className="text-xs text-muted-foreground truncate">{selected?.contacts?.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={cn('text-[10px] border', statusColors[selected?.status ?? 'open'])}>
                  {selected?.status}
                </Badge>
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
                <Button size="icon" variant="ghost" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 bg-background">
              <div className="max-w-3xl mx-auto p-6 space-y-3">
                {rawMessages?.map(msg => (
                  <div
                    key={msg.id}
                    className={cn(
                      'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm transition-all',
                      msg.sender_type === 'agent'
                        ? 'ms-auto bg-primary text-primary-foreground rounded-br-md'
                        : 'bg-card border border-border rounded-bl-md'
                    )}
                    style={{ boxShadow: msg.sender_type === 'agent' ? undefined : 'var(--shadow-card)' }}
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
                <div ref={messagesEndRef} />
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
