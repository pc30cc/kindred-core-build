/**
 * Colleagues — internal operator-to-operator chat inside the inbox.
 * Left: workspace operator directory (presence, unread, last message).
 * Right: 1:1 thread with the selected colleague.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Send, Users, MessageSquare, Loader2, ArrowLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useAuth } from '@/features/auth/AuthContext';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useTeamPresence, presenceMap } from '@/hooks/useTeamPresence';
import {
  useColleagues,
  useTeamThread,
  useSendTeamMessage,
  useMarkTeamThreadRead,
  type Colleague,
} from '@/hooks/useTeamChat';
import { formatTime, formatRelative, formatLongDate } from '@/lib/date';

function initials(name?: string | null, email?: string | null) {
  const src = (name || email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export default function TeamChatPanel() {
  const { t, dir } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const [search, setSearch] = useState('');
  const [peerId, setPeerId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data: dirData, isLoading } = useColleagues(workspace?.id);
  const { data: presence } = useTeamPresence(workspace?.id);
  const pMap = useMemo(() => presenceMap(presence as any), [presence]);
  const { data: threadData, isLoading: threadLoading } = useTeamThread(workspace?.id, peerId);
  const send = useSendTeamMessage(workspace?.id);
  const markRead = useMarkTeamThreadRead(workspace?.id);

  const colleagues = dirData?.colleagues ?? [];
  const peer: Colleague | undefined = colleagues.find(c => c.user_id === peerId);
  const messages = threadData?.messages ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return colleagues;
    return colleagues.filter(c =>
      (c.full_name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q));
  }, [colleagues, search]);

  useEffect(() => {
    if (peerId && (peer?.unread ?? 0) > 0) markRead.mutate(peerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, peer?.unread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, peerId]);

  const submit = () => {
    const body = draft.trim();
    if (!body || !peerId || send.isPending) return;
    setDraft('');
    send.mutate({ recipient_id: peerId, body });
  };

  const isOnline = (id: string) => (pMap.get(id) as any)?.state === 'online';

  return (
    <div className="flex h-full w-full" dir={dir}>
      {/* ─── Directory ─── */}
      <div className={cn(
        'w-full md:w-[300px] lg:w-[340px] shrink-0 border-e border-border flex flex-col bg-card',
        peerId ? 'hidden md:flex' : 'flex',
      )}>
        <div className="p-3 border-b border-border space-y-2.5">
          <div className="flex items-center gap-2">
            <Users className="w-[18px] h-[18px] text-primary" />
            <h2 className="text-[15px] font-bold text-foreground">{t('inbox.colleagues') || 'Colleagues'}</h2>
            <span className="text-[11px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-semibold tabular-nums">
              {colleagues.length}
            </span>
          </div>
          <div className="relative">
            <Search className={cn('absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground', dir === 'rtl' ? 'right-2.5' : 'left-2.5')} />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('inbox.searchColleagues') || 'Search colleagues...'}
              className={cn('h-9 text-[13px] bg-secondary/50 border-transparent focus:border-primary/30', dir === 'rtl' ? 'pr-8' : 'pl-8')}
              dir={dir}
            />
          </div>
        </div>

        <ScrollArea className="flex-1 [&>div>div]:!block">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-3 p-2 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-secondary/60 shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 bg-secondary/60 rounded w-2/3" />
                    <div className="h-2.5 bg-secondary/40 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : !filtered.length ? (
            <div className="py-16 px-6 text-center flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-secondary/40 flex items-center justify-center">
                <Users className="w-7 h-7 text-muted-foreground/40" />
              </div>
              <p className="text-[13px] font-medium text-foreground">{t('inbox.noColleagues') || 'No colleagues yet'}</p>
              <p className="text-[11px] text-muted-foreground">{t('inbox.noColleaguesHint') || 'Invite teammates to your workspace to start chatting.'}</p>
            </div>
          ) : (
            filtered.map(c => {
              const active = c.user_id === peerId;
              const online = isOnline(c.user_id);
              return (
                <button
                  key={c.user_id}
                  onClick={() => setPeerId(c.user_id)}
                  className={cn(
                    'w-full text-start flex gap-3 px-3 py-3 border-b border-border/30 transition-colors',
                    active ? 'bg-primary/[0.07]' : c.unread > 0 ? 'bg-primary/[0.04] hover:bg-primary/[0.08]' : 'hover:bg-muted/40',
                  )}
                >
                  <div className="relative shrink-0">
                    <Avatar className="w-10 h-10">
                      <AvatarImage src={c.avatar_url ?? undefined} alt={c.full_name || c.email || ''} />
                      <AvatarFallback className="text-[11px] font-semibold">{initials(c.full_name, c.email)}</AvatarFallback>
                    </Avatar>
                    <span className={cn(
                      'absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card',
                      online ? 'bg-success' : 'bg-muted-foreground/40',
                    )} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-foreground truncate">
                        {c.full_name || c.email || t('inbox.unknownUser') || 'Unknown'}
                      </span>
                      {c.last_message && (
                        <bdi className="ms-auto text-[10.5px] text-muted-foreground shrink-0" dir="auto">
                          {formatRelative(c.last_message.created_at)}
                        </bdi>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11.5px] text-muted-foreground truncate">
                        {c.last_message
                          ? (c.last_message.outgoing ? `${t('inbox.you') || 'You'}: ` : '') + c.last_message.body
                          : c.role}
                      </span>
                      {c.unread > 0 && (
                        <span className="ms-auto text-[10.5px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1.5 font-bold bg-primary text-primary-foreground tabular-nums">
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* ─── Thread ─── */}
      <div className={cn('flex-1 flex flex-col bg-background min-w-0', peerId ? 'flex' : 'hidden md:flex')}>
        {!peer ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-secondary/40 flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-muted-foreground/40" />
            </div>
            <p className="text-[14px] font-semibold text-foreground">{t('inbox.selectColleague') || 'Select a colleague'}</p>
            <p className="text-[12px] text-muted-foreground max-w-xs">
              {t('inbox.selectColleagueHint') || 'Private messages between operators. Visitors never see them.'}
            </p>
          </div>
        ) : (
          <>
            <div className="h-14 px-3 border-b border-border flex items-center gap-3 bg-card">
              <button
                className="md:hidden p-2 rounded-md hover:bg-secondary text-muted-foreground"
                onClick={() => setPeerId(null)}
                aria-label={t('inbox.back') || 'Back'}
              >
                <ArrowLeft className={cn('w-4 h-4', dir === 'rtl' && 'rotate-180')} />
              </button>
              <div className="relative">
                <Avatar className="w-9 h-9">
                  <AvatarImage src={peer.avatar_url ?? undefined} alt={peer.full_name || ''} />
                  <AvatarFallback className="text-[11px] font-semibold">{initials(peer.full_name, peer.email)}</AvatarFallback>
                </Avatar>
                <span className={cn(
                  'absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card',
                  isOnline(peer.user_id) ? 'bg-success' : 'bg-muted-foreground/40',
                )} />
              </div>
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-foreground truncate">{peer.full_name || peer.email}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {isOnline(peer.user_id) ? (t('inbox.online') || 'Online') : (t('inbox.offline') || 'Offline')}
                </p>
              </div>
              <span className="ms-auto text-[10.5px] px-2 py-1 rounded-full bg-secondary text-muted-foreground font-medium">
                {t('inbox.internalOnly') || 'Internal only'}
              </span>
            </div>

            <ScrollArea className="flex-1">
              <div className="px-4 py-4 space-y-1.5 max-w-3xl mx-auto">
                {threadLoading && !messages.length ? (
                  <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
                ) : !messages.length ? (
                  <div className="py-14 text-center text-[12.5px] text-muted-foreground">
                    {t('inbox.emptyTeamThread') || 'No messages yet — say hello.'}
                  </div>
                ) : (
                  messages.map((m, i) => {
                    const mine = m.sender_id === user?.id;
                    const prev = messages[i - 1];
                    const grouped = prev && prev.sender_id === m.sender_id
                      && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60_000;
                    const dayChanged = !prev || formatLongDate(prev.created_at) !== formatLongDate(m.created_at);
                    return (
                      <div key={m.id}>
                        {dayChanged && (
                          <div className="flex items-center gap-3 my-4">
                            <div className="h-px flex-1 bg-border/60" />
                            <bdi className="text-[10.5px] text-muted-foreground">{formatLongDate(m.created_at)}</bdi>
                            <div className="h-px flex-1 bg-border/60" />
                          </div>
                        )}
                        <div className={cn('flex', mine ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-3')}>
                          <div className={cn(
                            'max-w-[75%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed shadow-sm',
                            mine
                              ? 'bg-primary text-primary-foreground rounded-ee-md'
                              : 'bg-card border border-border text-foreground rounded-es-md',
                          )}>
                            <p className="whitespace-pre-wrap break-words" dir="auto">{m.body}</p>
                            <div className={cn('mt-1 text-[10px] tabular-nums', mine ? 'text-primary-foreground/70 text-end' : 'text-muted-foreground')}>
                              {formatTime(m.created_at)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={endRef} />
              </div>
            </ScrollArea>

            <div className="border-t border-border bg-card p-3">
              <div className="max-w-3xl mx-auto flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                  }}
                  rows={1}
                  dir="auto"
                  placeholder={(t('inbox.messageColleague') || 'Message {{name}}').replace('{{name}}', peer.full_name || peer.email || '')}
                  className="flex-1 resize-none max-h-40 min-h-[40px] rounded-xl bg-secondary/50 border border-transparent focus:border-primary/30 focus:outline-none px-3 py-2.5 text-[13px]"
                />
                <button
                  onClick={submit}
                  disabled={!draft.trim() || send.isPending}
                  className="h-10 w-10 shrink-0 rounded-xl bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40 transition-opacity"
                  aria-label={t('inbox.send') || 'Send'}
                >
                  {send.isPending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Send className={cn('w-4 h-4', dir === 'rtl' && 'rotate-180')} />}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
