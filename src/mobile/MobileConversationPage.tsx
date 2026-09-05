/**
 * Native (iOS) conversation thread.
 *
 * Full-screen reader + composer for a single conversation: pinned nav bar,
 * day separators, chat bubbles with delivery ticks, attachments and a sticky
 * send bar that rides above the keyboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Send,
  Paperclip,
  Mic,
  Square,
  X,
  CheckCircle2,
  Bot,
  Loader2,
  Check,
  CheckCheck,
} from 'lucide-react';

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
import { formatTime, formatDate } from '@/lib/date';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { conversationsApi } from '@/lib/conversations-api';
import { toast } from '@/lib/toast';

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
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useVoiceRecorder();

  /**
   * A single pending attachment (file pick OR voice note). It is uploaded
   * through the SAME authenticated operator attachment endpoints the web
   * inbox uses — no mobile-only upload path.
   */
  const [pending, setPending] = useState<
    { name: string; id: string | null; uploading: boolean } | null
  >(null);

  const uploadFile = async (file: File) => {
    if (!workspace?.id) return;
    setPending({ name: file.name, id: null, uploading: true });
    try {
      const init = await conversationsApi.initAttachment({
        workspace_id: workspace.id,
        conversation_id: conversationId ?? null,
        file,
      });
      await conversationsApi.uploadAttachment({
        workspace_id: workspace.id,
        attachment_id: init.attachment_id,
        file,
      });
      setPending({ name: file.name, id: init.attachment_id, uploading: false });
    } catch (err: any) {
      setPending(null);
      toast.error(err?.message || 'Upload failed');
    }
  };

  const toggleRecording = async () => {
    if (recorder.recording) {
      const file = await recorder.stop();
      if (file) await uploadFile(file);
      return;
    }
    await recorder.start();
  };

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
    const attachmentId = pending?.id ?? null;
    if ((!body && !attachmentId) || sendMessage.isPending || pending?.uploading) return;
    setDraft('');
    setPending(null);
    sendMessage.mutate({ body, attachmentId });
  };

  const BackIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const isResolved = conversation?.status === 'resolved' || conversation?.status === 'closed';
  const isOnline = conversation?.visitor_status === 'online' || conversation?.contacts?.is_online;

  const list = messages ?? [];

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-muted/40">
      {/* Nav bar */}
      <header className="shrink-0 flex items-center gap-2 bg-card/90 px-1.5 pt-[env(safe-area-inset-top)] pb-2 shadow-[0_1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl">
        <button
          type="button"
          onClick={() => navigate(`/${slug}/inbox`)}
          className="rounded-full p-1.5 text-primary transition-transform active:scale-90"
          aria-label="Back"
        >
          <BackIcon className="h-7 w-7" />
        </button>

        <button
          type="button"
          onClick={() =>
            conversation?.contacts?.id && navigate(`/${slug}/contacts/${conversation.contacts.id}`)
          }
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 py-1 text-start active:bg-muted/70"
        >
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
            <p
              className={cn(
                'truncate text-[12px]',
                isOnline ? 'text-emerald-600' : 'text-muted-foreground',
              )}
              dir={isOnline ? undefined : 'ltr'}
            >
              {isOnline ? t('visitors.online') : conversation?.contacts?.email || ''}
            </p>
          </div>
        </button>

        {conversationId && !isResolved && (
          <button
            type="button"
            onClick={() =>
              updateConversation.mutate({ id: conversationId, workspace_id: workspace!.id, status: 'resolved' })
            }
            className="rounded-full p-2 text-primary transition-transform active:scale-90"
            aria-label={t('inbox.resolve')}
          >
            <CheckCircle2 className="h-[22px] w-[22px]" />
          </button>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-4 space-y-1.5">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-14 rounded-3xl', i % 2 ? 'w-2/3 ms-auto' : 'w-1/2')} />
            ))}
          </div>
        ) : (
          list.map((m: any, i: number) => {
            const isOutbound = m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'bot';
            const prev = list[i - 1] as any;
            const showDay =
              !prev ||
              new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();

            if (m.sender_type === 'system') {
              return (
                <div key={m.id} className="flex justify-center py-1">
                  <p className="max-w-[85%] rounded-full bg-card px-3 py-1 text-center text-[12px] text-muted-foreground shadow-sm">
                    {m.body}
                  </p>
                </div>
              );
            }

            const atts = m.attachments ?? (m.attachment ? [m.attachment] : []);
            return (
              <div key={m.id}>
                {showDay && (
                  <div className="flex justify-center py-3">
                    <span className="rounded-full bg-card px-3 py-1 text-[12px] font-medium text-muted-foreground shadow-sm">
                      {formatDate(m.created_at)}
                    </span>
                  </div>
                )}
                <div className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[82%] px-3.5 py-2 shadow-[0_1px_2px_hsl(220_40%_20%/0.08)]',
                      isOutbound
                        ? 'rounded-[20px] rounded-ee-[6px] bg-primary/15 text-foreground'
                        : 'rounded-[20px] rounded-es-[6px] bg-card text-foreground',
                    )}
                  >
                    {m.sender_type === 'ai' && (
                      <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-primary">
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
                    {m.body && (
                      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                        {m.body}
                      </p>
                    )}
                    <span className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                      {formatTime(m.created_at)}
                      {isOutbound &&
                        (m.seen_at || m.read_at ? (
                          <CheckCheck className="h-3.5 w-3.5 text-primary" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        ))}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer — sits on the safe-area edge and rides the keyboard */}
      <div className="shrink-0 bg-card/95 px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+6px)] [margin-bottom:var(--kb-inset,0px)] shadow-[0_-1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl">
        {pending && (
          <div className="mb-2 flex items-center gap-2 rounded-2xl bg-muted/70 px-3 py-2 text-[13px]">
            {pending.uploading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : (
              <Paperclip className="h-4 w-4 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate">{pending.name}</span>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-full p-1 text-muted-foreground active:scale-90"
              aria-label="Remove attachment"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {recorder.recording ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => recorder.cancel()}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:scale-90"
              aria-label="Cancel recording"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="flex flex-1 items-center gap-2 rounded-[22px] bg-destructive/10 px-4 py-2.5 text-[15px] text-destructive">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" />
              <span className="font-medium tabular-nums">
                {String(Math.floor(recorder.seconds / 60)).padStart(2, '0')}:
                {String(recorder.seconds % 60).padStart(2, '0')}
              </span>
            </div>
            <button
              type="button"
              onClick={toggleRecording}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md active:scale-90"
              aria-label="Stop recording"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-1.5">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void uploadFile(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-11 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:scale-90"
              aria-label="Attach file"
            >
              <Paperclip className="h-[22px] w-[22px]" />
            </button>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              placeholder={t('inbox.typeMessage')}
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-[22px] bg-muted/70 px-4 py-2.5 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus:bg-muted"
            />
            {draft.trim() || pending ? (
              <button
                type="button"
                onClick={handleSend}
                disabled={sendMessage.isPending || !!pending?.uploading}
                aria-label={t('inbox.send')}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-90 disabled:opacity-40"
              >
                {sendMessage.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5 rtl:-scale-x-100" />
                )}
              </button>
            ) : (
              recorder.supported && (
                <button
                  type="button"
                  onClick={toggleRecording}
                  className="flex h-11 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground active:scale-90"
                  aria-label="Record voice message"
                >
                  <Mic className="h-[22px] w-[22px]" />
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
