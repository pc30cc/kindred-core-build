import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { formatDistanceToNow } from 'date-fns';
import { Mail, Star, Paperclip, Send, X, RefreshCw, Loader2, AlertCircle, CheckCircle2, Clock, Search } from 'lucide-react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import RichTextEditor from '@/components/app/knowledge/RichTextEditor';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  useEmailThreads,
  useEmailThread,
  useSetEmailThreadRead,
  useSetEmailThreadStarred,
  useSendEmail,
  useGmailConnection,
  useStartGmailOAuth,
} from '@/hooks/useEmailInbox';
import { uploadEmailAttachment, type StagedEmailAttachment, type EmailMessageView } from '@/lib/emailInbox-api';

function initialsOf(address: string): string {
  const name = address.split('@')[0] || '?';
  return name.slice(0, 2).toUpperCase();
}

function formatAddresses(list: Array<{ email: string }>): string {
  return list.map((a) => a.email).join(', ');
}

// ─── Connect gate ───────────────────────────────────────────────────────

function ConnectGmailCard({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const startOAuth = useStartGmailOAuth(workspaceId);

  const handleConnect = async () => {
    try {
      const result = await startOAuth.mutateAsync();
      window.location.href = result.url;
    } catch {
      toast({ title: t('emailInbox.connectFailed' as any), variant: 'destructive' });
    }
  };

  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
        <Mail className="h-8 w-8" />
      </div>
      <div className="max-w-md space-y-1.5">
        <h2 className="text-lg font-semibold text-foreground">{t('emailInbox.connectTitle' as any)}</h2>
        <p className="text-sm text-muted-foreground">{t('emailInbox.connectDescription' as any)}</p>
      </div>
      <Button onClick={handleConnect} disabled={startOAuth.isPending} size="lg" className="gap-2">
        {startOAuth.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        {t('emailInbox.connectGmail' as any)}
      </Button>
    </div>
  );
}

// ─── Thread list ────────────────────────────────────────────────────────

function ThreadListItem({
  thread, active, onClick,
}: {
  thread: { id: string; subject: string | null; participants: Array<{ email: string }>; lastMessageAt: string | null; isRead: boolean; isStarred: boolean; lastMessageSnippet: string | null };
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const firstParticipant = thread.participants[0]?.email || t('emailInbox.unknownSender' as any);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-start transition-colors hover:bg-accent/50',
        active && 'bg-accent',
        !thread.isRead && 'bg-primary/[0.03]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 truncate text-sm', !thread.isRead ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>
          {firstParticipant}
        </span>
        {thread.isStarred && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
        <span className="shrink-0 text-xs text-muted-foreground">
          {thread.lastMessageAt ? formatDistanceToNow(new Date(thread.lastMessageAt), { addSuffix: false }) : ''}
        </span>
      </div>
      <div className={cn('truncate text-sm', !thread.isRead ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {thread.subject || t('emailInbox.noSubject' as any)}
      </div>
      {thread.lastMessageSnippet && (
        <div className="truncate text-xs text-muted-foreground">{thread.lastMessageSnippet}</div>
      )}
    </button>
  );
}

function ThreadList({
  workspaceId, activeThreadId, onSelect,
}: { workspaceId: string; activeThreadId: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading, refetch, isFetching } = useEmailThreads(workspaceId, { q: search || undefined, unread: unreadOnly || undefined });
  const threads = data?.threads ?? [];

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-e border-border">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('emailInbox.searchPlaceholder' as any)}
            className="h-8 ps-8 text-sm"
          />
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        <Badge
          variant={unreadOnly ? 'default' : 'outline'}
          className="cursor-pointer text-xs"
          onClick={() => setUnreadOnly((v) => !v)}
        >
          {t('emailInbox.unreadFilter' as any)}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{t('emailInbox.noThreads' as any)}</div>
        ) : (
          threads.map((thread) => (
            <ThreadListItem key={thread.id} thread={thread} active={thread.id === activeThreadId} onClick={() => onSelect(thread.id)} />
          ))
        )}
      </ScrollArea>
    </div>
  );
}

// ─── Message body ───────────────────────────────────────────────────────

function MessageBody({ message }: { message: EmailMessageView }) {
  const sanitizedHtml = useMemo(
    () => (message.htmlBody ? DOMPurify.sanitize(message.htmlBody, { ADD_ATTR: ['target'] }) : null),
    [message.htmlBody],
  );
  if (sanitizedHtml) {
    return <div className="prose prose-sm max-w-none dark:prose-invert" dir="auto" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
  }
  return <div className="whitespace-pre-wrap text-sm text-foreground" dir="auto">{message.textBody}</div>;
}

function DeliveryStatusBadge({ message }: { message: EmailMessageView }) {
  const { t } = useTranslation();
  if (message.direction !== 'outbound') return null;
  if (message.deliveryStatus === 'queued') {
    return <Badge variant="outline" className="gap-1 text-xs"><Clock className="h-3 w-3" />{t('emailInbox.statusQueued' as any)}</Badge>;
  }
  if (message.deliveryStatus === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1 text-xs" title={message.deliveryError || undefined}>
        <AlertCircle className="h-3 w-3" />{t('emailInbox.statusFailed' as any)}
      </Badge>
    );
  }
  return <Badge variant="outline" className="gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" />{t('emailInbox.statusSent' as any)}</Badge>;
}

function MessageCard({ message, defaultOpen }: { message: EmailMessageView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-4 py-3 text-start">
        <Avatar className="h-8 w-8 shrink-0">
          <AvatarFallback className="text-xs">{initialsOf(message.fromAddress)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{message.fromAddress}</span>
            <DeliveryStatusBadge message={message} />
            <span className="ms-auto shrink-0 text-xs text-muted-foreground">{new Date(message.sentAt).toLocaleString()}</span>
          </div>
          {!open && <div className="mt-0.5 truncate text-xs text-muted-foreground">{message.snippet}</div>}
          {open && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {formatAddresses(message.toAddresses)}
              {message.ccAddresses.length > 0 && ` · Cc: ${formatAddresses(message.ccAddresses)}`}
            </div>
          )}
        </div>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">
          <MessageBody message={message} />
          {message.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((att) => (
                <a
                  key={att.id}
                  href={att.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground hover:bg-secondary"
                >
                  <Paperclip className="h-3 w-3" />
                  {att.filename}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reply composer (inline, bottom of thread) ─────────────────────────

function ReplyComposer({
  workspaceId, threadId, defaultTo, defaultSubject,
}: { workspaceId: string; threadId: string; defaultTo: string[]; defaultSubject: string }) {
  const { t } = useTranslation();
  const [html, setHtml] = useState('');
  const [attachments, setAttachments] = useState<StagedEmailAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendEmailMutation = useSendEmail(workspaceId);

  const plainText = useMemo(() => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), [html]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const staged = await Promise.all(Array.from(files).map((f) => uploadEmailAttachment(workspaceId, f)));
      setAttachments((prev) => [...prev, ...staged]);
    } catch {
      toast({ title: t('emailInbox.attachmentUploadFailed' as any), variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const handleSend = async () => {
    if (!plainText) return;
    try {
      await sendEmailMutation.mutateAsync({
        threadId,
        to: defaultTo,
        subject: defaultSubject,
        textBody: plainText,
        htmlBody: html,
        attachments,
      });
      setHtml('');
      setAttachments([]);
      toast({ title: t('emailInbox.sent' as any) });
    } catch {
      toast({ title: t('emailInbox.sendFailed' as any), variant: 'destructive' });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {t('emailInbox.replyingTo' as any)} {defaultTo.join(', ')}
      </div>
      <RichTextEditor value={html} onChange={setHtml} placeholder={t('emailInbox.replyPlaceholder' as any)} minHeightClassName="min-h-[120px]" />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {attachments.map((att, i) => (
            <span key={i} className="flex items-center gap-1 rounded-md bg-secondary/60 px-2 py-1 text-xs">
              <Paperclip className="h-3 w-3" />
              {att.filename}
              <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
          {t('emailInbox.attach' as any)}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleSend} disabled={!plainText || sendEmailMutation.isPending}>
          {sendEmailMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {t('emailInbox.send' as any)}
        </Button>
      </div>
    </div>
  );
}

// ─── Thread view ────────────────────────────────────────────────────────

function ThreadView({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useEmailThread(workspaceId, threadId);
  const setRead = useSetEmailThreadRead(workspaceId);
  const setStarred = useSetEmailThreadStarred(workspaceId);

  useEffect(() => {
    if (data?.thread && !data.thread.isRead) {
      setRead.mutate({ threadId, isRead: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, data?.thread?.isRead]);

  if (isLoading || !data) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const { thread, messages } = data;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const replyTo = lastInbound ? [lastInbound.fromAddress] : (thread.participants[0] ? [thread.participants[0].email] : []);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{thread.subject || t('emailInbox.noSubject' as any)}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setStarred.mutate({ threadId, starred: !thread.isStarred })}
        >
          <Star className={cn('h-4 w-4', thread.isStarred && 'fill-amber-400 text-amber-400')} />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-2 p-4">
          {messages.map((message, i) => (
            <MessageCard key={message.id} message={message} defaultOpen={i === messages.length - 1} />
          ))}
        </div>
      </ScrollArea>
      {replyTo.length > 0 && (
        <div className="p-4 pt-0">
          <ReplyComposer workspaceId={workspaceId} threadId={threadId} defaultTo={replyTo} defaultSubject={thread.subject || ''} />
        </div>
      )}
    </div>
  );
}

// ─── Compose (new thread) dialog ────────────────────────────────────────

function ComposeDialog({ workspaceId, open, onOpenChange }: { workspaceId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const sendEmailMutation = useSendEmail(workspaceId);

  const plainText = useMemo(() => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), [html]);
  const toList = useMemo(() => to.split(',').map((s) => s.trim()).filter(Boolean), [to]);

  const handleSend = async () => {
    if (!toList.length || !subject.trim() || !plainText) return;
    try {
      await sendEmailMutation.mutateAsync({ to: toList, subject: subject.trim(), textBody: plainText, htmlBody: html });
      setTo(''); setSubject(''); setHtml('');
      onOpenChange(false);
      toast({ title: t('emailInbox.sent' as any) });
    } catch {
      toast({ title: t('emailInbox.sendFailed' as any), variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('emailInbox.compose' as any)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('emailInbox.toPlaceholder' as any)} />
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('emailInbox.subjectPlaceholder' as any)} />
          <RichTextEditor value={html} onChange={setHtml} placeholder={t('emailInbox.bodyPlaceholder' as any)} minHeightClassName="min-h-[180px]" />
        </div>
        <DialogFooter>
          <Button
            onClick={handleSend}
            disabled={!toList.length || !subject.trim() || !plainText || sendEmailMutation.isPending}
            className="gap-1.5"
          >
            {sendEmailMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t('emailInbox.send' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page shell ─────────────────────────────────────────────────────────

export default function EmailInboxPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const { threadId } = useParams<{ threadId?: string }>();
  const [composeOpen, setComposeOpen] = useState(false);

  const { data: connectionData, isLoading: connectionLoading } = useGmailConnection(workspaceId);

  if (!workspaceId || connectionLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (!connectionData?.connection.connected) {
    return <ConnectGmailCard workspaceId={workspaceId} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{connectionData.connection.emailAddress}</span>
        <Button size="sm" className="ms-auto gap-1.5" onClick={() => setComposeOpen(true)}>
          <Send className="h-3.5 w-3.5" />
          {t('emailInbox.compose' as any)}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <ThreadList
          workspaceId={workspaceId}
          activeThreadId={threadId || null}
          onSelect={(id) => navigate(wsPath(`/email/${id}`))}
        />
        {threadId ? (
          <ThreadView workspaceId={workspaceId} threadId={threadId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('emailInbox.selectThread' as any)}</div>
        )}
      </div>
      <ComposeDialog workspaceId={workspaceId} open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}
