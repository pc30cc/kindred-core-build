/**
 * Native (iOS) conversation thread.
 *
 * Phone-sized reader + composer for a single conversation: live messages,
 * chat bubbles, attachments and a sticky send bar above the keyboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Send, CheckCircle2, Bot, Loader2 } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import {
  useConversations,
  useConversationMessages,
  useSendMessage,
  useUpdateConversation,
  useMarkConversationSeen,
} from '@/hooks/useConversations';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { MessageAttachmentView } from '@/components/inbox/MessageAttachmentView';
import { contactDisplayName } from '@/lib/contact-display';
import { formatTime } from '@/lib/date';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export default function MobileConversationPage() {
  const { t, locale, dir } = useTranslation();
  const navigate = useNavigate();
  const { slug, conversationId } = useParams<{ slug: string; conversationId: string }>();
  const workspace = useCurrentWorkspace();

  const { data: conversations } = useConversations(workspace?.id, undefined, 'main');
  const conversation = useMemo(
    () => (conversations ?? []).find((c: any) => c.id === conversationId) as any,
    [conversations, conversationId],
  );

  const { data: messages, isLoading } = useConversationMessages(conversationId);
  const sendMessage = useSendMessage(conversationId, workspace?.id);
  const updateConversation = useUpdateConversation();
  const markSeen = useMarkConversationSeen();

  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useInboxRealtime({ workspaceId: workspace?.id, conversationId });

  // Mark the thread as read once on open.
  useEffect(() => {
    if (conversationId) markSeen.mutate(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length]);

  const name = conversation
    ? contactDisplayName(conversation.contacts, conversation.id, t as any, conversation.visitor_country_name, locale)
    : '';

  const handleSend = () => {
    const body = draft.trim();
    if (!body || sendMessage.isPending) return;
    setDraft('');
    sendMessage.mutate({ body });
  };

  const BackIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const isResolved = conversation?.status === 'resolved' || conversation?.status === 'closed';

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-background">
      {/* Thread header */}
      <header className="shrink-0 flex items-center gap-2 border-b border-border bg-card/95 px-2 pt-[calc(env(safe-area-inset-top)+6px)] pb-2 backdrop-blur-xl">
        <button
          type="button"
          onClick={() => navigate(`/${slug}/inbox`)}
          className="rounded-full p-2 text-primary active:bg-muted"
          aria-label="Back"
        >
          <BackIcon className="h-6 w-6" />
        </button>
        <ContactAvatar
          name={conversation?.contacts?.name}
          email={conversation?.contacts?.email}
          avatarUrl={conversation?.contacts?.avatar_url}
          os={conversation?.visitor_os}
          device={conversation?.visitor_device}
          countryCode={conversation?.visitor_country_code}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold text-foreground">{name || '…'}</p>
          <p className="truncate text-[12px] text-muted-foreground" dir="ltr">
            {conversation?.contacts?.email || ''}
          </p>
        </div>
        {conversationId && !isResolved && (
          <button
            type="button"
            onClick={() =>
              updateConversation.mutate({ id: conversationId, workspace_id: workspace!.id, status: 'resolved' })
            }
            className="rounded-full p-2 text-muted-foreground active:bg-muted"
            aria-label={t('inbox.resolve')}
          >
            <CheckCircle2 className="h-6 w-6" />
          </button>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-2">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-12 rounded-2xl', i % 2 ? 'w-2/3 ms-auto' : 'w-1/2')} />
            ))}
          </div>
        ) : (
          (messages ?? []).map((m: any) => {
            const isOutbound = m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'bot';
            if (m.sender_type === 'system') {
              return (
                <p key={m.id} className="mx-auto max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-[12px] text-muted-foreground">
                  {m.body}
                </p>
              );
            }
            const atts = m.attachments ?? (m.attachment ? [m.attachment] : []);
            return (
              <div key={m.id} className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[80%] rounded-2xl px-3.5 py-2 shadow-sm',
                    isOutbound
                      ? 'bg-primary text-primary-foreground rounded-br-md'
                      : 'bg-card border border-border text-foreground rounded-bl-md',
                  )}
                >
                  {m.sender_type === 'ai' && (
                    <span className="mb-1 flex items-center gap-1 text-[11px] opacity-80">
                      <Bot className="h-3.5 w-3.5" /> AI
                    </span>
                  )}
                  {atts.length > 0 && (
                    <div className="mb-1 space-y-1">
                      {atts.map((att: any) => (
                        <MessageAttachmentView key={att.id} att={att} t={t as any} isAgent={isOutbound} />
                      ))}
                    </div>
                  )}
                  {m.body && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{m.body}</p>}
                  <p className={cn('mt-1 text-[11px]', isOutbound ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                    {formatTime(m.created_at)}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-border bg-card/95 px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)] backdrop-blur-xl">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={1}
            placeholder={t('inbox.typeMessage')}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-2.5 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft.trim() || sendMessage.isPending}
            aria-label={t('inbox.send')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {sendMessage.isPending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5 rtl:-scale-x-100" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
