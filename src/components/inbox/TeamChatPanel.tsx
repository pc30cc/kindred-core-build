/**
 * Colleagues — internal operator-to-operator chat inside the inbox.
 * Left: workspace operator directory (presence, unread, last message).
 * Right: 1:1 thread with the selected colleague.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Send, Users, MessageSquare, Loader2, ArrowLeft,
  Paperclip, Mic, Square, Trash2, FileText, ImageIcon, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/hooks/use-toast';
import { conversationsApi } from '@/lib/conversations-api';
import { EmojiPicker } from '@/components/inbox/EmojiPicker';
import { MessageAttachmentView, humanSize } from '@/components/inbox/MessageAttachmentView';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
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

const ALLOWED_TEAM_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
]);
const MAX_TEAM_BYTES = 25 * 1024 * 1024;

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: dirData, isLoading } = useColleagues(workspace?.id);
  const { data: presence } = useTeamPresence(workspace?.id);
  const pMap = useMemo(() => presenceMap(presence?.presence), [presence]);
  const { data: threadData, isLoading: threadLoading } = useTeamThread(workspace?.id, peerId);
  const send = useSendTeamMessage(workspace?.id);
  const markRead = useMarkTeamThreadRead(workspace?.id);
  const recorder = useVoiceRecorder();

  // ─── Pending attachment (single per draft, mirrors the Inbox composer) ───
  const [att, setAtt] = useState<{
    file: File | null;
    attachmentId: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: 'idle' | 'uploading' | 'ready' | 'error';
    progress: number;
    error: string;
  }>({
    file: null, attachmentId: null, fileName: '', mimeType: '',
    sizeBytes: 0, status: 'idle', progress: 0, error: '',
  });

  const resetAttachment = useCallback(() => {
    setAtt({
      file: null, attachmentId: null, fileName: '', mimeType: '',
      sizeBytes: 0, status: 'idle', progress: 0, error: '',
    });
  }, []);

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

  // Switching colleague drops any half-composed draft attachment.
  useEffect(() => { resetAttachment(); recorder.cancel(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [peerId]);

  /** Upload through the same authenticated operator attachment endpoints. */
  const beginUpload = useCallback(async (file: File) => {
    if (!workspace?.id) return;
    if (!ALLOWED_TEAM_MIMES.has(file.type)) {
      toast({
        title: t('inbox.attachInvalidType') || 'File type not allowed',
        description: file.type || 'unknown',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > MAX_TEAM_BYTES) {
      toast({
        title: t('inbox.attachTooLarge') || 'File too large',
        description: humanSize(MAX_TEAM_BYTES),
        variant: 'destructive',
      });
      return;
    }
    setAtt({
      file, attachmentId: null, fileName: file.name, mimeType: file.type,
      sizeBytes: file.size, status: 'uploading', progress: 5, error: '',
    });
    try {
      const init = await conversationsApi.initAttachment({
        workspace_id: workspace.id,
        conversation_id: null, // internal message — never bound to a visitor thread
        file,
      });
      setAtt((s) => ({ ...s, attachmentId: init.attachment_id, progress: 20 }));
      await conversationsApi.uploadAttachment({
        workspace_id: workspace.id,
        attachment_id: init.attachment_id,
        file,
        onProgress: (pct) => setAtt((s) => ({ ...s, progress: Math.max(s.progress, pct) })),
      });
      setAtt((s) => ({ ...s, status: 'ready', progress: 100 }));
    } catch (e: any) {
      setAtt((s) => ({ ...s, status: 'error', error: e?.message || 'Upload failed' }));
      toast({
        title: t('inbox.attachUploadFailed') || 'Upload failed',
        description: e?.message || '',
        variant: 'destructive',
      });
    }
  }, [workspace?.id, t]);

  const onFilePicked: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void beginUpload(file);
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    if (!el) { setDraft((d) => d + emoji); return; }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + emoji.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const stopAndSendVoice = async () => {
    const file = await recorder.stop();
    if (file) void beginUpload(file);
  };

  const hasAttachment = att.status === 'ready' && !!att.attachmentId;
  const sendDisabled = (!draft.trim() && !hasAttachment)
    || !peerId || send.isPending || att.status === 'uploading';

  const submit = () => {
    const body = draft.trim();
    if (!peerId || send.isPending) return;
    if (!body && !hasAttachment) return;
    const attachmentId = hasAttachment ? att.attachmentId : null;
    setDraft('');
    resetAttachment();
    send.mutate({ recipient_id: peerId, body, attachment_id: attachmentId });
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
            <div className="p-3 space-y-2" dir={dir}>
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
                          ? (c.last_message.outgoing ? `${t('inbox.you') || 'You'}: ` : '')
                            + (c.last_message.body
                              || (c.last_message.attachment_kind === 'image' ? (t('inbox.previewImage') || 'Photo')
                                : c.last_message.attachment_kind === 'audio' ? (t('inbox.previewAudio') || 'Voice message')
                                : c.last_message.attachment_kind === 'video' ? (t('inbox.previewVideo') || 'Video')
                                : c.last_message.attachment_kind ? (t('inbox.previewFile') || 'File')
                                : ''))
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
                            {/* Same media bubbles the Inbox renders — image
                                lightbox, voice player, file card — on both
                                sides of the thread. */}
                            {m.attachment && (
                              <div className={cn(m.body ? 'mb-1.5' : '')}>
                                <MessageAttachmentView att={m.attachment} t={t as any} isAgent={mine} />
                              </div>
                            )}
                            {!!m.body && (
                              <p className="whitespace-pre-wrap break-words" dir="auto">{m.body}</p>
                            )}
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
              <div className="max-w-3xl mx-auto">
                {/* Pending attachment chip */}
                {att.status !== 'idle' && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-2.5 py-2">
                    <div className="w-8 h-8 rounded-md bg-background flex items-center justify-center shrink-0 text-muted-foreground">
                      {att.mimeType.startsWith('image/') ? <ImageIcon className="w-4 h-4" />
                        : att.mimeType.startsWith('audio/') ? <Mic className="w-4 h-4" />
                        : <FileText className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-foreground truncate">{att.fileName}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                        <span>{humanSize(att.sizeBytes)}</span>
                        <span className="opacity-40">•</span>
                        <span className={cn(
                          att.status === 'error' ? 'text-destructive'
                            : att.status === 'ready' ? 'text-success' : 'text-muted-foreground',
                        )}>
                          {att.status === 'uploading' && (t('inbox.attachUploading') || 'Uploading…')}
                          {att.status === 'ready' && (t('inbox.attachReady') || 'Ready to send')}
                          {att.status === 'error' && (att.error || t('inbox.attachUploadFailed') || 'Upload failed')}
                        </span>
                      </div>
                      {att.status === 'uploading' && <Progress value={att.progress} className="h-1 mt-1.5" />}
                    </div>
                    {att.status === 'error' && att.file && (
                      <button
                        onClick={() => void beginUpload(att.file as File)}
                        className="text-[11px] font-medium text-primary hover:underline px-1.5"
                      >
                        {t('inbox.attachRetry') || 'Retry'}
                      </button>
                    )}
                    <button
                      onClick={resetAttachment}
                      className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      aria-label={t('inbox.attachRemove') || 'Remove'}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* Composer bar — same geometry as the Inbox composer. */}
                <div className={cn(
                  'relative flex gap-1 items-end rounded-xl border bg-background p-1.5 transition-shadow shadow-sm',
                  'border-border focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15',
                )}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,audio/*"
                    onChange={onFilePicked}
                  />

                  {recorder.recording ? (
                    <div className="flex-1 flex items-center gap-3 px-2 py-1.5" dir="ltr">
                      <span className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse shrink-0" />
                      <span className="text-[12px] tabular-nums text-foreground">{clock(recorder.seconds)}</span>
                      <span className="text-[11.5px] text-muted-foreground truncate">
                        {t('inbox.recording') || 'Recording voice message…'}
                      </span>
                      <button
                        type="button"
                        onClick={() => recorder.cancel()}
                        className="ms-auto h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-secondary transition-colors"
                        title={t('inbox.cancelRecording') || 'Discard'}
                        aria-label={t('inbox.cancelRecording') || 'Discard'}
                      >
                        <Trash2 className="w-[18px] h-[18px]" />
                      </button>
                      <Button
                        onClick={() => void stopAndSendVoice()}
                        className="h-9 gap-1.5 px-3 transition-transform active:scale-95"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                        {t('inbox.stopRecording') || 'Stop'}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={att.status === 'uploading'}
                        className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 self-center disabled:opacity-40 disabled:cursor-not-allowed"
                        title={t('inbox.attachFile') || 'Attach file'}
                        aria-label={t('inbox.attachFile') || 'Attach file'}
                      >
                        <Paperclip className="w-[18px] h-[18px]" />
                      </button>
                      <EmojiPicker onPick={insertEmoji} />
                      {recorder.supported && (
                        <button
                          onClick={() => void recorder.start()}
                          disabled={att.status === 'uploading'}
                          className="h-9 w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 self-center disabled:opacity-40 disabled:cursor-not-allowed"
                          title={t('inbox.recordVoice') || 'Record voice message'}
                          aria-label={t('inbox.recordVoice') || 'Record voice message'}
                        >
                          <Mic className="w-[18px] h-[18px]" />
                        </button>
                      )}
                      <textarea
                        ref={inputRef}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
                        }}
                        rows={1}
                        dir={dir}
                        placeholder={(t('inbox.messageColleague') || 'Message {{name}}').replace('{{name}}', peer.full_name || peer.email || '')}
                        className="flex-1 min-h-[36px] max-h-32 resize-none border-0 bg-transparent text-[14px] leading-relaxed focus:outline-none px-1.5 py-1.5"
                      />
                      <Button
                        onClick={submit}
                        disabled={sendDisabled}
                        title={t('inbox.send') || 'Send'}
                        aria-label={t('inbox.send') || 'Send'}
                        className="h-9 gap-1.5 px-3 shrink-0 transition-transform active:scale-95"
                      >
                        {send.isPending
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Send className={cn('w-4 h-4', dir === 'rtl' && 'rotate-180')} />}
                        <span className="hidden sm:inline text-[12.5px]">{t('inbox.send') || 'Send'}</span>
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>

          </>
        )}
      </div>
    </div>
  );
}
