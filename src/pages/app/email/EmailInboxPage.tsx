import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { Mail, Star, Paperclip, Send, X, RefreshCw, Loader2, AlertCircle, CheckCircle2, Clock, Search } from 'lucide-react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
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
  useYahooConnection,
  useStartYahooOAuth,
  useEmailMailboxSync,
  threadBodyVersion,
} from '@/hooks/useEmailInbox';
import { useAuth } from '@/features/auth/AuthContext';
import { emailCacheScope, clearWorkspaceEmailCache } from '@/lib/emailCache';
import { API_BASE } from '@/lib/apiBase';
import {
  uploadEmailAttachment,
  fileToBase64,
  type StagedEmailAttachment,
  type EmailMessageView,
  type EmailThreadSummary,
} from '@/lib/emailInbox-api';

// Stored addresses can be a raw header value ("Facebook <x@facebookmail.com>",
// quoted names included), so split out a display name before rendering.
function parseAddress(raw: string): { name: string; email: string } {
  const value = (raw || '').trim();
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const email = match[2].trim();
    return { name: match[1].trim() || email.split('@')[0], email };
  }
  return { name: value.split('@')[0] || value, email: value };
}

function initialsOf(raw: string): string {
  const { name } = parseAddress(raw);
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

const AVATAR_COLORS = [
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
];

function avatarColorOf(raw: string): string {
  const key = parseAddress(raw).email.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// Gmail snippets arrive HTML-escaped ("We&#39;re").
function decodeEntities(text: string): string {
  if (!text || !text.includes('&')) return text;
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

function formatListDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    locale,
    sameDay ? { hour: '2-digit', minute: '2-digit' } : sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(date);
}

function formatAddresses(list: Array<{ email: string }>): string {
  return list.map((a) => parseAddress(a.email).name).join(', ');
}

// ─── Connect gate ───────────────────────────────────────────────────────
//
// Offers whichever provider(s) the platform has configured — a workspace
// connects at most one at a time in this feature's current shape (see
// server/services/email/inbox.ts's resolveConnectedIntegration), so once
// either succeeds the page re-renders straight into the inbox.

function ConnectEmailCard({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const startGmailOAuth = useStartGmailOAuth(workspaceId);
  const startYahooOAuth = useStartYahooOAuth(workspaceId);
  const { data: yahooConnection } = useYahooConnection(workspaceId);

  const handleConnectGmail = async () => {
    try {
      const result = await startGmailOAuth.mutateAsync();
      window.location.href = result.url;
    } catch {
      toast({ title: t('emailInbox.connectFailed' as any), variant: 'destructive' });
    }
  };

  const handleConnectYahoo = async () => {
    try {
      const result = await startYahooOAuth.mutateAsync();
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
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={handleConnectGmail} disabled={startGmailOAuth.isPending} size="lg" className="gap-2">
          {startGmailOAuth.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
          {t('emailInbox.connectGmail' as any)}
        </Button>
        {yahooConnection?.platformConfigured && (
          <Button onClick={handleConnectYahoo} disabled={startYahooOAuth.isPending} size="lg" variant="outline" className="gap-2">
            {startYahooOAuth.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {t('emailInbox.connectYahoo' as any)}
          </Button>
        )}
      </div>
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
  const { t, locale } = useTranslation();
  const raw = thread.participants[0]?.email || '';
  const sender = raw ? parseAddress(raw) : { name: t('emailInbox.unknownSender' as any), email: '' };
  const unread = !thread.isRead;
  return (
    <button
      type="button"
      onClick={onClick}
      title={sender.email}
      className={cn(
        'relative flex w-full min-w-0 items-start gap-3 border-b border-border/60 px-3 py-3 text-start transition-colors hover:bg-accent/60',
        active && 'bg-accent',
      )}
    >
      {unread && <span className="absolute start-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary" />}
      <Avatar className="mt-0.5 h-9 w-9 shrink-0">
        <AvatarFallback className={cn('text-xs font-semibold', avatarColorOf(raw || '?'))}>{initialsOf(raw || '?')}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span dir="auto" className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold text-foreground' : 'text-foreground/85')}>
            {sender.name}
          </span>
          {thread.isStarred && <Star className="h-3.5 w-3.5 shrink-0 self-center fill-amber-400 text-amber-400" />}
          <span className={cn('shrink-0 text-[11px] tabular-nums', unread ? 'font-medium text-primary' : 'text-muted-foreground')}>
            {formatListDate(thread.lastMessageAt, locale)}
          </span>
        </div>
        <div dir="auto" className={cn('truncate text-[13px]', unread ? 'font-medium text-foreground' : 'text-foreground/75')}>
          {thread.subject || t('emailInbox.noSubject' as any)}
        </div>
        {thread.lastMessageSnippet && (
          <div dir="auto" className="line-clamp-1 break-all text-xs text-muted-foreground">{decodeEntities(thread.lastMessageSnippet)}</div>
        )}
      </div>
    </button>
  );
}

function ThreadListSkeleton() {
  return (
    <div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 border-b border-border/60 px-3 py-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="flex gap-2"><Skeleton className="h-3.5 flex-1" /><Skeleton className="h-3 w-10" /></div>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadList({
  workspaceId, scope, activeThreadId, onSelect, onRows,
}: {
  workspaceId: string;
  scope: string | null;
  activeThreadId: string | null;
  onSelect: (thread: EmailThreadSummary) => void;
  onRows: (threads: EmailThreadSummary[]) => void;
}) {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  // Each keystroke would be a Gmail search; wait for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const { data, isLoading, isError, refetch, isFetching, isPlaceholderData, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useEmailThreads(workspaceId, scope, { q: search || undefined, unread: unreadOnly || undefined });
  const threads = useMemo(() => data?.pages.flatMap((p) => p.threads) ?? [], [data]);
  // Showing this device's copy while Gmail's current page loads.
  const syncing = isPlaceholderData || (isFetching && !isFetchingNextPage);
  useEffect(() => {
    onRows(threads);
  }, [threads, onRows]);

  return (
    <div className="flex h-full w-[360px] min-w-0 shrink-0 flex-col border-e border-border">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
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
        {syncing && threads.length > 0 && (
          <span className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('emailInbox.syncing' as any)}
          </span>
        )}
      </div>
      {/* Radix's viewport wraps children in a display:table div, which lets long
          rows overflow instead of truncating; force it back to block. */}
      <ScrollArea className="flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        {isLoading && threads.length === 0 ? (
          <ThreadListSkeleton />
        ) : isError && threads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <AlertCircle className="h-5 w-5 text-destructive" />
            {t('emailInbox.loadFailed' as any)}
            <Button variant="outline" size="sm" onClick={() => refetch()}>{t('emailInbox.retry' as any)}</Button>
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{t('emailInbox.noThreads' as any)}</div>
        ) : (
          <>
            {threads.map((thread) => (
              <ThreadListItem key={thread.id} thread={thread} active={thread.id === activeThreadId} onClick={() => onSelect(thread)} />
            ))}
            {hasNextPage && (
              <div className="p-3">
                <Button variant="ghost" size="sm" className="w-full gap-1.5" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('emailInbox.loadMore' as any)}
                </Button>
              </div>
            )}
          </>
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
          <AvatarFallback className={cn('text-xs font-semibold', avatarColorOf(message.fromAddress))}>{initialsOf(message.fromAddress)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span dir="auto" className="truncate text-sm font-medium text-foreground">{parseAddress(message.fromAddress).name}</span>
            <span dir="ltr" className="hidden truncate text-xs text-muted-foreground sm:inline">{parseAddress(message.fromAddress).email}</span>
            <DeliveryStatusBadge message={message} />
            <span className="ms-auto shrink-0 text-xs text-muted-foreground">{new Date(message.sentAt).toLocaleString()}</span>
          </div>
          {!open && <div dir="auto" className="mt-0.5 truncate text-xs text-muted-foreground">{decodeEntities(message.snippet || '')}</div>}
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
                  href={att.downloadPath ? `${API_BASE || ''}${att.downloadPath}` : (att.url || '#')}
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

type ComposerAttachment = { filename: string; staged?: StagedEmailAttachment; file?: File };

function ReplyComposer({
  workspaceId, scope, live, threadId, defaultTo, defaultSubject,
}: { workspaceId: string; scope: string | null; live: boolean; threadId: string; defaultTo: string[]; defaultSubject: string }) {
  const { t } = useTranslation();
  const [html, setHtml] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendEmailMutation = useSendEmail(workspaceId, scope);

  const plainText = useMemo(() => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), [html]);

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    // A live (Gmail) inbox stores nothing: files stay in the browser and go
    // out with the reply itself.
    if (live) {
      setAttachments((prev) => [...prev, ...Array.from(files).map((file) => ({ filename: file.name, file }))]);
      return;
    }
    setUploading(true);
    try {
      const staged = await Promise.all(Array.from(files).map((f) => uploadEmailAttachment(workspaceId, f)));
      setAttachments((prev) => [...prev, ...staged.map((a) => ({ filename: a.filename, staged: a }))]);
    } catch {
      toast({ title: t('emailInbox.attachmentUploadFailed' as any), variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const [sending, setSending] = useState(false);
  const handleSend = async () => {
    // Reading attachments happens before the request starts, so the
    // mutation's own pending flag would leave a window for a second click.
    if (!plainText || sending) return;
    setSending(true);
    try {
      await sendEmailMutation.mutateAsync({
        threadId,
        to: defaultTo,
        subject: defaultSubject,
        textBody: plainText,
        htmlBody: html,
        attachments: attachments.flatMap((a) => (a.staged ? [a.staged] : [])),
        inlineAttachments: await Promise.all(
          attachments.flatMap((a) => (a.file ? [a.file] : [])).map(async (file) => ({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            dataBase64: await fileToBase64(file),
          })),
        ),
      });
      setHtml('');
      setAttachments([]);
      toast({ title: t('emailInbox.sent' as any) });
    } catch {
      toast({ title: t('emailInbox.sendFailed' as any), variant: 'destructive' });
    } finally {
      setSending(false);
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
        <Button size="sm" className="gap-1.5" onClick={handleSend} disabled={!plainText || sending}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {t('emailInbox.send' as any)}
        </Button>
      </div>
    </div>
  );
}

// ─── Thread view ────────────────────────────────────────────────────────

function ThreadView({
  workspaceId, scope, live, threadId, row,
}: {
  workspaceId: string;
  scope: string | null;
  live: boolean;
  threadId: string;
  row: { isRead: boolean; isStarred: boolean; version: string | null } | null;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useEmailThread(workspaceId, scope, threadId, row);
  const setRead = useSetEmailThreadRead(workspaceId, scope);
  const setStarred = useSetEmailThreadStarred(workspaceId, scope);

  useEffect(() => {
    if (data?.thread && !data.thread.isRead) {
      setRead.mutate({ threadId, isRead: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, data?.thread?.isRead]);

  if (isLoading || !data) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex items-center gap-3"><Skeleton className="h-8 w-8 rounded-full" /><Skeleton className="h-4 w-48" /></div>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  const { thread, messages } = data;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const replyTo = lastInbound ? [parseAddress(lastInbound.fromAddress).email] : (thread.participants[0] ? [parseAddress(thread.participants[0].email).email] : []);

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
          <ReplyComposer workspaceId={workspaceId} scope={scope} live={live} threadId={threadId} defaultTo={replyTo} defaultSubject={thread.subject || ''} />
        </div>
      )}
    </div>
  );
}

// ─── Compose (new thread) dialog ────────────────────────────────────────

function ComposeDialog({ workspaceId, scope, open, onOpenChange }: { workspaceId: string; scope: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const sendEmailMutation = useSendEmail(workspaceId, scope);

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
  const { user } = useAuth();
  // The list's current rows: an open thread takes its cache version and
  // read/star flags from its row, so it follows list refreshes.
  const [rows, setRows] = useState<Map<string, EmailThreadSummary>>(() => new Map());
  const onRows = useCallback((threads: EmailThreadSummary[]) => {
    setRows(new Map(threads.map((t) => [t.id, t])));
  }, []);

  const { data: gmailConnectionData, isLoading: gmailConnectionLoading } = useGmailConnection(workspaceId);
  const { data: yahooConnectionData, isLoading: yahooConnectionLoading } = useYahooConnection(workspaceId);

  // A workspace connects at most one provider at a time today; Gmail wins the
  // (currently impossible) tie-break. A connected Gmail inbox is read live.
  const gmailConnected = !!gmailConnectionData?.connection.connected;
  const connectedAccount = gmailConnected
    ? gmailConnectionData?.connection.emailAddress ?? null
    : yahooConnectionData?.connection.connected
      ? yahooConnectionData.connection.emailAddress
      : null;
  // Only the live (Gmail) inbox keeps a device cache; Yahoo reads the server.
  const scope = gmailConnected && user?.id && workspaceId && connectedAccount
    ? emailCacheScope(user.id, workspaceId, connectedAccount)
    : null;
  useEmailMailboxSync(workspaceId, scope);

  // Keep only the connected mailbox's copy on this device: a disconnect (seen
  // from any device), a revoked grant or a different mailbox drops the rest.
  const connectionsLoaded = !!workspaceId && !gmailConnectionLoading && !yahooConnectionLoading;
  useEffect(() => {
    if (connectionsLoaded && workspaceId) void clearWorkspaceEmailCache(workspaceId, scope);
  }, [connectionsLoaded, workspaceId, scope]);

  const openRow = threadId ? rows.get(threadId) : undefined;
  const openRowView = useMemo(
    () => (openRow ? { isRead: openRow.isRead, isStarred: openRow.isStarred, version: threadBodyVersion(openRow) } : null),
    [openRow],
  );

  if (!workspaceId || gmailConnectionLoading || yahooConnectionLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (!connectedAccount) {
    return <ConnectEmailCard workspaceId={workspaceId} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{connectedAccount}</span>
        <Button size="sm" className="ms-auto gap-1.5" onClick={() => setComposeOpen(true)}>
          <Send className="h-3.5 w-3.5" />
          {t('emailInbox.compose' as any)}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <ThreadList
          workspaceId={workspaceId}
          scope={scope}
          activeThreadId={threadId || null}
          onSelect={(thread) => navigate(wsPath(`/email/${thread.id}`))}
          onRows={onRows}
        />
        {threadId ? (
          <ThreadView
            key={threadId}
            workspaceId={workspaceId}
            scope={scope}
            live={gmailConnected}
            threadId={threadId}
            row={openRowView}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('emailInbox.selectThread' as any)}</div>
        )}
      </div>
      <ComposeDialog workspaceId={workspaceId} scope={scope} open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}
