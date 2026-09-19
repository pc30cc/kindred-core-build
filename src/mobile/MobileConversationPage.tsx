/**
 * Native (iOS) conversation thread.
 *
 * Full-screen reader + composer for a single conversation: pinned nav bar,
 * day separators, chat bubbles with delivery ticks, attachments and a composer
 * that sits flush on the keyboard (driven by `--kb-inset`).
 *
 * Composer anatomy (mirrors iMessage/Telegram):
 *   [ attach ] [ ( mic | text field | emoji | send ) ]
 * The mic sits at the START of the field (before the placeholder) and the send
 * button at its END — so in RTL the send button lands in the left corner.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Send,
  Paperclip,
  Mic,
  Smile,
  Square,
  X,
  CheckCircle2,
  Bot,
  Loader2,
  Check,
  CheckCheck,
  MoreHorizontal,
  User,
  RotateCcw,
  FileText,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useTranslation, type TranslationKey } from '@/i18n';
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
import { contactDisplayName, type ContactDisplayT } from '@/lib/contact-display';
import { formatTime, formatDate } from '@/lib/date';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { conversationsApi } from '@/lib/conversations-api';
import { toast } from '@/lib/toast';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { MobileEmojiPicker } from './MobileEmojiPicker';

/** One attachment as `MessageAttachmentView` needs it. */
interface TimelineAttachment {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

/** The fields of a message this screen actually renders. */
interface TimelineMessage {
  id: string;
  body: string | null;
  sender_type: string;
  created_at: string;
  attachments?: TimelineAttachment[] | null;
  attachment?: TimelineAttachment | null;
}

/** The fields of a conversation this screen actually reads. */
interface TimelineConversation {
  id: string;
  status?: string;
  contacts?: {
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
    visitor_code?: string | null;
  } | null;
  metadata?: { ai_state?: string | null } | null;
  ai_state?: string | null;
  visitor_os?: string | null;
  visitor_device?: string | null;
  visitor_country_code?: string | null;
  visitor_country_name?: string | null;
}

interface PendingAttachment {
  name: string;
  id: string | null;
  uploading: boolean;
  /** Local object URL for image previews (revoked on clear). */
  previewUrl: string | null;
  isImage: boolean;
}

export default function MobileConversationPage() {
  const { t, locale, dir } = useTranslation();
  const navigate = useNavigate();
  const { slug, conversationId } = useParams<{ slug: string; conversationId: string }>();
  const workspace = useCurrentWorkspace();

  const { data: conversations } = useConversations(workspace?.id, undefined, 'main');
  const conversation = useMemo(
    () =>
      ((conversations ?? []) as unknown as TimelineConversation[]).find(
        (c) => c.id === conversationId,
      ),
    [conversations, conversationId],
  );

  const { data: messages, isLoading } = useConversationMessages(conversationId);
  const sendMessage = useSendMessage(conversationId, workspace?.id);
  const updateConversation = useUpdateConversation();
  const markSeen = useMarkConversationSeen();

  // Who is answering, and what the plan allows. Both have to say yes before
  // a composer control appears.
  //
  // `metadata.ai_state` first, then the top-level column — the same precedence
  // InboxPage reads them in. While the AI owns a thread the operator is
  // steering it, not talking to the visitor: the desktop inbox swaps the whole
  // composer for its guidance composer, and sending a file or a voice note
  // into a conversation the AI is answering would put content in front of the
  // visitor the AI knows nothing about.
  const aiManaged =
    (conversation?.metadata?.ai_state || conversation?.ai_state) === 'ai_managed';
  const { data: entitlements } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  // Fail-closed: an unresolved snapshot offers nothing rather than a control
  // that would fail on use.
  const planAllows = (key: string) => entitlements?.features?.[key]?.value === true;
  const canAttach = !aiManaged && planAllows('widget_attachments');
  const canRecordVoice = !aiManaged && planAllows('widget_voice_notes');
  const canUseEmoji = !aiManaged && planAllows('widget_emoji');

  // contactDisplayName and MessageAttachmentView are keyed by plain strings;
  // the app's `t` is keyed by TranslationKey. This adapter bridges the two
  // without erasing either type.
  const displayT: ContactDisplayT = (key, vars) => t(key as TranslationKey, vars);

  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Keep pinning to the newest message unless the operator scrolled up. */
  const stickToBottom = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const recorder = useVoiceRecorder();


  /**
   * A single pending attachment (file pick OR voice note). It is uploaded
   * through the SAME authenticated operator attachment endpoints the web
   * inbox uses — no mobile-only upload path. The preview (with its own send
   * button) lives at the bottom of the thread, inside the chat area.
   */
  const [pending, setPending] = useState<PendingAttachment | null>(null);

  const clearPending = () => {
    setPending((p) => {
      if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return null;
    });
  };

  const uploadFile = async (file: File) => {
    if (!workspace?.id) return;
    const isImage = file.type.startsWith('image/');
    const previewUrl = isImage ? URL.createObjectURL(file) : null;
    setPending({ name: file.name, id: null, uploading: true, previewUrl, isImage });
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
      setPending((p) => (p ? { ...p, id: init.attachment_id, uploading: false } : p));
    } catch (err) {
      clearPending();
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  // Voice notes: surface permission/support failures instead of a dead button.
  const toggleRecording = async () => {
    if (recorder.recording) {
      const file = await recorder.stop();
      if (file) await uploadFile(file);
      return;
    }
    if (!recorder.supported) {
      toast.error(t('inbox.voiceUnsupported'));
      return;
    }
    setEmojiOpen(false);
    await recorder.start();
  };

  useEffect(() => {
    if (recorder.error) toast.error(t('inbox.micDenied'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.error]);

  useInboxRealtime({ workspaceId: workspace?.id, conversationId });

  // Mark the thread as read once on open.
  useEffect(() => {
    if (conversationId) markSeen.mutate(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  /**
   * Jump to the newest message. Uses the scroller directly (not
   * scrollIntoView) so late-loading media can re-pin the thread reliably.
   */
  const scrollToEnd = (smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversationId]);

  useEffect(() => {
    scrollToEnd();
    // A second pass after layout settles (fonts, bubbles, safe areas).
    const id = window.setTimeout(() => scrollToEnd(), 60);
    return () => window.clearTimeout(id);
  }, [messages?.length, pending, emojiOpen, conversationId]);

  /**
   * Images/videos have no height until they decode, so a thread ending with
   * media used to stop short of the last message. Observing the content box
   * re-pins the view every time it grows while the operator is at the bottom.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToEnd();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };


  const name = conversation
    ? contactDisplayName(conversation.contacts, conversation.id, displayT, conversation.visitor_country_name, locale)
    : '';

  const handleSend = () => {
    const body = draft.trim();
    const attachmentId = pending?.id ?? null;
    if ((!body && !attachmentId) || sendMessage.isPending || pending?.uploading) return;
    setDraft('');
    clearPending();
    sendMessage.mutate({ body, attachmentId });
  };

  const insertEmoji = (emoji: string) => {
    setDraft((d) => d + emoji);
    setEmojiOpen(false);
    // Bring the keyboard straight back so typing continues naturally.
    window.setTimeout(() => textRef.current?.focus(), 0);
  };

  const BackIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const isResolved = conversation?.status === 'resolved' || conversation?.status === 'closed';
  const isOnline = conversation?.visitor_status === 'online' || conversation?.contacts?.is_online;
  const canSend = !!(draft.trim() || pending?.id) && !pending?.uploading;

  const list = messages ?? [];

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-muted/40">
      {/* Nav bar — back button, then the visitor profile right beside it */}
      <header className="shrink-0 flex items-center gap-1 bg-card/90 px-1.5 pt-[env(safe-area-inset-top)] pb-1.5 shadow-[0_1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl">
        <button
          type="button"
          onClick={() => navigate(`/${slug}/inbox`)}
          className="shrink-0 rounded-full p-1 text-primary transition-transform active:scale-90"
          aria-label="Back"
        >
          <BackIcon className="h-[26px] w-[26px]" />
        </button>

        <button
          type="button"
          onClick={() =>
            conversation?.contacts?.id && navigate(`/${slug}/contacts/${conversation.contacts.id}`)
          }
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-0.5 py-0.5 text-start active:opacity-70"
        >
          <span className="relative shrink-0">
            <ContactAvatar
              name={conversation?.contacts?.name}
              email={conversation?.contacts?.email}
              avatarUrl={conversation?.contacts?.avatar_url}
              os={conversation?.visitor_os ?? conversation?.contacts?.metadata?.os}
              device={conversation?.visitor_device ?? conversation?.contacts?.metadata?.device}
              countryCode={conversation?.visitor_country_code}
              countryName={conversation?.visitor_country_name}
              size="sm"
            />
            {isOnline && (
              <span className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-card" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold leading-tight text-foreground">
              {name || '…'}
            </span>
            {conversation?.contacts?.email && (
              // `plaintext` keeps the address itself LTR while the line stays
              // aligned to the reading direction (right, under the name, in fa).
              <span
                className="block truncate text-start text-[10.5px] leading-tight text-muted-foreground"
                style={{ unicodeBidi: 'plaintext' }}
              >
                {conversation.contacts.email}
              </span>
            )}
          </span>

        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary transition-transform active:scale-90 active:bg-muted"
              aria-label="Actions"
            >
              <MoreHorizontal className="h-[22px] w-[22px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 rounded-2xl">
            {conversation?.contacts?.id && (
              <DropdownMenuItem
                onClick={() => navigate(`/${slug}/contacts/${conversation.contacts.id}`)}
              >
                <User className="me-2 h-4 w-4" /> {t('nav.profile')}
              </DropdownMenuItem>
            )}
            {conversationId && (
              <DropdownMenuItem
                onClick={() =>
                  updateConversation.mutate({
                    id: conversationId,
                    workspace_id: workspace!.id,
                    status: isResolved ? 'open' : 'resolved',
                  })
                }
              >
                {isResolved ? (
                  <>
                    <RotateCcw className="me-2 h-4 w-4" /> {t('inbox.reopen')}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="me-2 h-4 w-4" /> {t('inbox.resolve')}
                  </>
                )}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Messages */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      >
        <div ref={contentRef} className="px-3 py-4 space-y-1.5">

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-14 rounded-3xl', i % 2 ? 'w-2/3 ms-auto' : 'w-1/2')} />
            ))}
          </div>
        ) : (
          (list as unknown as TimelineMessage[]).map((m, i) => {
            const isOutbound = m.sender_type === 'agent' || m.sender_type === 'ai' || m.sender_type === 'bot';
            const prev = (list as unknown as TimelineMessage[])[i - 1];
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
                {/* Operator bubbles sit on the reading-direction START side
                    (right in Persian), visitor bubbles on the END side. */}
                <div className={cn('flex', isOutbound ? 'justify-start' : 'justify-end')}>
                  <div
                    className={cn(
                      'max-w-[82%] px-3.5 py-2 shadow-[0_1px_2px_hsl(220_40%_20%/0.08)]',
                      isOutbound
                        ? 'rounded-[20px] rounded-es-[6px] bg-primary/15 text-foreground'
                        : 'rounded-[20px] rounded-ee-[6px] bg-card text-foreground',
                    )}
                  >
                    {m.sender_type === 'ai' && (
                      <span className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-primary">
                        <Bot className="h-3.5 w-3.5" /> AI
                      </span>
                    )}
                    {atts.length > 0 && (
                      <div className="mb-1 space-y-1">
                        {atts.map((att) => (
                          <MessageAttachmentView key={att.id} att={att} t={displayT} isAgent={isOutbound} />
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

        {/* Pending attachment: previewed as an outgoing bubble, uploading in
            place, with its own send button. */}
        {pending && (
          <div className="flex justify-start pt-1">
            <div className="relative max-w-[70%] overflow-hidden rounded-[20px] rounded-es-[6px] bg-primary/15 p-1.5 shadow-[0_1px_2px_hsl(220_40%_20%/0.08)]">
              {pending.isImage && pending.previewUrl ? (
                <img
                  src={pending.previewUrl}
                  alt={pending.name}
                  className="max-h-56 w-full rounded-[15px] object-cover"
                />
              ) : (
                <div className="flex items-center gap-2 px-2 py-2 text-[13px]">
                  <FileText className="h-5 w-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{pending.name}</span>
                </div>
              )}

              {pending.uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/55 backdrop-blur-[2px]">
                  <Loader2 className="h-7 w-7 animate-spin text-primary" />
                </div>
              )}

              <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                <button
                  type="button"
                  onClick={clearPending}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground active:scale-90"
                  aria-label="Remove attachment"
                >
                  <X className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!pending.id || sendMessage.isPending}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-all active:scale-95',
                    pending.id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Send className="h-3.5 w-3.5 rtl:-scale-x-100" />
                  {t('inbox.send')}
                </button>
              </div>
            </div>
          </div>
        )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer + emoji panel — flush on the keyboard */}
      <div
        className="shrink-0 bg-card/95 shadow-[0_-1px_0_0_hsl(var(--border)/0.7)] backdrop-blur-2xl"
        style={{
          // The keyboard height lifts the whole bar; when the emoji panel is
          // open the keyboard is dismissed and the panel takes its place.
          marginBottom: 'var(--kb-inset, 0px)',
          paddingBottom: emojiOpen
            ? 'env(safe-area-inset-bottom)'
            : 'calc(2px + max(0px, env(safe-area-inset-bottom) - var(--kb-inset, 0px)))',
        }}
      >
        {recorder.recording ? (
          <div className="flex items-center gap-2 px-2 pt-1.5">
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
          <div className="flex items-end gap-1 px-2 pt-1.5">
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
            {canAttach && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground active:scale-90"
                aria-label="Attach file"
              >
                <Paperclip className="h-[22px] w-[22px]" />
              </button>
            )}

            {/* Everything else lives INSIDE the message field. */}
            <div className="flex min-h-[44px] flex-1 items-end gap-0.5 rounded-[22px] bg-muted/70 px-1.5 py-1 focus-within:bg-muted">
              {canRecordVoice && (
                <button
                  type="button"
                  onClick={toggleRecording}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-transform active:scale-90"
                  aria-label="Record voice message"
                >
                  <Mic className="h-[21px] w-[21px]" />
                </button>
              )}

              <textarea
                ref={textRef}
                value={draft}
                onFocus={() => setEmojiOpen(false)}
                onChange={(e) => setDraft(e.target.value)}
                rows={1}
                placeholder={t('inbox.typeMessage')}
                className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-1 py-2 text-[16px] leading-tight text-foreground outline-none placeholder:text-muted-foreground"
              />

              <button
                type="button"
                onClick={() => {
                  if (!emojiOpen) textRef.current?.blur();
                  setEmojiOpen((v) => !v);
                }}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors active:scale-90',
                  emojiOpen ? 'text-primary' : 'text-muted-foreground',
                  !canUseEmoji && 'hidden',
                )}
                aria-label="Emoji"
              >
                <Smile className="h-[21px] w-[21px]" />
              </button>

              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend || sendMessage.isPending}
                aria-label={t('inbox.send')}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-90',
                  canSend
                    ? 'bg-primary text-primary-foreground shadow-md'
                    : 'bg-transparent text-muted-foreground',
                )}
              >
                {sendMessage.isPending ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin" />
                ) : (
                  <Send className="h-[18px] w-[18px] rtl:-scale-x-100" />
                )}
              </button>
            </div>
          </div>
        )}

        {emojiOpen && canUseEmoji && !recorder.recording && <MobileEmojiPicker onPick={insertEmoji} />}
      </div>
    </div>
  );
}
