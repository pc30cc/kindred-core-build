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
  // Live inbox: showing this device's copy while Gmail's current page loads.
  // (Yahoo's background polls are not worth a label.)
  const syncing = !!scope && (isPlaceholderData || (isFetching && !isFetchingNextPage));
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

// ─── Message pieces ──────────────────────────────────────────────────────

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
  // One id per reply, kept across retries until it goes out, so a retry after
  // a timeout cannot send it twice.
  const requestIdRef = useRef<string>(crypto.randomUUID());
  const handleSend = async () => {
    // Reading attachments happens before the request starts, so the
    // mutation's own pending flag would leave a window for a second click.
    if (!plainText || sending) return;
    setSending(true);
    try {
      await sendEmailMutation.mutateAsync({
        clientRequestId: requestIdRef.current,
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
      requestIdRef.current = crypto.randomUUID();
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

// ─── Thread reader ──────────────────────────────────────────────────────
//
// The same shape as the Windows app's reader: the thread as one white page
// in an isolated frame (no scripts, email styles cannot leak into the app or
// the app's into the email), the latest message's body first (its header is
// drawn above the frame), then the earlier ones newest first, each a folded
// card that opens on a click.

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PERSON_PATH = 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z';
const TINTS = ['#e0565b', '#e0913a', '#2f9e6a', '#2f86d6', '#6a5ae0', '#c450b8'];

function tintOf(raw: string): string {
  const key = parseAddress(raw).email.toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

function fullDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function attachmentHref(att: EmailMessageView['attachments'][number]): string {
  const path = att.downloadPath || att.url || '';
  if (!path) return '#';
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE || window.location.origin}${path}`;
}

function bodyHtml(m: EmailMessageView, t: (k: string) => string): string {
  const parts: string[] = ['<div class="b" dir="auto">'];
  if (m.htmlBody && m.htmlBody.trim()) {
    parts.push(DOMPurify.sanitize(m.htmlBody, { FORCE_BODY: true, ADD_ATTR: ['target'], FORBID_TAGS: ['form', 'input', 'button'] }));
  } else {
    parts.push('<pre>', escapeHtml(m.textBody || m.snippet || ''), '</pre>');
  }
  parts.push('</div>');
  if (m.attachments.length) {
    parts.push('<div class="files">');
    for (const a of m.attachments) {
      parts.push(`<a class="file" dir="auto" href="${escapeHtml(attachmentHref(a))}">📎 ${escapeHtml(a.filename || t('emailInbox.attach'))}</a>`);
    }
    parts.push('</div>');
  }
  if (m.deliveryError) parts.push(`<div class="err" dir="auto">${escapeHtml(m.deliveryError)}</div>`);
  return parts.join('');
}

function readerDocument(messages: EmailMessageView[], dir: string, locale: string, t: (k: string) => string): string {
  const css = [
    'html,body{background:#ffffff}',
    "body{margin:0;padding:14px 18px 20px;font-family:'Segoe UI Variable Text','Segoe UI',Vazirmatn,Tahoma,system-ui,sans-serif;font-size:14px;line-height:1.55;color:#1f2633}",
    '.b{overflow-wrap:anywhere}.b img{max-width:100%;height:auto}.b table{max-width:100%}pre{white-space:pre-wrap;font-family:inherit;margin:0}',
    'a{color:#2f6ae0}',
    '.err{margin-top:12px;padding:8px 12px;border-radius:8px;background:#fdecec;color:#c62f35;font-size:12.5px}',
    '.earlier{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}',
    '.et{font-size:12px;font-weight:600;color:#6b7485;margin:0 2px 10px}',
    'details{border:1px solid #e3e7ee;border-radius:12px;margin-bottom:10px;background:#f8f9fb;overflow:hidden}',
    'details[open]{background:#ffffff}',
    'summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 14px}',
    'summary::-webkit-details-marker{display:none}',
    'summary:hover{background:#eef2f8}',
    '.av{flex:none;position:relative;width:30px;height:30px;border-radius:50%;background:#eef1f5;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.av i{position:absolute;inset:0;border-radius:50%;opacity:.24}',
    '.av svg{position:relative;width:46%;height:46%;opacity:.85}',
    '.who{flex:none;max-width:40%;font-weight:600;font-size:13px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sn{flex:1;min-width:0;font-size:12.5px;color:#6b7485;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'details[open] .sn{visibility:hidden}',
    '.dt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}',
    '.in{padding:4px 16px 16px;border-top:1px solid #eef0f4}',
    '.meta{font-size:12px;color:#6b7485;margin:8px 0 12px;overflow-wrap:anywhere}',
    '.files{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}',
    '.file{font-size:12px;color:#3b4252;background:#f1f4f9;border-radius:8px;padding:4px 10px;text-decoration:none}',
    '.file:hover{background:#e6ebf3}',
  ].join('');
  const out: string[] = [
    `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>`,
  ];
  const latest = messages[messages.length - 1];
  if (latest) out.push(bodyHtml(latest, t));
  if (messages.length > 1) {
    out.push(`<div class="earlier"><div class="et">${escapeHtml(t('emailInbox.earlierMessages').replace('{n}', String(messages.length - 1)))}</div>`);
    for (let i = messages.length - 2; i >= 0; i--) {
      const m = messages[i];
      const from = parseAddress(m.fromAddress);
      const tint = tintOf(m.fromAddress);
      const snippet = decodeEntities(m.snippet || m.textBody || '').replace(/\s+/g, ' ').trim();
      out.push(
        '<details><summary>',
        `<span class="av"><i style="background:${tint}"></i><svg viewBox="0 0 24 24"><path fill="${tint}" d="${PERSON_PATH}"/></svg></span>`,
        `<span class="who" dir="auto">${escapeHtml(from.name)}</span>`,
        `<span class="sn" dir="auto">${escapeHtml(snippet)}</span>`,
        `<span class="dt">${escapeHtml(formatListDate(m.sentAt, locale))}</span>`,
        '</summary><div class="in"><div class="meta">',
        escapeHtml(`${t('emailInbox.from')}: ${m.fromAddress}`), '<br>',
        escapeHtml(`${t('emailInbox.to')}: ${formatAddressList(m.toAddresses)}`),
      );
      if (m.ccAddresses.length) out.push('<br>', escapeHtml(`Cc: ${formatAddressList(m.ccAddresses)}`));
      out.push('<br>', escapeHtml(fullDate(m.sentAt, locale)), '</div>', bodyHtml(m, t), '</div></details>');
    }
    out.push('</div>');
  }
  out.push('</body></html>');
  return out.join('');
}

function formatAddressList(list: Array<{ email: string }>): string {
  return list.map((a) => a.email).join(', ');
}

function LatestMessageHeader({ message }: { message: EmailMessageView }) {
  const { t, locale } = useTranslation();
  const from = parseAddress(message.fromAddress);
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3">
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarFallback className={cn('text-xs font-semibold', avatarColorOf(message.fromAddress))}>{initialsOf(message.fromAddress)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span dir="auto" className="truncate text-sm font-semibold text-foreground">{from.name}</span>
          <span dir="ltr" className="hidden truncate text-xs text-muted-foreground sm:inline">&lt;{from.email}&gt;</span>
          <DeliveryStatusBadge message={message} />
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">{fullDate(message.sentAt, locale)}</span>
        </div>
        <div dir="auto" className="mt-0.5 truncate text-xs text-muted-foreground">
          {t('emailInbox.to' as any)}: {formatAddresses(message.toAddresses)}
          {message.ccAddresses.length > 0 && ` · Cc: ${formatAddresses(message.ccAddresses)}`}
        </div>
      </div>
    </div>
  );
}

function ThreadReader({ messages }: { messages: EmailMessageView[] }) {
  const { t, locale, dir } = useTranslation();
  const doc = useMemo(
    () => readerDocument(messages, dir || 'ltr', locale, (k) => t(k as any)),
    [messages, dir, locale, t],
  );
  return (
    <iframe
      title="email"
      srcDoc={doc}
      // No scripts, no same-origin: the email can neither run code nor reach
      // the app. Links and attachment chips open in a new tab.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-full w-full flex-1 border-0 bg-white"
    />
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
      {messages.length > 0 && <LatestMessageHeader message={messages[messages.length - 1]} />}
      <div className="flex min-h-0 flex-1">
        <ThreadReader messages={messages} />
      </div>
      {replyTo.length > 0 && (
        <div className="border-t border-border p-4">
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
  const requestIdRef = useRef<string>(crypto.randomUUID());
  // Each opening of the dialog is a new email.
  useEffect(() => {
    if (open) requestIdRef.current = crypto.randomUUID();
  }, [open]);

  const plainText = useMemo(() => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), [html]);
  const toList = useMemo(() => to.split(',').map((s) => s.trim()).filter(Boolean), [to]);

  const handleSend = async () => {
    if (!toList.length || !subject.trim() || !plainText || sendEmailMutation.isPending) return;
    try {
      await sendEmailMutation.mutateAsync({
        clientRequestId: requestIdRef.current,
        to: toList,
        subject: subject.trim(),
        textBody: plainText,
        htmlBody: html,
      });
      requestIdRef.current = crypto.randomUUID();
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

  const { data: gmailConnectionData, isLoading: gmailConnectionLoading, isSuccess: gmailConnectionKnown } = useGmailConnection(workspaceId);
  const { data: yahooConnectionData, isLoading: yahooConnectionLoading, isSuccess: yahooConnectionKnown } = useYahooConnection(workspaceId);

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
  // Only on answers the server actually gave: a failed or offline lookup
  // says nothing about the connection and must not wipe the cache.
  const connectionsKnown = !!workspaceId && gmailConnectionKnown && yahooConnectionKnown && !!user?.id;
  useEffect(() => {
    if (connectionsKnown && workspaceId) void clearWorkspaceEmailCache(workspaceId, scope);
  }, [connectionsKnown, workspaceId, scope]);

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
