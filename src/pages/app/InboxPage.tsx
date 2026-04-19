import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useConversations, useConversationMessages, useSendMessage, useUpdateConversation, useDeleteAllConversations, useMarkConversationSeen } from '@/hooks/useConversations';
import type { MessageAttachment } from '@/hooks/useConversations';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import { useVisitorPresenceForConversation } from '@/hooks/useVisitorPresence';
import { conversationsApi } from '@/lib/conversations-api';
import { useQueryClient } from '@tanstack/react-query';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Trash2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useBrandingContext } from '@/features/branding/BrandingContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import {
  Inbox, Send, CheckCircle2, Filter, Plus, MessageSquare,
  ChevronDown, Search, MoreHorizontal, Archive,
  UserCheck, AlertCircle, Clock, Star, X,
  Mail, Phone, Globe, User, Eye, ChevronLeft, ChevronRight,
  Loader2, Bot, Copy, Paperclip, RefreshCw,
  MessageCircle, Hash, FileText, Download, ImageIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const ALLOWED_OPERATOR_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain',
]);
const MAX_OPERATOR_BYTES = 25 * 1024 * 1024;

function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

// ─── Constants ───
const statusColors: Record<string, string> = {
  open: 'bg-success/15 text-success border-success/20',
  pending: 'bg-warning/15 text-warning border-warning/20',
  resolved: 'bg-info/15 text-info border-info/20',
  closed: 'bg-muted text-muted-foreground border-border',
};
const statusDots: Record<string, string> = {
  open: 'bg-success',
  pending: 'bg-warning',
  resolved: 'bg-info',
  closed: 'bg-muted-foreground',
};
const priorityColors: Record<string, string> = {
  low: 'text-muted-foreground', normal: 'text-info', high: 'text-warning', urgent: 'text-destructive',
};

type FilterStatus = 'all' | 'open' | 'pending' | 'resolved' | 'closed';
type SidebarTab = 'info' | 'activity';

export default function InboxPage() {
  const { t, dir } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const { platformName } = useBrandingContext();
  const [filter, setFilter] = useState<FilterStatus>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('info');
  const [showMobileList, setShowMobileList] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading } = useConversations(workspace?.id, filter === 'all' ? undefined : filter);
  const { data: rawMessages } = useConversationMessages(selectedId ?? undefined);
  const sendMessage = useSendMessage(selectedId ?? undefined, workspace?.id);
  const updateConv = useUpdateConversation();
  const deleteAll = useDeleteAllConversations();
  const markSeen = useMarkConversationSeen();
  const { data: isGlobalAdmin } = useIsGlobalAdmin();

  // Phase 7 — Mark conversation as seen the moment an operator selects it.
  // Honest semantics: this only fires on real user selection, never on
  // background fetch, hover, list render, assignment, or preload.
  useEffect(() => {
    if (!selectedId) return;
    markSeen.mutate(selectedId);
    // We intentionally depend only on selectedId so re-renders triggered by
    // unrelated state (filters, search, sidebar) do NOT re-fire the seen
    // event. Re-firing is harmless (monotonic update returns 0 affected
    // rows after the first call) but we still avoid the wasted RPC.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Wire inbox to the active realtime provider (Centrifugo / Supabase / polling).
  // - On `message` push: refetch the message list (visitor replies appear live).
  // - On `typing` push from the visitor: flash a transient "typing…" indicator.
  const qc = useQueryClient();
  const [visitorTypingUntil, setVisitorTypingUntil] = useState(0);
  const visitorTypingActive = visitorTypingUntil > Date.now();

  // Tick re-renders so the typing indicator auto-hides without an extra event.
  useEffect(() => {
    if (!visitorTypingActive) return;
    const t = setTimeout(() => setVisitorTypingUntil(0), Math.max(250, visitorTypingUntil - Date.now()));
    return () => clearTimeout(t);
  }, [visitorTypingUntil, visitorTypingActive]);

  useInboxRealtime({
    workspaceId: workspace?.id,
    conversationId: selectedId ?? undefined,
    onMessage: () => {
      if (selectedId) qc.invalidateQueries({ queryKey: ['messages', selectedId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onTyping: (payload) => {
      // Only react to visitor typing (ignore agent self-echo just in case).
      const actor = (payload as { actor?: string })?.actor;
      if (actor && actor !== 'visitor') return;
      // Show indicator for ~3.5s; subsequent events extend the window.
      setVisitorTypingUntil(Date.now() + 3500);
    },
  });

  // Visitor presence (online/idle/offline + current page) — polling-safe via 10s refetch.
  const { data: presence } = useVisitorPresenceForConversation(workspace?.id, selectedId ?? undefined);

  const handleDeleteAll = async () => {
    if (!workspace?.id) return;
    try {
      const res = await deleteAll.mutateAsync(workspace.id);
      setSelectedId(null);
      toast({
        title: 'Conversations deleted',
        description: `${res.deleted} conversation(s) removed.`,
      });
    } catch (e: any) {
      toast({
        title: 'Error',
        description: e?.message || 'Failed to delete conversations',
        variant: 'destructive',
      });
    }
  };

  const selected = conversations?.find(c => c.id === selectedId);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rawMessages?.length]);

  // ─── Phase 2 — Operator attachment composer state ───
  // Single pending attachment per draft (mirrors widget's design).
  // State machine: idle → uploading → ready → (sent → idle) | error
  type AttState = {
    file: File | null;
    attachmentId: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    status: 'idle' | 'uploading' | 'ready' | 'error';
    progress: number;
    error: string;
  };
  const initialAttState: AttState = {
    file: null, attachmentId: null, fileName: '', mimeType: '',
    sizeBytes: 0, status: 'idle', progress: 0, error: '',
  };
  const [att, setAtt] = useState<AttState>(initialAttState);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetAttachment = useCallback(() => setAtt(initialAttState), []);

  const beginUpload = useCallback(async (file: File) => {
    if (!workspace?.id) return;
    if (!ALLOWED_OPERATOR_MIMES.has(file.type)) {
      toast({
        title: t('inbox.attachInvalidType') || 'File type not allowed',
        description: file.type || 'unknown',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > MAX_OPERATOR_BYTES) {
      toast({
        title: t('inbox.attachTooLarge') || 'File too large',
        description: humanSize(MAX_OPERATOR_BYTES),
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
        conversation_id: selectedId ?? null,
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
  }, [workspace?.id, selectedId, t]);

  const onFilePicked: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (file) beginUpload(file);
  };

  const retryUpload = useCallback(() => {
    if (att.file) beginUpload(att.file);
  }, [att.file, beginUpload]);

  const removeAttachment = useCallback(() => {
    if (att.attachmentId && workspace?.id) {
      // Best-effort cleanup; ignore failures.
      conversationsApi.deleteAttachment({
        workspace_id: workspace.id, attachment_id: att.attachmentId,
      }).catch(() => {});
    }
    resetAttachment();
  }, [att.attachmentId, workspace?.id, resetAttachment]);

  const handleSend = async () => {
    if (!selectedId || !user) return;
    const hasText = message.trim().length > 0;
    const hasAttachment = att.status === 'ready' && !!att.attachmentId;
    if (!hasText && !hasAttachment) return;
    if (att.status === 'uploading') return; // wait for upload to finish
    await sendMessage.mutateAsync({
      body: message,
      attachmentId: hasAttachment ? att.attachmentId : null,
    });
    setMessage('');
    resetAttachment();
  };

  // Phase 1 — operator typing emit (throttled to ≤1 publish per 2s while typing).
  // Realtime-only ephemeral event; failure is silently ignored.
  const lastTypingSentRef = useRef(0);
  const emitTyping = useCallback(() => {
    if (!workspace?.id || !selectedId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    conversationsApi.sendTyping({
      workspace_id: workspace.id,
      conversation_id: selectedId,
    });
  }, [workspace?.id, selectedId]);

  // Reset visitor typing indicator + pending attachment when switching conversations.
  useEffect(() => {
    setVisitorTypingUntil(0);
    lastTypingSentRef.current = 0;
    resetAttachment();
  }, [selectedId, resetAttachment]);

  const getInitials = (name?: string | null, email?: string | null) => {
    if (name) return name.charAt(0).toUpperCase();
    if (email) return email.charAt(0).toUpperCase();
    return '?';
  };

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('inbox.now') || 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
  };

  const statusCounts = useMemo(() => {
    if (!conversations) return {};
    return conversations.reduce((acc: Record<string, number>, c) => {
      acc[c.status ?? 'open'] = (acc[c.status ?? 'open'] || 0) + 1;
      return acc;
    }, {});
  }, [conversations]);

  const filteredConvos = useMemo(() => {
    if (!conversations) return [];
    return conversations.filter(c => {
      if (!search) return true;
      const name = c.contacts?.name || c.contacts?.email || c.subject || '';
      return name.toLowerCase().includes(search.toLowerCase());
    });
  }, [conversations, search]);

  const statusLabels: Record<string, string> = {
    open: t('inbox.open') || 'Open',
    pending: t('inbox.pending') || 'Pending',
    resolved: t('inbox.resolved') || 'Resolved',
    closed: t('inbox.closed') || 'Closed',
  };

  return (
    <div className="flex h-full" dir={dir}>
      {/* ═══════ LEFT: Conversation List ═══════ */}
      <div className={cn(
        'w-full md:w-[340px] lg:w-[380px] shrink-0 border-e border-border flex flex-col bg-card',
        selectedId && !showMobileList ? 'hidden md:flex' : 'flex'
      )}>
        {/* Header */}
        <div className="p-3 border-b border-border space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Inbox className="w-[18px] h-[18px] text-primary" />
              <h2 className="text-[0.9rem] font-bold text-foreground">{t('inbox.title') || 'Inbox'}</h2>
              <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-semibold">
                {conversations?.length || 0}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <Plus className="w-3.5 h-3.5" />
              </button>
              {isGlobalAdmin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    title="Delete all conversations"
                    disabled={!conversations?.length || deleteAll.isPending}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deleteAll.isPending
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete all conversations?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete <strong>all {conversations?.length || 0} conversation(s)</strong> and their messages for this workspace. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteAll}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete all
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className={cn('absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground', dir === 'rtl' ? 'right-2.5' : 'left-2.5')} />
            <Input
              placeholder={t('inbox.search') || 'Search conversations...'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={cn('h-8 text-xs bg-secondary/50 border-transparent focus:border-primary/30', dir === 'rtl' ? 'pr-8' : 'pl-8')}
              dir={dir}
            />
          </div>

          {/* Filter tabs */}
          <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-hide">
            {(['open', 'pending', 'resolved', 'closed', 'all'] as FilterStatus[]).map(s => {
              const count = s === 'all' ? (conversations?.length || 0) : (statusCounts[s] || 0);
              const isActive = filter === s;
              const dotColor = s === 'open' ? 'bg-success' : s === 'pending' ? 'bg-warning' : s === 'resolved' ? 'bg-info' : s === 'closed' ? 'bg-muted-foreground' : 'bg-primary';
              return (
                <button
                  key={s}
                  onClick={() => setFilter(s)}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-semibold transition-all whitespace-nowrap border',
                    isActive
                      ? 'bg-primary/10 text-primary border-primary/25 shadow-sm'
                      : 'bg-transparent text-muted-foreground border-transparent hover:bg-secondary/60 hover:text-foreground'
                  )}
                >
                  {s !== 'all' && <span className={cn('w-1.5 h-1.5 rounded-full', isActive ? dotColor : 'bg-muted-foreground/30')} />}
                  {s === 'all' ? (t('inbox.all') || 'All') : statusLabels[s]}
                  {count > 0 && (
                    <span className={cn(
                      'text-[9px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 font-bold',
                      isActive ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
                    )}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Conversation items */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          ) : !filteredConvos?.length ? (
            <div className="py-16 text-center">
              <MessageSquare className="w-10 h-10 mx-auto mb-3 text-muted-foreground/20" />
              <p className="text-xs text-muted-foreground">{t('inbox.noMessages') || 'No conversations'}</p>
            </div>
          ) : (
            filteredConvos.map(conv => {
              const isActive = selectedId === conv.id;
              const name = conv.contacts?.name || conv.contacts?.email || conv.subject || `#${conv.id.slice(0, 8)}`;
              const hasUnread = conv.status === 'open';

              return (
                <div
                  key={conv.id}
                  onClick={() => { setSelectedId(conv.id); setShowMobileList(false); }}
                  className={cn(
                    'group/item px-3 py-3.5 cursor-pointer transition-all border-b border-border/30',
                    isActive
                      ? 'bg-primary/[0.08] border-s-2 border-s-primary'
                      : hasUnread
                        ? 'bg-primary/[0.03] hover:bg-primary/[0.06]'
                        : 'hover:bg-secondary/50'
                  )}
                  dir={dir}
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className="relative shrink-0">
                      <div className={cn(
                        'w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold shadow-sm',
                        isActive ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
                      )}>
                        {conv.contacts?.avatar_url ? (
                          <img src={conv.contacts.avatar_url} className="w-11 h-11 rounded-full object-cover" alt="" />
                        ) : (
                          getInitials(conv.contacts?.name, conv.contacts?.email)
                        )}
                      </div>
                      {hasUnread && (
                        <div className="absolute -top-0.5 -end-0.5 w-3 h-3 rounded-full bg-primary border-2 border-card animate-pulse" />
                      )}
                    </div>

                    {/* Content */}
                    <div className={cn('flex-1 min-w-0', dir === 'rtl' ? 'text-right' : 'text-left')}>
                      {/* Row 1: Name + time */}
                      <div className="flex items-center justify-between mb-0.5">
                        <span className={cn('text-[13px] truncate', hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>
                          {name}
                        </span>
                        <span className={cn(
                          'text-[11px] shrink-0',
                          dir === 'rtl' ? 'mr-2' : 'ml-2',
                          hasUnread ? 'text-primary font-semibold' : 'text-muted-foreground'
                        )} dir="ltr">
                          {conv.updated_at ? timeAgo(conv.updated_at) : ''}
                        </span>
                      </div>
                      {/* Row 2: Subject */}
                      <p className={cn('text-[12px] truncate mb-1.5 leading-relaxed', hasUnread ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                        {conv.subject || t('inbox.noMessages')}
                      </p>
                      {/* Row 3: Status badges */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-medium border', statusColors[conv.status ?? 'open'])}>
                          {statusLabels[conv.status ?? 'open']}
                        </span>
                        {hasUnread && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                            {t('inbox.unread') || 'Unread'}
                          </span>
                        )}
                        {conv.assigned_to && (
                          <span className="text-[10px] text-muted-foreground/50 flex items-center gap-0.5">
                            <UserCheck className="w-3 h-3" />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* ═══════ CENTER: Chat Panel ═══════ */}
      <div className={cn(
        'flex-1 flex flex-col min-w-0',
        !selectedId || showMobileList ? 'hidden md:flex' : 'flex'
      )}>
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background">
            <div className="w-16 h-16 rounded-2xl bg-primary mx-auto mb-4 flex items-center justify-center" style={{ boxShadow: 'var(--shadow-glow)' }}>
              <MessageCircle className="h-8 w-8 text-primary-foreground" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">{platformName || 'Inbox'}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('inbox.selectConversation') || 'Select a conversation to start replying'}</p>
          </div>
        ) : (
          <>
            {/* ── Chat Header — Desktop ── */}
            <div className="hidden md:flex px-4 py-2.5 border-b border-border items-center justify-between shrink-0 bg-card/50">
              <div className="flex items-center gap-2.5">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {selected.contacts?.avatar_url ? (
                      <img src={selected.contacts.avatar_url} className="w-10 h-10 rounded-full object-cover" alt="" />
                    ) : (
                      <span className="text-sm font-semibold text-primary">
                        {getInitials(selected.contacts?.name, selected.contacts?.email)}
                      </span>
                    )}
                  </div>
                  <div className={cn('absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full border-2 border-card', statusDots[selected.status ?? 'open'])} />
                </div>
                <div>
                  <div className="text-[13px] font-bold text-foreground">
                    {selected.contacts?.name || selected.subject || `#${selectedId.slice(0, 8)}`}
                  </div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                    {selected.contacts?.email && <span className="truncate">{selected.contacts.email}</span>}
                    {presence && presence.status !== 'unknown' && (
                      <>
                        {selected.contacts?.email && <span className="opacity-30">•</span>}
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 font-medium',
                            presence.status === 'online' && 'text-success',
                            presence.status === 'idle' && 'text-warning',
                            presence.status === 'offline' && 'text-muted-foreground',
                          )}
                          title={presence.current_page || undefined}
                        >
                          <span
                            className={cn(
                              'w-1.5 h-1.5 rounded-full',
                              presence.status === 'online' && 'bg-success',
                              presence.status === 'idle' && 'bg-warning',
                              presence.status === 'offline' && 'bg-muted-foreground',
                            )}
                          />
                          {presence.status === 'online'
                            ? (t('inbox.presenceOnline') || 'Online')
                            : presence.status === 'idle'
                              ? (t('inbox.presenceIdle') || 'Idle')
                              : (t('inbox.presenceOffline') || 'Offline')}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge className={cn('text-[10px] border', statusColors[selected.status ?? 'open'])}>
                  {statusLabels[selected.status ?? 'open']}
                </Badge>
                {selected.status === 'open' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateConv.mutate({ id: selectedId, status: 'resolved' })}
                    className="h-7 px-2.5 text-[10px] font-semibold bg-success/10 border-success/20 text-success hover:bg-success/20"
                  >
                    <CheckCircle2 className={cn('w-3 h-3', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                    {t('inbox.resolve') || 'Resolve'}
                  </Button>
                )}
                {selected.status === 'resolved' && (
                  <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => updateConv.mutate({ id: selectedId, status: 'open' })}>
                    {t('inbox.reopen') || 'Reopen'}
                  </Button>
                )}
                <button
                  onClick={() => setShowSidebar(!showSidebar)}
                  className={cn(
                    'p-1.5 rounded-md transition-colors',
                    showSidebar ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  )}
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* ── Chat Header — Mobile ── */}
            <div className="md:hidden flex items-center gap-2 px-3 py-2.5 bg-card/60 border-b border-border/50 shrink-0">
              <button onClick={() => { setSelectedId(null); setShowMobileList(true); }} className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground transition-colors">
                {dir === 'rtl' ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
              </button>
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-sm font-semibold text-primary">
                  {getInitials(selected.contacts?.name, selected.contacts?.email)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold text-foreground truncate">
                  {selected.contacts?.name || selected.subject || `#${selectedId.slice(0, 8)}`}
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <span className={cn('px-1.5 py-0.5 rounded-full text-[9px] font-medium border', statusColors[selected.status ?? 'open'])}>
                    {statusLabels[selected.status ?? 'open']}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {selected.status === 'open' && (
                  <button onClick={() => updateConv.mutate({ id: selectedId, status: 'resolved' })} className="p-2 rounded-xl text-success hover:bg-success/10 transition-colors">
                    <CheckCircle2 className="w-5 h-5" />
                  </button>
                )}
                <button onClick={() => setShowSidebar(!showSidebar)} className="p-2 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                  <Eye className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* ── Messages Area ── */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-background" ref={messagesContainerRef}>
              {rawMessages?.map(msg => {
                // Treat any non-visitor sender as the support side of the
                // thread. AI auto-replies (sender_type === 'ai') and system
                // messages render on the same side as a human agent so the
                // visitor↔support layout stays consistent.
                const isVisitor = msg.sender_type === 'contact';
                const isAgent = !isVisitor;
                const isAi = msg.sender_type === 'ai';
                return (
                  <div key={msg.id} className={cn('flex gap-2.5 group', isAgent ? 'flex-row' : 'flex-row-reverse')}>
                    {/* Avatar */}
                    {isAgent ? (
                      <div className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm',
                        isAi ? 'bg-accent/20 text-accent-foreground' : 'bg-primary/15 text-primary',
                      )}>
                        <Bot className="w-4 h-4" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 bg-secondary text-secondary-foreground shadow-sm">
                        <User className="w-4 h-4" />
                      </div>
                    )}
                    <div className="max-w-[75%]">
                      <div className={cn('text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1', isAgent ? '' : 'text-start')}>
                        <span>
                          {isAgent ? (t('inbox.support') || 'Support') : (selected?.contacts?.name || t('inbox.visitor') || 'Visitor')}
                        </span>
                        {isAi && (
                          <span className="px-1 py-px rounded bg-accent/30 text-accent-foreground text-[9px] font-medium uppercase tracking-wide">
                            AI
                          </span>
                        )}
                        <span className="opacity-40">•</span>
                        <span>{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className={cn(
                        'rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed',
                        isAgent
                          ? 'bg-primary/10 text-foreground rounded-es-sm'
                          : 'bg-secondary text-foreground rounded-ee-sm'
                      )}>
                        {(msg as { attachment?: MessageAttachment | null }).attachment && (
                          <MessageAttachmentView att={(msg as { attachment: MessageAttachment }).attachment} t={t} />
                        )}
                        {msg.body && <p className={cn((msg as any).attachment ? 'mt-2' : '')}>{msg.body}</p>}
                      </div>
                      {/* Copy action */}
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 mt-0.5">
                        <button
                          onClick={() => { navigator.clipboard.writeText(msg.body); toast({ title: 'Copied!' }); }}
                          className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* ── Visitor typing indicator ── */}
            {visitorTypingActive && (
              <div className="px-4 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2 bg-background border-t border-border/40" dir={dir}>
                <span className="inline-flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                <span>
                  {(selected?.contacts?.name || t('inbox.visitor') || 'Visitor')} {t('inbox.visitorTyping') || 'typing…'}
                </span>
              </div>
            )}

            {/* ── Input Area ── */}
            <div className="border-t border-border px-3 py-2.5 bg-card/50 shrink-0" dir={dir}>
              {/* Pending attachment chip */}
              {att.status !== 'idle' && (
                <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-2.5 py-2">
                  <div className="w-8 h-8 rounded-md bg-background flex items-center justify-center shrink-0 text-muted-foreground">
                    {att.mimeType.startsWith('image/')
                      ? <ImageIcon className="w-4 h-4" />
                      : <FileText className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-foreground truncate">{att.fileName}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                      <span>{humanSize(att.sizeBytes)}</span>
                      <span className="opacity-40">•</span>
                      <span className={cn(
                        att.status === 'error' ? 'text-destructive' :
                        att.status === 'ready' ? 'text-success' : 'text-muted-foreground'
                      )}>
                        {att.status === 'uploading' && (t('inbox.attachUploading') || 'Uploading…')}
                        {att.status === 'ready' && (t('inbox.attachReady') || 'Ready to send')}
                        {att.status === 'error' && (att.error || t('inbox.attachUploadFailed') || 'Upload failed')}
                      </span>
                    </div>
                    {att.status === 'uploading' && (
                      <Progress value={att.progress} className="h-1 mt-1.5" />
                    )}
                  </div>
                  {att.status === 'error' && (
                    <button
                      onClick={retryUpload}
                      className="text-[11px] font-medium text-primary hover:underline px-1.5"
                    >
                      {t('inbox.attachRetry') || 'Retry'}
                    </button>
                  )}
                  <button
                    onClick={removeAttachment}
                    className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    aria-label={t('inbox.attachRemove') || 'Remove'}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <div className={cn(
                'flex gap-2 items-end rounded-xl border p-1.5 transition-colors border-border bg-secondary/30'
              )}>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
                  onChange={onFilePicked}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={att.status === 'uploading'}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('inbox.attachFile') || 'Attach file'}
                  aria-label={t('inbox.attachFile') || 'Attach file'}
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <Textarea
                  placeholder={t('inbox.typeMessage') || 'Type a message...'}
                  value={message}
                  onChange={e => { setMessage(e.target.value); if (e.target.value) emitTyping(); }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  className="min-h-[36px] max-h-24 resize-none border-0 bg-transparent text-[15px] focus-visible:ring-0 p-1"
                  rows={1}
                  dir={dir}
                />
                <Button
                  onClick={handleSend}
                  size="icon"
                  disabled={!message.trim() || sendMessage.isPending}
                  className="h-9 w-9 rounded-lg shrink-0"
                >
                  {sendMessage.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
              <div className="text-[9px] text-muted-foreground/50 mt-1">
                {t('inbox.enterToSend') || 'Enter to send · Shift+Enter for new line'}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ═══════ RIGHT: Contact Sidebar ═══════ */}
      {selected && showSidebar && (
        <div className={cn(
          'hidden lg:flex w-[280px] border-s border-border flex-col bg-card/40 shrink-0 overflow-hidden'
        )}>
          {/* Sidebar tabs */}
          <div className="flex border-b border-border bg-card/60">
            {([
              { id: 'info' as SidebarTab, label: t('inbox.info') || 'Info', icon: User },
              { id: 'activity' as SidebarTab, label: t('inbox.activity') || 'Activity', icon: Clock },
            ]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setSidebarTab(tab.id)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-semibold transition-all border-b-2',
                  sidebarTab === tab.id
                    ? 'border-primary text-primary bg-primary/5'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1">
            {sidebarTab === 'info' && (
              <div className="p-3 space-y-2.5" dir={dir}>
                {/* Contact Hero */}
                <div className="rounded-xl bg-gradient-to-b from-primary/5 to-transparent border border-border/50 p-4">
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      <div className="w-12 h-12 rounded-xl bg-secondary ring-2 ring-primary/20 flex items-center justify-center text-sm font-bold text-secondary-foreground overflow-hidden">
                        {selected.contacts?.avatar_url ? (
                          <img src={selected.contacts.avatar_url} className="w-full h-full object-cover" alt="" />
                        ) : (
                          getInitials(selected.contacts?.name, selected.contacts?.email)
                        )}
                      </div>
                      <div className={cn(
                        'absolute -bottom-0.5 -end-0.5 w-2.5 h-2.5 rounded-full border-2 border-card',
                        statusDots[selected.status ?? 'open']
                      )} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-bold text-foreground truncate">
                        {selected.contacts?.name || `#${selectedId?.slice(0, 8)}`}
                      </h3>
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className={cn('text-[9px] px-1.5 py-0.5 rounded-full border font-medium', statusColors[selected.status ?? 'open'])}>
                          {statusLabels[selected.status ?? 'open']}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Contact Details */}
                <div className="rounded-xl border border-border/50 bg-card/60 divide-y divide-border/20">
                  {selected.contacts?.email && (
                    <div className="flex items-center gap-2.5 px-3 py-2.5 group/row hover:bg-secondary/20">
                      <Mail className="w-3.5 h-3.5 text-primary shrink-0" />
                      <span className="text-[11px] text-foreground truncate flex-1 font-medium" dir="ltr">{selected.contacts.email}</span>
                      <button
                        onClick={() => { navigator.clipboard.writeText(selected.contacts?.email || ''); toast({ title: 'Copied!' }); }}
                        className="opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Stats */}
                <div className="rounded-xl border border-border/50 bg-card/60 p-2.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="bg-secondary/30 rounded-lg py-2 px-2 text-center border border-border/20">
                      <div className="text-base font-extrabold text-foreground">{rawMessages?.length || 0}</div>
                      <div className="text-[9px] text-muted-foreground">{t('inbox.messages') || 'Messages'}</div>
                    </div>
                    <div className="bg-secondary/30 rounded-lg py-2 px-2 text-center border border-border/20">
                      <div className="text-xs font-extrabold text-foreground">{selected.created_at ? timeAgo(selected.created_at) : '—'}</div>
                      <div className="text-[9px] text-muted-foreground">{t('inbox.duration') || 'Duration'}</div>
                    </div>
                  </div>
                </div>

                {/* Tags */}
                {selected.tags && selected.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((tag: string) => (
                      <span key={tag} className="text-xs px-2 py-1 rounded-lg bg-secondary/40 text-muted-foreground border border-border/40 font-medium">
                        <Hash className="w-3 h-3 inline text-primary/50" />{tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Priority + Assign */}
                <div className="rounded-xl border border-border/50 bg-card/60 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border/30 bg-secondary/15">
                    <h4 className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">{t('inbox.details') || 'Details'}</h4>
                  </div>
                  <div className="divide-y divide-border/20">
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[11px] text-muted-foreground">{t('inbox.priority') || 'Priority'}</span>
                      <span className={cn('text-[11px] font-medium capitalize', priorityColors[selected.priority ?? 'normal'])}>
                        {selected.priority ?? 'normal'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[11px] text-muted-foreground">{t('inbox.status') || 'Status'}</span>
                      <span className="text-[11px] font-medium text-foreground capitalize">{selected.status}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-[11px] text-muted-foreground">{t('inbox.created') || 'Created'}</span>
                      <span className="text-[11px] font-medium text-foreground" dir="ltr">
                        {selected.created_at ? new Date(selected.created_at).toLocaleDateString() : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {sidebarTab === 'activity' && (
              <div className="p-3" dir={dir}>
                <div className="py-12 text-center text-xs text-muted-foreground">
                  {t('inbox.noActivity') || 'No activity recorded yet'}
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
