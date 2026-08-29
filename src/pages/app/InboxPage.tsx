import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useBranding } from '@/hooks/useBranding';
import { useConversations, useConversationMessages, useSendMessage, useUpdateConversation, useDeleteAllConversations, useMarkConversationSeen, useInboxTabCounts, type InboxQueue } from '@/hooks/useConversations';
import type { MessageAttachment } from '@/hooks/useConversations';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import { emitInvitationChanged } from '@/lib/call-invitations-events';
import { emitCallEnded } from '@/lib/call-end-events';
import { useInboxListRealtime } from '@/hooks/useInboxListRealtime';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';
import { useVisitorPresenceForConversation } from '@/hooks/useVisitorPresence';
import { conversationsApi } from '@/lib/conversations-api';
import { useQueryClient } from '@tanstack/react-query';
import { useIsGlobalAdmin } from '@/hooks/useAdmin';
import { isTypingSuppressed } from '@/realtime/policySnapshot';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Trash2 } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
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
  PhoneOff, Ban, ShieldOff, Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { VisitorNetworkCard } from '@/features/visitors/VisitorNetworkCard';
import { contactDisplayName } from '@/lib/contact-display';
import { localizedCountryName } from '@/lib/geo/countryLocalization';
import { toast } from '@/hooks/use-toast';
import { ConversationActionPanel } from '@/components/inbox/ConversationActionPanel';
import { AiGuidancePanel } from '@/components/inbox/AiGuidancePanel';
import { GuidanceComposer } from '@/components/inbox/GuidanceComposer';
import { ConversationActivityPanel } from '@/components/inbox/ConversationActivityPanel';
import { AiSuggestionCard } from '@/components/inbox/AiSuggestionCard';
import { OperatorAssistPanel } from '@/components/inbox/OperatorAssistPanel';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { SidebarCallCard } from '@/components/inbox/SidebarCallCard';
import { CannedResponsePicker, type CannedPickerHandle } from '@/components/canned-responses/CannedResponsePicker';
import { interpolate } from '@/components/canned-responses/interpolation';
import { useTrackCannedResponseUse } from '@/hooks/useCannedResponses';
import type { CannedLocale, CannedResponse } from '@/lib/canned-responses-api';
import { useProfile } from '@/hooks/useProfile';
import { Sparkles } from 'lucide-react';
import { ContactAvatar } from '@/components/inbox/ContactAvatar';
import { ChannelBadge, ChannelIdentityCard, resolveChannelKey } from '@/components/inbox/ChannelBadge';
import { ContactDrawer } from '@/features/contacts/ContactDrawer';
import { PresenceBadge, PresenceDot } from '@/components/inbox/PresenceIndicator';
import { formatTime, formatLongDate, formatRelative, formatDateTime } from '@/lib/date';
import TeamChatPanel from '@/components/inbox/TeamChatPanel';
import { useColleagues } from '@/hooks/useTeamChat';
import {
  useOperatorMessageChime,
  getOperatorMessageSoundEnabled,
  setOperatorMessageSoundEnabled,
} from '@/features/notifications/operatorMessageSound';
import { Volume2, VolumeX } from 'lucide-react';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';
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

/**
 * Attachment renderer for inbox messages. Always loads via the backend
 * proxy /api/widget/attachments/:id (same route the visitor widget uses,
 * re-checks workspace + conversation ownership). Provider URLs never reach
 * the client.
 */
function MessageAttachmentView({
  att,
  t,
}: {
  att: { id: string; file_name: string; mime_type: string; size_bytes: number; kind: 'image' | 'file' };
  t: (key: any) => string;
}) {
  const url = `${API_BASE}/api/widget/attachments/${encodeURIComponent(att.id)}`;
  const isImage = att.kind === 'image' || /^image\//.test(att.mime_type);
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block max-w-[280px] rounded-lg overflow-hidden border border-border">
        <img src={url} alt={att.file_name} loading="lazy" className="block w-full h-auto" />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={att.file_name}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-background/60 px-2.5 py-2 max-w-[280px] hover:bg-background transition-colors"
    >
      <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">
        <FileText className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-foreground truncate">{att.file_name}</div>
        <div className="text-[10px] text-muted-foreground">{humanSize(att.size_bytes)}</div>
      </div>
      <Download className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    </a>
  );
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

/**
 * Some conversations are persisted with an English placeholder subject
 * ("New conversation") by the widget/AI. Map those onto the active locale so
 * the UI never leaks English, and drop them entirely once the conversation
 * has real content (a contact name or an actual message).
 */
const PLACEHOLDER_SUBJECTS = new Set([
  'new conversation',
  'new chat',
  'untitled conversation',
  'untitled',
  '[attachment]',
]);

function isPlaceholderSubject(subject?: string | null): boolean {
  const s = (subject ?? '').trim().toLowerCase();
  return !s || PLACEHOLDER_SUBJECTS.has(s);
}

/** Display title for a conversation: contact identity first, subject second. */
function conversationTitle(conv: any, t: (k: string, vars?: Record<string, string>) => string, locale?: string): string {
  return (
    (conv?.contacts
      ? contactDisplayName(conv.contacts, conv?.contact_id ?? conv?.id, t, conv?.visitor_network?.geo, locale)
      : '')
    || (isPlaceholderSubject(conv?.subject) ? '' : conv.subject)
    || t('contacts.conversationUntitled')
  );
}

type ExtraChip = 'needs_human' | 'assigned_to_me' | 'colleagues';
type SidebarTab = 'info' | 'activity';

/**
 * Renders children into the app top bar slot when available.
 * The slot node is re-resolved whenever the DOM changes so the portal never
 * points at a detached element (which silently hides the filter tabs after a
 * navigation / re-render of the top bar).
 */
function ToolbarPortal({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const resolve = () => {
      const el = document.getElementById('topbar-page-slot');
      setSlot((prev) => (prev === el && el && el.isConnected ? prev : el));
    };
    resolve();
    const mo = new MutationObserver(resolve);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return slot && slot.isConnected ? createPortal(children, slot) : <>{children}</>;
}

export default function InboxPage() {
  const { t, dir, locale } = useTranslation();
  const { user } = useAuth();
  const workspace = useCurrentWorkspace();
  const { data: wsBranding } = useBranding(workspace?.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { slug: wsSlug } = useParams();
  const queueParam = searchParams.get('queue');
  const filterParam = searchParams.get('filter');
  const statusParam = searchParams.get('status');

  // queue param is constrained to the real queues. Any other value (incl.
  // the legacy `needs_human`) collapses to Main Inbox; the legacy URL is
  // rewritten by the effect below into `?filter=needs_human`.
  const queue: InboxQueue =
    queueParam === 'automated' ? 'automated'
      : queueParam === 'spam' ? 'spam'
      : 'main';
  const isQueueMode = queue !== 'main';

  const filter: FilterStatus =
    statusParam === 'open' || statusParam === 'pending' ||
    statusParam === 'resolved' || statusParam === 'closed' ||
    statusParam === 'all'
      ? statusParam
      : 'open';
  const extraChip: ExtraChip | null =
    filterParam === 'needs_human' ? 'needs_human'
      : filterParam === 'assigned_to_me' ? 'assigned_to_me'
      : filterParam === 'colleagues' ? 'colleagues'
      : null;

  // Legacy URL redirect: /inbox?queue=needs_human → /inbox?filter=needs_human.
  useEffect(() => {
    if (queueParam !== 'needs_human') return;
    const next = new URLSearchParams(searchParams);
    next.delete('queue');
    next.set('filter', 'needs_human');
    setSearchParams(next, { replace: true });
  }, [queueParam, searchParams, setSearchParams]);

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    // Always derive from the latest URL. Portal-hosted tab clicks can happen
    // between location renders; closing over searchParams could otherwise
    // restore a stale filter and make the next tab appear unresponsive.
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setFilter = useCallback((s: FilterStatus) => {
    // Status tabs and special tabs are peers in the UI, not cumulative
    // filters. Leaving `filter=needs_human` behind made every later status
    // tab continue to query only handoff conversations.
    updateUrl({ status: s === 'open' ? null : s, filter: null });
  }, [updateUrl]);
  const setExtraChip = useCallback((c: ExtraChip | null) => {
    // Special tabs start from the main/open inbox and are mutually exclusive
    // with the status tabs, so one click always has one deterministic query.
    updateUrl({ filter: c, status: null });
  }, [updateUrl]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('info');
  const [showMobileList, setShowMobileList] = useState(true);
  const [activeCallConversationId, setActiveCallConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const selectedSnapshotRef = useRef<any>(null);
  const pendingScrollConvRef = useRef<string | null>(null);

  // Deep link: /inbox?c=<conversationId> — open that conversation directly
  // (e.g. coming from the contact detail page). We switch to the "all"
  // status filter so the target conversation is guaranteed to be in the list.
  const deepLinkConvId = searchParams.get('c');
  useEffect(() => {
    if (!deepLinkConvId) return;
    setSelectedId(deepLinkConvId);
    setShowMobileList(false);
    pendingScrollConvRef.current = deepLinkConvId;
    const next = new URLSearchParams(searchParams);
    next.delete('c');
    next.set('status', 'all');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkConvId]);

  const { data: conversations, isLoading } = useConversations(
    workspace?.id,
    filter === 'all' ? undefined : filter === 'resolved' ? 'resolved,closed' : filter,
    queue,
    queue === 'main'
      ? {
          needsHuman: extraChip === 'needs_human',
          assignedToMe: extraChip === 'assigned_to_me' ? (user?.id ?? null) : null,
        }
      : {},
  );
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
      // Keep the tab counters live so a new message lights up its tab.
      if (workspace?.id) {
        qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspace.id] });
        qc.invalidateQueries({ queryKey: ['inbox-counts', workspace.id] });
      }
    },
    onTyping: (payload) => {
      // Only react to visitor typing (ignore agent self-echo just in case).
      const actor = (payload as { actor?: string })?.actor;
      if (actor && actor !== 'visitor') return;
      // Show indicator for ~3.5s; subsequent events extend the window.
      setVisitorTypingUntil(Date.now() + 3500);
    },
    // Phase 5 — operator-side events on the per-conversation channel.
    // Refresh notes/timeline caches so the open thread reflects new
    // notes, status/priority/assignment/tag changes immediately.
    onEvent: (payload) => {
      const kind = (payload as { kind?: string })?.kind;
      const convId = (payload as { conversation_id?: string })?.conversation_id;
      if (!kind || !convId) return;
      // Phase 9 — forward invitation lifecycle events to OperatorCallPanel
      // so the operator's panel updates instantly without waiting for its
      // 4s/15s polling tick. Polling remains a safety net.
      if (kind === 'call_invitation_changed') {
        const p = payload as Record<string, unknown>;
        emitInvitationChanged({
          workspace_id: String(p.workspace_id ?? workspace?.id ?? ''),
          conversation_id: String(p.conversation_id ?? convId),
          invitation_id: String(p.invitation_id ?? ''),
          status: (p.status as 'pending' | 'joined' | 'expired' | 'cancelled' | 'declined') ?? 'pending',
          channel: (p.channel as 'audio' | 'video') ?? 'audio',
          expires_at: (p.expires_at as string | null) ?? null,
        });
        // also refresh timeline so the lifecycle row appears immediately
        qc.invalidateQueries({ queryKey: ['conversation-timeline', convId, workspace?.id] });
        return;
      }
      // Pass A — server fan-out of call:ended events. Forwards to the
      // OperatorCallProvider so the floating window collapses to its
      // terminal state with a duration the moment either side ends the
      // call (visitor hangup, operator hangup, room webhook, …).
      if (kind === 'call:ended') {
        const p = payload as Record<string, unknown>;
        emitCallEnded({
          workspace_id: String(p.workspace_id ?? workspace?.id ?? ''),
          conversation_id: String(p.conversation_id ?? convId),
          call_session_id: String(p.call_session_id ?? ''),
          ended_by: (p.ended_by as 'operator' | 'visitor' | 'system') ?? 'system',
          reason: (p.reason as 'operator_ended' | 'visitor_ended' | 'system_ended' | 'failed') ?? 'system_ended',
          duration_seconds: typeof p.duration_seconds === 'number' ? p.duration_seconds : 0,
          ended_at: String(p.ended_at ?? new Date().toISOString()),
        });
        qc.invalidateQueries({ queryKey: ['conversation-timeline', convId, workspace?.id] });
        return;
      }
      if (kind === 'note_added' || kind === 'note_deleted') {
        qc.invalidateQueries({ queryKey: ['conversation-notes', convId, workspace?.id] });
        qc.invalidateQueries({ queryKey: ['conversation-timeline', convId, workspace?.id] });
        return;
      }
      if (
        kind === 'conversation_updated' ||
        kind === 'conversation_resolved' ||
        kind === 'conversation_reopened' ||
        kind === 'timeline_event'
      ) {
        qc.invalidateQueries({ queryKey: ['conversation-timeline', convId, workspace?.id] });
        // The list-level patch is handled by useInboxListRealtime below.
      }
    },
  });

  // Phase 5 — operator-only inbox-list channel: optimistically patch the
  // conversation list when status/priority/assignee/tags change anywhere
  // in the workspace, without needing a per-conversation subscription.
  useInboxListRealtime(workspace?.id);
  // Refresh IP/geo once async enrichment lands (reuses the visitors channel).
  useGeoEnrichmentRealtime(workspace?.id);

  // Phase 5b — chime on incoming visitor messages (anywhere in the
  // workspace). Honors per-device localStorage override + server
  // notification prefs (disable_all / play_sound / quiet hours).
  useOperatorMessageChime(workspace?.id);

  // Header mute toggle (per-device).
  const [soundOn, setSoundOn] = useState<boolean>(() => getOperatorMessageSoundEnabled());
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean }>).detail;
      if (detail) setSoundOn(detail.enabled);
    };
    window.addEventListener('operator-message-sound-changed', onChange as EventListener);
    return () => window.removeEventListener('operator-message-sound-changed', onChange as EventListener);
  }, []);

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

  const rawSelected = conversations?.find(c => c.id === selectedId);
  if (rawSelected) selectedSnapshotRef.current = rawSelected;
  const selected = rawSelected ?? (
    selectedId && activeCallConversationId === selectedId && selectedSnapshotRef.current?.id === selectedId
      ? selectedSnapshotRef.current
      : undefined
  );

  /* Human Guidance UX — guidance surfaces (composer mode switch + sidebar
     viewer) exist only while the AI still owns the conversation. */
  const aiManagedConversation = (selected as any)?.metadata?.ai_state === 'ai_managed';



  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const openContactProfile = useCallback(() => {
    const cid = (selected as any)?.contact_id;
    if (!cid) return;
    setContactDrawerId(cid);
  }, [selected]);

  // Selection safety — when the active conversation drops out of the
  // current queue/filter (AI handoff, takeover, spam toggle, platform AI
  // disabled repair, filter change), clear the selection on desktop and
  // return to the list on mobile. We keep selection if the conversation
  // is in an active call (handled by the snapshot fallback above).
  useEffect(() => {
    if (!selectedId) return;
    if (!conversations) return; // still loading
    const inList = conversations.some(c => c.id === selectedId);
    if (inList) return;
    if (activeCallConversationId === selectedId) return;
    setSelectedId(null);
    setShowMobileList(true);
  }, [conversations, selectedId, activeCallConversationId]);

  // Deep-link scroll: once the target conversation is rendered in the list,
  // bring it into view (centered) so the operator lands right on it.
  useEffect(() => {
    const target = pendingScrollConvRef.current;
    if (!target || !conversations) return;
    if (!conversations.some(c => c.id === target)) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-conv-id="${target}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pendingScrollConvRef.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [conversations, selectedId]);

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

  // Phase 1 — operator typing emit (throttled to ≤1 publish per 2s while typing).
  // Declared early so the canned-responses onMessageChange can reference it.
  const lastTypingSentRef = useRef(0);
  const emitTyping = useCallback(() => {
    if (!workspace?.id || !selectedId) return;
    // Phase 6C — drop client-side typing when the effective policy says so.
    // Server-side suppression remains the backstop; this just avoids
    // wasting a round-trip when we know it'll be suppressed.
    if (isTypingSuppressed()) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2000) return;
    lastTypingSentRef.current = now;
    conversationsApi.sendTyping({
      workspace_id: workspace.id,
      conversation_id: selectedId,
    });
  }, [workspace?.id, selectedId]);

  // ─── Phase 6 — Canned responses integration ───
  // Locale used to rank: profile preferred locale → UI locale → 'en'.
  const { data: profile } = useProfile();
  const operatorLocale: CannedLocale = useMemo(() => {
    const candidates = [profile?.preferred_locale, (typeof window !== 'undefined' ? localStorage.getItem('app-locale') : null)];
    for (const c of candidates) {
      if (c === 'en' || c === 'fa' || c === 'tr') return c;
    }
    return 'en';
  }, [profile?.preferred_locale]);

  const trackUseMut = useTrackCannedResponseUse(workspace?.id);

  // Picker state.
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<CannedPickerHandle | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSlash, setPickerSlash] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  // Anchor index (in message) of the leading '/' for slash mode.
  const slashAnchorRef = useRef<number | null>(null);

  // Pending tracked rows: snippet of inserted body → row id.
  // We only fire track-use on real send AND only if the inserted snippet is
  // still present in the final message body (operator may have deleted it).
  const pendingTrackRef = useRef<{ id: string; snippet: string }[]>([]);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerSlash(false);
    setPickerQuery('');
    slashAnchorRef.current = null;
  }, []);

  // Reset picker when switching conversations.
  useEffect(() => { closePicker(); pendingTrackRef.current = []; }, [selectedId, closePicker]);

  // Slash-trigger detection on the current caret position.
  // A trigger exists when the character before the caret-token is line-start
  // or whitespace, the token starts with '/', and contains no spaces.
  const detectSlashTrigger = useCallback((value: string, caret: number): { anchor: number; query: string } | null => {
    if (caret <= 0) return null;
    // Walk backwards from caret to find the '/' or invalidate.
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '/') break;
      if (ch === ' ' || ch === '\n' || ch === '\t') return null;
      i--;
    }
    if (i < 0 || value[i] !== '/') return null;
    const before = i === 0 ? '\n' : value[i - 1];
    if (before !== ' ' && before !== '\n' && before !== '\t') return null;
    const query = value.slice(i + 1, caret);
    // Limit to a reasonable shortcut length.
    if (query.length > 41) return null;
    return { anchor: i, query };
  }, []);

  const onMessageChange = useCallback((value: string) => {
    setMessage(value);
    if (value) emitTyping();
    const ta = messageInputRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const trig = detectSlashTrigger(value, caret);
    if (trig) {
      slashAnchorRef.current = trig.anchor;
      setPickerSlash(true);
      setPickerOpen(true);
      setPickerQuery(trig.query);
    } else if (pickerSlash) {
      // Slash got cancelled (user deleted '/' or typed a space).
      closePicker();
    }
  }, [detectSlashTrigger, emitTyping, pickerSlash, closePicker]);

  // Insert a canned row into the current draft.
  const insertCanned = useCallback((row: CannedResponse) => {
    const ctx = {
      contact: {
        name: selected?.contacts?.name ?? null,
        email: selected?.contacts?.email ?? null,
      },
      workspace: { name: workspace?.name ?? null },
      agent: {
        name: profile?.full_name ?? null,
        first_name: (profile?.full_name ?? '').split(' ')[0] || null,
        email: profile?.email ?? user?.email ?? null,
      },
    };
    const expanded = interpolate(row.body, ctx);

    setMessage((prev) => {
      let before = '';
      let after = '';
      if (pickerSlash && slashAnchorRef.current !== null) {
        // Replace `/query` segment.
        const ta = messageInputRef.current;
        const caret = ta?.selectionStart ?? prev.length;
        before = prev.slice(0, slashAnchorRef.current);
        after = prev.slice(caret);
      } else {
        // Toolbar mode: insert at current caret (or end), wrap with newlines
        // when the existing draft is non-empty.
        const ta = messageInputRef.current;
        const caret = ta?.selectionStart ?? prev.length;
        before = prev.slice(0, caret);
        after = prev.slice(caret);
      }
      const needsLeadingSep = before.length > 0 && !/\s$/.test(before);
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
      const inserted = `${needsLeadingSep ? '\n' : ''}${expanded}${needsTrailingSpace ? ' ' : ''}`;
      // Track only the expanded body for later send-time verification.
      pendingTrackRef.current.push({ id: row.id, snippet: expanded });
      const next = before + inserted + after;
      // Restore caret after insertion.
      requestAnimationFrame(() => {
        const ta = messageInputRef.current;
        if (!ta) return;
        const pos = (before + inserted).length;
        ta.focus();
        try { ta.setSelectionRange(pos, pos); } catch { /* noop */ }
      });
      return next;
    });
    closePicker();
  }, [closePicker, pickerSlash, profile?.full_name, profile?.email, selected?.contacts?.name, selected?.contacts?.email, user?.email, workspace?.name]);

  // Fire track-use only for inserted rows whose body is still present in the
  // final sent message. We DO NOT track on preview / open / browse.
  const flushPendingTrackUse = useCallback((sentBody: string) => {
    const remaining: typeof pendingTrackRef.current = [];
    const seenIds = new Set<string>();
    for (const entry of pendingTrackRef.current) {
      if (sentBody.includes(entry.snippet) && !seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        trackUseMut.mutate(entry.id);
      }
    }
    pendingTrackRef.current = remaining;
  }, [trackUseMut]);

  /* Human Guidance UX — the composer has two modes:
     'reply' → public operator message, 'guide' → private AI steering. */
  const [composerMode, setComposerMode] = useState<'reply' | 'guide'>('reply');
  const [guidanceRequestId, setGuidanceRequestId] = useState<string | null>(null);
  const [guidanceRefresh, setGuidanceRefresh] = useState(0);

  const handleSend = async () => {
    if (!selectedId || !user) return;
    const hasText = message.trim().length > 0;
    const hasAttachment = att.status === 'ready' && !!att.attachmentId;
    if (!hasText && !hasAttachment) return;
    if (att.status === 'uploading') return; // wait for upload to finish
    // Snapshot draft, then clear UI immediately so the operator can keep
    // typing without waiting on the network round-trip. The realtime
    // publish + React-Query invalidate (in useSendMessage.onSuccess) will
    // reconcile the message into the thread within milliseconds.
    const draftBody = message;
    const draftAttachmentId = hasAttachment ? att.attachmentId : null;
    setMessage('');
    resetAttachment();
    flushPendingTrackUse(draftBody);
    sendMessage.mutate(
      { body: draftBody, attachmentId: draftAttachmentId },
      {
        onError: () => {
          // Restore draft on failure so the operator can retry without
          // losing what they typed.
          setMessage(draftBody);
        },
      },
    );
  };

  // Reset visitor typing indicator + pending attachment when switching conversations.
  useEffect(() => {
    setComposerMode('reply');
    setGuidanceRequestId(null);
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
    // Locale-aware relative time (Jalali/Tehran aware for Persian).
    return formatRelative(date);
  };

  /* Every tab shows its own number immediately — counts come from parallel
     server-side HEAD counts, not from the (filter-scoped) conversation list.
     This also keeps tab widths stable while switching filters. */
  const { data: tabCounts } = useInboxTabCounts(workspace?.id);
  const { data: colleagueDir } = useColleagues(workspace?.id);
  const colleagueUnread = colleagueDir?.total_unread ?? 0;
  const stableCounts: Record<string, number> = tabCounts ?? {};

  /* Live tabs: when a tab's counter grows (new conversation/message landed in
     that bucket) its dot blinks green until the operator opens that tab. */
  const prevCountsRef = useRef<Record<string, number> | null>(null);
  const [liveTabs, setLiveTabs] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!tabCounts) return;
    const prev = prevCountsRef.current;
    prevCountsRef.current = { ...tabCounts };
    if (!prev) return;
    const grown: Record<string, boolean> = {};
    for (const key of Object.keys(tabCounts)) {
      if ((tabCounts[key] ?? 0) > (prev[key] ?? 0)) grown[key] = true;
    }
    if (Object.keys(grown).length) setLiveTabs((s) => ({ ...s, ...grown }));
  }, [tabCounts]);
  // Opening a tab clears its "new activity" pulse.
  useEffect(() => {
    setLiveTabs((s) => (s[filter] ? { ...s, [filter]: false } : s));
  }, [filter]);
  useEffect(() => {
    if (extraChip === 'needs_human') {
      setLiveTabs((s) => (s.needs_human ? { ...s, needs_human: false } : s));
    }
  }, [extraChip]);

  const filteredConvos = useMemo(() => {
    if (!conversations) return [];
    const filtered = conversations.filter(c => {
      if (!search) return true;
      const name = conversationTitle(c, t, locale);
      return name.toLowerCase().includes(search.toLowerCase());
    });
    // Float unread conversations to the top — within each group keep the
    // existing updated_at descending order (already applied server-side).
    return [...filtered].sort((a: any, b: any) => {
      const ua = (a.unread_count ?? 0) > 0 ? 1 : 0;
      const ub = (b.unread_count ?? 0) > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return 0;
    });
  }, [conversations, search, t, locale]);

  const totalUnread = useMemo(() => {
    if (!conversations) return 0;
    return (conversations as any[]).reduce((n, c) => n + (c.unread_count ?? 0), 0);
  }, [conversations]);

  const statusLabels: Record<string, string> = {
    open: t('inbox.open') || 'Open',
    pending: t('inbox.pending') || 'Pending',
    resolved: t('inbox.resolved') || 'Resolved',
    closed: t('inbox.closed') || 'Closed',
  };

  const filterTabsNode = (
          <ToolbarPortal>
          <div
            role="tablist"
            aria-label={t('inbox.title') || 'Inbox'}
            className="flex h-full w-full items-end gap-1 overflow-x-auto scrollbar-hide px-1 -mb-px"
          >
            {(['open', 'pending', 'resolved', 'all'] as FilterStatus[]).map(s => {
              const count = stableCounts[s] || 0;
              const isActive = filter === s;
              const dotColor = s === 'open' ? 'bg-success' : s === 'pending' ? 'bg-warning' : s === 'resolved' ? 'bg-info' : s === 'closed' ? 'bg-muted-foreground' : 'bg-primary';
              return (
                <button
                  key={s}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setFilter(s)}
                  className={cn(
                    'relative flex items-center gap-1.5 px-3 h-10 rounded-t-lg text-[12.5px] font-semibold whitespace-nowrap',
                    'border border-b-0 transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-card text-primary border-border shadow-[0_-2px_10px_-4px_hsl(var(--primary)/0.35)] after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-card before:absolute before:inset-x-2 before:top-0 before:h-[2px] before:rounded-full before:bg-primary'
                      : 'bg-transparent text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  {s !== 'all' && (
                    <span className="relative flex w-2 h-2 items-center justify-center">
                      {liveTabs[s] && (
                        <span className="absolute inline-flex w-full h-full rounded-full bg-success opacity-75 animate-ping" />
                      )}
                      <span className={cn(
                        'relative inline-flex w-2 h-2 rounded-full',
                        liveTabs[s] ? 'bg-success animate-pulse' : isActive ? dotColor : 'bg-muted-foreground/30',
                      )} />
                    </span>
                  )}
                  {s === 'all' ? (t('inbox.all') || 'All') : statusLabels[s]}
                  {/* Always rendered (invisible at 0) so the tab width never
                      changes when counts load or the active tab switches. */}
                  {s !== 'all' && <span
                    aria-hidden={count === 0}
                    className={cn(
                      'text-[10.5px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1.5 font-bold tabular-nums transition-opacity duration-150',
                      count === 0 && 'opacity-0',
                      isActive ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
                    )}
                  >{count}</span>}
                </button>
              );
            })}
            {/* Extra chips: Needs human + Assigned to me. Mutually exclusive,
                toggle-off on second click. Compose with the status filter. */}
            <button
              role="tab"
              aria-selected={extraChip === 'needs_human'}
              onClick={() => setExtraChip(extraChip === 'needs_human' ? null : 'needs_human')}
              className={cn(
                'relative flex items-center gap-1.5 px-3 h-10 rounded-t-lg text-[12.5px] font-semibold whitespace-nowrap',
                'border border-b-0 transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                extraChip === 'needs_human'
                  ? 'bg-card text-destructive border-border shadow-[0_-2px_10px_-4px_hsl(var(--destructive)/0.35)] after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-card before:absolute before:inset-x-2 before:top-0 before:h-[2px] before:rounded-full before:bg-destructive'
                  : 'bg-transparent text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground'
              )}
              title={t('inbox.needsHuman') || 'Needs human'}
            >
              {liveTabs.needs_human ? (
                <span className="relative flex w-2 h-2 items-center justify-center">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-success opacity-75 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-success animate-pulse" />
                </span>
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {t('inbox.needsHuman') || 'Needs human'}
              <span
                aria-hidden={(stableCounts.needs_human || 0) === 0}
                className={cn(
                  'text-[10.5px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1.5 font-bold tabular-nums transition-opacity duration-150',
                  (stableCounts.needs_human || 0) === 0 && 'opacity-0',
                  extraChip === 'needs_human' ? 'bg-destructive/20 text-destructive' : 'bg-secondary text-muted-foreground'
                )}
              >{stableCounts.needs_human || 0}</span>
            </button>
            {/* Colleagues — internal operator-to-operator chat */}
            <button
              role="tab"
              aria-selected={extraChip === 'colleagues'}
              onClick={() => setExtraChip(extraChip === 'colleagues' ? null : 'colleagues')}
              className={cn(
                'relative flex items-center gap-1.5 px-3 h-10 rounded-t-lg text-[12.5px] font-semibold whitespace-nowrap',
                'border border-b-0 transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                extraChip === 'colleagues'
                  ? 'bg-card text-primary border-border shadow-[0_-2px_10px_-4px_hsl(var(--primary)/0.35)] after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-card before:absolute before:inset-x-2 before:top-0 before:h-[2px] before:rounded-full before:bg-primary'
                  : 'bg-transparent text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground'
              )}
              title={t('inbox.colleagues') || 'Colleagues'}
            >
              {colleagueUnread > 0 && extraChip !== 'colleagues' ? (
                <span className="relative flex w-2 h-2 items-center justify-center">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-success opacity-75 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-success animate-pulse" />
                </span>
              ) : (
                <Users className="w-4 h-4" />
              )}
              {t('inbox.colleagues') || 'Colleagues'}
              <span
                aria-hidden={colleagueUnread === 0}
                className={cn(
                  'text-[10.5px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1.5 font-bold tabular-nums transition-opacity duration-150',
                  colleagueUnread === 0 && 'opacity-0',
                  extraChip === 'colleagues' ? 'bg-primary/20 text-primary' : 'bg-primary text-primary-foreground'
                )}
              >{colleagueUnread > 99 ? '99+' : colleagueUnread}</span>
            </button>
          </div>
          </ToolbarPortal>
  );

  if (extraChip === 'colleagues') {
    return (
      <div className="flex h-full" dir={dir}>
        {filterTabsNode}
        <TeamChatPanel />
      </div>
    );
  }

  return (
    <div className="flex h-full" dir={dir}>
      {/* ═══════ LEFT: Conversation List ═══════ */}
      <div className={cn(
        'w-full md:w-[300px] lg:w-[340px] xl:w-[380px] shrink-0 border-e border-border flex flex-col bg-card',
        selectedId && !showMobileList ? 'hidden md:flex' : 'flex'
      )}>
        {/* Header */}
        <div className="p-3 border-b border-border space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Inbox className="w-[18px] h-[18px] text-primary" />
              <h2 className="text-[15px] font-bold text-foreground">{t('inbox.title') || 'Inbox'}</h2>
              <span className="text-[11px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-semibold tabular-nums">
                {conversations?.length || 0}
              </span>
              {totalUnread > 0 && (
                <span
                  className="text-[11px] bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full font-bold shadow-sm animate-fade-in"
                  title={`${totalUnread} ${t('inbox.unread') || 'Unread'}`}
                >
                  {totalUnread > 99 ? '99+' : totalUnread} {t('inbox.newBadge') || 'new'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                aria-label={t('inbox.refresh') || 'Refresh'}
                title={t('inbox.refresh') || 'Refresh'}
                onClick={() => qc.invalidateQueries({ queryKey: ['conversations'] })}
                className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              <button
                aria-label={soundOn ? (t('inbox.muteSound') || 'Mute message sound') : (t('inbox.unmuteSound') || 'Unmute message sound')}
                title={soundOn ? (t('inbox.muteSound') || 'Mute message sound') : (t('inbox.unmuteSound') || 'Unmute message sound')}
                onClick={() => {
                  const next = !soundOn;
                  setOperatorMessageSoundEnabled(next);
                  setSoundOn(next);
                }}
                className={cn(
                  'p-2 rounded-md hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  soundOn ? 'text-muted-foreground hover:text-foreground' : 'text-destructive hover:text-destructive'
                )}
              >
                {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              <button
                aria-label={t('inbox.newConversation') || 'New conversation'}
                title={t('inbox.newConversation') || 'New conversation'}
                className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="w-4 h-4" />
              </button>
              {isGlobalAdmin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    title={t('inbox.deleteAllTip') || 'Delete all conversations'}
                    aria-label={t('inbox.deleteAllTip') || 'Delete all conversations'}
                    disabled={!conversations?.length || deleteAll.isPending}
                    className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deleteAll.isPending
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <Trash2 className="w-4 h-4" />}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent dir={dir}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('inbox.deleteAllTitle') || 'Delete all conversations?'}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {(t('inbox.deleteAllDesc') || 'This will permanently delete all {{count}} conversation(s).').replace('{{count}}', String(conversations?.length || 0))}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('inbox.cancel') || 'Cancel'}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteAll}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('inbox.deleteAllConfirm') || 'Delete all'}
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
              className={cn('h-9 text-[13px] bg-secondary/50 border-transparent focus:border-primary/30', dir === 'rtl' ? 'pr-8' : 'pl-8')}
              dir={dir}
            />
          </div>

          {/* Queue header (Automated / Needs human) — replaces status tabs */}
          {isQueueMode ? (
            <div className="flex items-center gap-2 px-1 py-1">
              {queue === 'automated' ? (
                <>
                  <Bot className="w-3.5 h-3.5 text-primary" />
                  <span className="text-[12px] font-semibold text-foreground">{t('inbox.automatedInbox') || 'Automated'}</span>
                  <span className="text-[11px] text-muted-foreground truncate">{t('inbox.automatedDesc') || 'AI-managed conversations'}</span>
                </>
              ) : (
                <>
                  <Ban className="w-3.5 h-3.5 text-warning" />
                  <span className="text-[12px] font-semibold text-foreground">{t('inbox.spamInbox') || 'Spam'}</span>
                  <span className="text-[11px] text-muted-foreground truncate">{t('inbox.spamDesc') || 'Quarantined conversations'}</span>
                </>
              )}
              <span className="ms-auto text-[11px] bg-secondary text-foreground/70 px-1.5 py-0.5 rounded-full font-bold tabular-nums">
                {conversations?.length || 0}
              </span>
            </div>
          ) : (
          /* Filter tabs (status + extra chips) — hosted in the app top bar */
          filterTabsNode
          )}
        </div>

        {/* Conversation items */}
        <ScrollArea className="flex-1 [&>div>div]:!block">
          {isLoading ? (
            <div className="px-3 py-3 space-y-2" dir={dir} aria-busy="true" aria-label="Loading conversations">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 p-2 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-secondary/60 shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 bg-secondary/60 rounded w-3/4" />
                    <div className="h-2.5 bg-secondary/40 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : !filteredConvos?.length ? (
            <div className="py-16 px-6 text-center flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-secondary/40 flex items-center justify-center">
                {queue === 'automated' ? (
                  <Bot className="w-7 h-7 text-muted-foreground/40" />
                ) : queue === 'spam' ? (
                  <Ban className="w-7 h-7 text-muted-foreground/40" />
                ) : extraChip === 'needs_human' ? (
                  <AlertCircle className="w-7 h-7 text-muted-foreground/40" />
                ) : (
                  <MessageSquare className="w-7 h-7 text-muted-foreground/40" />
                )}
              </div>
              <div>
                <p className="text-[13px] font-medium text-foreground">
                  {search
                    ? t('inbox.emptyNoMatches')
                    : queue === 'automated'
                      ? t('inbox.emptyAutomated')
                      : queue === 'spam'
                        ? t('inbox.emptySpam')
                        : extraChip === 'needs_human'
                          ? t('inbox.emptyNeedsHuman')
                          : (t('inbox.emptyNoConversations') || t('inbox.noMessages'))}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {search
                    ? `"${search}"`
                    : queue === 'automated'
                      ? t('inbox.emptyAutomatedHint')
                      : queue === 'spam'
                        ? t('inbox.emptySpamHint')
                        : extraChip === 'needs_human'
                          ? t('inbox.emptyNeedsHumanHint')
                          : (filter !== 'all' ? statusLabels[filter] : '')}
                </p>
              </div>
            </div>
          ) : (
            filteredConvos.map(conv => {
              const isActive = selectedId === conv.id;
              const name = conversationTitle(conv, t, locale);
              const unreadCount = (conv as any).unread_count ?? 0;
              const hasUnread = unreadCount > 0 && !isActive;

              return (
                <div
                  key={conv.id}
                  data-conv-id={conv.id}
                  onClick={() => { setSelectedId(conv.id); setShowMobileList(false); }}
                  className={cn(
                    'group/item relative px-3 py-3 cursor-pointer transition-colors border-b border-border/30',
                    isActive
                      ? 'bg-primary/[0.07]'
                      : hasUnread
                        ? 'bg-primary/[0.04] hover:bg-primary/[0.08]'
                        : 'hover:bg-secondary/40'
                  )}
                  dir={dir}
                >
                  {/* Active / unread indicator rail (LTR/RTL aware) */}
                  {(isActive || hasUnread) && (
                    <div className={cn(
                      'absolute top-0 bottom-0 w-[3px] rounded-full',
                      isActive ? 'bg-primary' : 'bg-primary/70',
                      dir === 'rtl' ? 'right-0' : 'left-0',
                    )} />
                  )}
                  <div className="flex items-start gap-3">
                    {/* Avatar — gradient initials, online dot driven by status */}
                    <div className="relative shrink-0">
                      <ContactAvatar
                        name={conv.contacts?.name}
                        email={conv.contacts?.email}
                        avatarUrl={conv.contacts?.avatar_url}
                        os={(conv as any).visitor_os}
                        device={(conv as any).visitor_device}
                        countryCode={(conv as any).visitor_country_code}
                        countryName={localizedCountryName((conv as any).visitor_country_code, locale, (conv as any).visitor_country_name)}
                        size="lg"
                        ringClassName={
                          isActive ? 'ring-primary/40'
                          : hasUnread ? 'ring-primary/50'
                          : 'ring-border/50'
                        }
                      />
                      {/* Status dot — small, neutral; uses semantic status color */}
                      <span className={cn(
                        'absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card',
                        statusDots[conv.status ?? 'open'],
                      )} />
                    </div>

                    {/* Content */}
                    <div className={cn('flex-1 min-w-0', dir === 'rtl' ? 'text-right' : 'text-left')}>
                      {/* Row 1: Name + time */}
                      <div className="flex items-baseline justify-between gap-2 mb-0.5">
                        <span className={cn(
                          'truncate leading-tight flex items-center gap-1.5 min-w-0',
                          hasUnread ? 'text-[14px] font-bold text-foreground' : 'text-[14px] font-medium text-foreground/85',
                        )}>
                          {hasUnread && (
                            <span
                              className="w-2 h-2 rounded-full bg-primary shrink-0 shadow-[0_0_0_3px_hsl(var(--primary)/0.18)] animate-pulse"
                              aria-label={t('inbox.unread') || 'Unread'}
                            />
                          )}
                          <span className="truncate">{name}</span>
                          {(() => {
                            const ch = resolveChannelKey((conv as any)?.metadata, (conv as any)?.contacts?.metadata);
                            return ch === 'widget' ? null : <ChannelBadge channel={ch} t={t as any} size="xs" className="shrink-0" />;
                          })()}
                        </span>
                        <span className={cn(
                          'text-[11px] shrink-0 tabular-nums',
                          hasUnread ? 'text-primary font-semibold' : 'text-muted-foreground',
                        )} dir="auto">
                          {conv.updated_at ? timeAgo(conv.updated_at) : ''}
                        </span>
                      </div>
                      {/* Row 2: Subject / preview */}
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <p className={cn(
                          'text-[12.5px] truncate leading-snug flex-1 min-w-0',
                          hasUnread ? 'text-foreground font-medium' : 'text-muted-foreground',
                        )}>
                          {(() => {
                            const last = (conv as any).last_message as
                              | { body: string; sender_type: string }
                              | null
                              | undefined;
                            if (last?.body) {
                              const prefix =
                                last.sender_type === 'agent' ? `${t('inbox.previewYou') || 'You'}: `
                                : (last.sender_type === 'ai' || last.sender_type === 'bot') ? `${t('inbox.previewAi') || 'AI'}: `
                                : '';
                              return `${prefix}${last.body}`;
                            }
                            return isPlaceholderSubject(conv.subject)
                              ? (t('inbox.noMessages') || 'No messages yet')
                              : conv.subject;
                          })()}
                        </p>
                        {hasUnread && unreadCount > 0 && (
                          <span
                            className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold tabular-nums shadow-sm"
                            aria-label={`${unreadCount} ${t('inbox.unreadAria') || 'unread messages'}`}
                          >
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </div>
                      {/* Row 3: Status + meta */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn(
                          'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium',
                          'bg-secondary/60 text-foreground/70',
                        )}>
                          <span className={cn('w-1.5 h-1.5 rounded-full', statusDots[conv.status ?? 'open'])} />
                          {statusLabels[conv.status ?? 'open']}
                        </span>
                        {conv.priority && conv.priority !== 'normal' && (
                          <span className={cn(
                            'text-[11px] px-2 py-0.5 rounded-md font-medium bg-secondary/60',
                            priorityColors[conv.priority] || 'text-muted-foreground',
                          )}>
                            {t(`inbox.priority_${conv.priority}`) || conv.priority}
                          </span>
                        )}
                        {conv.assigned_to && (
                          <span className="text-[11px] text-muted-foreground/60 flex items-center" title={t('inbox.assigned') || 'Assigned'}>
                            <UserCheck className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {/* AI lifecycle badge — Automated / Needs human / Human active */}
                        {(() => {
                          const aiState = (conv as any)?.metadata?.ai_state
                            || (conv as any)?.ai_state;
                          if (!aiState) return null;
                          const reason = (conv as any)?.metadata?.ai_handoff_reason as string | undefined;
                          if (aiState === 'ai_managed') {
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium bg-primary/10 text-primary border border-primary/20"
                                title={t('inbox.aiManagedTip') || 'AI is currently handling this conversation'}
                              >
                                <Bot className="w-3 h-3" /> AI
                              </span>
                            );
                          }
                          if (aiState === 'needs_human') {
                            const titleText = reason
                              ? `${t('inbox.handoffReason') || 'Handoff reason'}: ${reason}`
                              : (t('inbox.needsHumanTip') || 'AI handed off — needs human');
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium bg-destructive/10 text-destructive border border-destructive/20"
                                title={titleText}
                              >
                                <AlertCircle className="w-3 h-3" /> {t('inbox.needsHuman') || 'Needs human'}
                              </span>
                            );
                          }
                          if (aiState === 'human_active') {
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium bg-secondary text-foreground/70 border border-border"
                                title={t('inbox.humanActiveTip') || 'Operator has taken over'}
                              >
                                <UserCheck className="w-3 h-3" /> {t('inbox.human') || 'Human'}
                              </span>
                            );
                          }
                          return null;
                        })()}
                        {/* Inline take-over action on Automated / Needs human rows */}
                        {(() => {
                          const aiState = (conv as any)?.metadata?.ai_state
                            || (conv as any)?.ai_state;
                          if (aiState !== 'ai_managed' && aiState !== 'needs_human') return null;
                          // Don't offer take-over on spam rows.
                          if ((conv as any)?.is_spam) return null;
                          return (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!workspace?.id) return;
                                try {
                                  await aiAgentApi.takeOverConversation(workspace.id, conv.id, true);
                                  toast({ title: t('inbox.takenOverTitle') || 'Taken over', description: t('inbox.takenOverDesc') || 'AI will stop auto-replying.' });
                                  qc.invalidateQueries({ queryKey: ['conversations', workspace.id] });
                                  qc.invalidateQueries({ queryKey: ['inbox-counts', workspace.id] });
                                  qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspace.id] });
                                } catch (err: any) {
                                  toast({ title: t('inbox.takeOverFailed') || 'Take-over failed', description: err?.message || '—', variant: 'destructive' });
                                }
                              }}
                              className="text-[11px] px-2 py-0.5 rounded-md font-semibold bg-secondary hover:bg-primary hover:text-primary-foreground text-foreground/70 transition-colors"
                              title={t('inbox.takeOverTip') || 'Take over this conversation'}
                            >
                              {t('inbox.takeOver') || 'Take over'}
                            </button>
                          );
                        })()}
                        {/* Spam badge — visible in any queue when flagged */}
                        {(conv as any)?.is_spam && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium bg-warning/15 text-warning border border-warning/30"
                            title={t('inbox.markedSpamTitle') || 'Marked as spam'}
                          >
                            <Ban className="w-3 h-3" /> {t('inbox.spam') || 'Spam'}
                          </span>
                        )}
                        {/* Selected-conversation typing indicator (live) */}
                        {isActive && visitorTypingActive && (
                          <span className="ms-auto inline-flex items-center gap-1 text-[11px] text-primary font-medium" aria-label={t('inbox.visitorTyping') || 'typing…'}>
                            <span className="flex gap-0.5">
                              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '120ms' }} />
                              <span className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: '240ms' }} />
                            </span>
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
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground bg-background px-6 text-center">
            {wsBranding?.logo_url ? (
              <img
                src={wsBranding.logo_url}
                alt={workspace?.name || 'workspace logo'}
                className="w-16 h-16 mb-4 rounded-2xl object-contain bg-card p-2 border border-border"
                style={{ boxShadow: 'var(--shadow-glow)' }}
              />
            ) : (
              <div className="w-16 h-16 rounded-2xl bg-primary mb-4 flex items-center justify-center" style={{ boxShadow: 'var(--shadow-glow)' }}>
                <MessageCircle className="h-8 w-8 text-primary-foreground" />
              </div>
            )}
            <h2 className="text-lg font-semibold text-foreground">{workspace?.name || t('nav.inbox') || 'Inbox'}</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              {t('inbox.selectConversation') || 'Select a conversation to start replying'}
            </p>
          </div>
        ) : (
          <>
            {/* ── Chat Header — Desktop ── */}
            <div className="hidden md:flex px-4 py-2.5 border-b border-border items-center justify-between shrink-0 bg-card/50">
              <div className="flex items-center gap-2.5">
                <div className="relative">
                  <ContactAvatar
                    name={selected.contacts?.name}
                    email={selected.contacts?.email}
                    avatarUrl={selected.contacts?.avatar_url}
                    os={(selected as any)?.visitor_os}
                    device={(selected as any)?.visitor_device}
                    countryCode={(selected as any)?.visitor_country_code}
                    countryName={localizedCountryName((selected as any)?.visitor_country_code, locale, (selected as any)?.visitor_country_name)}
                    size="md"
                  />
                  {presence && presence.status !== 'unknown' ? (
                    <span className="absolute -bottom-0.5 -end-0.5 rounded-full bg-card p-[1.5px] shadow-sm">
                      <PresenceDot state={presence.status as 'online' | 'idle' | 'offline'} size={12} />
                    </span>
                  ) : (
                    <div className={cn('absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card', statusDots[selected.status ?? 'open'])} />
                  )}
                </div>
                <div>
                  <button
                    type="button"
                    onClick={openContactProfile}
                    disabled={!(selected as any)?.contact_id}
                    className="text-[14.5px] font-bold text-foreground hover:text-primary transition-colors disabled:hover:text-foreground disabled:cursor-default text-start"
                    title={t('inbox.openContact') || 'View contact'}
                  >
                    {conversationTitle(selected, t, locale)}
                  </button>
                  <div className="text-[12px] text-muted-foreground flex items-center gap-1.5">
                    {(() => {
                      const ch = resolveChannelKey((selected as any)?.metadata, (selected as any)?.contacts?.metadata);
                      return ch === 'widget' ? null : <ChannelBadge channel={ch} t={t as any} size="xs" />;
                    })()}
                    {selected.contacts?.email && <span className="truncate">{selected.contacts.email}</span>}
                    {presence && presence.status !== 'unknown' && (
                      <>
                        {selected.contacts?.email && <span className="opacity-30">•</span>}
                        <PresenceBadge
                          state={presence.status as 'online' | 'idle' | 'offline'}
                          title={presence.current_page || undefined}
                          label={
                            presence.status === 'online'
                              ? (t('inbox.presenceOnline') || 'Online')
                              : presence.status === 'idle'
                                ? (t('inbox.presenceIdle') || 'Idle')
                                : (t('inbox.presenceOffline') || 'Offline')
                          }
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {(selected as any)?.metadata?.ai_state === 'ai_managed' && (
                  <>
                    <Badge variant="secondary" className="text-[11px] gap-1">
                      <Bot className="w-3.5 h-3.5" /> {t('inbox.aiManaged') || 'AI managed'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-3 text-[11.5px] font-semibold"
                      onClick={async () => {
                        if (!workspace?.id || !selectedId) return;
                        try {
                          await aiAgentApi.takeOverConversation(workspace.id, selectedId, true);
                          toast({ title: t('inbox.takenOverTitle') || 'Conversation taken over', description: t('inbox.takenOverDesc') || 'AI will stop auto-replying.' });
                          qc.invalidateQueries({ queryKey: ['conversations', workspace.id] });
                          qc.invalidateQueries({ queryKey: ['inbox-counts', workspace.id] });
                                  qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspace.id] });
                        } catch (e: any) {
                          toast({ title: t('inbox.takeOverFailed') || 'Take-over failed', description: e?.message || '—', variant: 'destructive' });
                        }
                      }}
                    >
                      <UserCheck className={cn('w-3.5 h-3.5', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                      {t('inbox.takeOver') || 'Take over'}
                    </Button>
                  </>
                )}
                {(selected as any)?.metadata?.ai_state === 'needs_human' && (
                  <>
                    <Badge
                      variant="destructive"
                      className="text-[11px] gap-1"
                      title={
                        ((selected as any)?.metadata?.ai_handoff_reason as string)
                          ? `${t('inbox.handoffReason') || 'Handoff reason'}: ${(selected as any).metadata.ai_handoff_reason}`
                          : (t('inbox.needsHumanTip') || 'AI handed off — needs human')
                      }
                    >
                      <AlertCircle className="w-3.5 h-3.5" /> {t('inbox.needsHuman') || 'Needs human'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-3 text-[11.5px] font-semibold"
                      onClick={async () => {
                        if (!workspace?.id || !selectedId) return;
                        try {
                          await aiAgentApi.takeOverConversation(workspace.id, selectedId, true);
                          toast({ title: t('inbox.takenOverTitle') || 'Conversation taken over', description: t('inbox.takenOverDesc') || 'Assigned to you.' });
                          qc.invalidateQueries({ queryKey: ['conversations', workspace.id] });
                          qc.invalidateQueries({ queryKey: ['inbox-counts', workspace.id] });
                                  qc.invalidateQueries({ queryKey: ['inbox-tab-counts', workspace.id] });
                        } catch (e: any) {
                          toast({ title: t('inbox.takeOverFailed') || 'Take-over failed', description: e?.message || '—', variant: 'destructive' });
                        }
                      }}
                    >
                      <UserCheck className={cn('w-3.5 h-3.5', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                      {t('inbox.takeOver') || 'Take over'}
                    </Button>
                  </>
                )}
                {(selected as any)?.metadata?.ai_state === 'human_active' && (
                  <Badge variant="outline" className="text-[11px] gap-1">
                    <UserCheck className="w-3.5 h-3.5" /> {t('inbox.humanActive') || 'Human active'}
                  </Badge>
                )}
                {(selected as any)?.is_spam && (
                  <Badge
                    variant="outline"
                    className="text-[11px] gap-1 border-warning/40 text-warning bg-warning/10"
                    title={t('inbox.spamTip') || 'This conversation is marked as spam.'}
                  >
                    <Ban className="w-3.5 h-3.5" /> {t('inbox.spam') || 'Spam'}
                  </Badge>
                )}
                <button
                  aria-label={showSidebar ? (t('inbox.hideDetails') || 'Hide details') : (t('inbox.showDetails') || 'Show details')}
                  title={showSidebar ? (t('inbox.hideDetails') || 'Hide details') : (t('inbox.showDetails') || 'Show details')}
                  onClick={() => activeCallConversationId === selectedId ? setShowSidebar(true) : setShowSidebar(!showSidebar)}
                  className={cn(
                    'p-2 rounded-md transition-colors',
                    showSidebar ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  )}
                >
                  <Eye className="w-4 h-4" />
                </button>
                <button className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ── Chat Header — Mobile ── */}
            <div className="md:hidden flex items-center gap-2 px-2 py-2 bg-card/60 border-b border-border/50 shrink-0">
              <button
                aria-label={t('inbox.back') || 'Back to conversations'}
                onClick={() => { setSelectedId(null); setShowMobileList(true); }}
                className="p-2 -m-1 rounded-xl hover:bg-secondary text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {dir === 'rtl' ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
              </button>
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                {selected.contacts?.avatar_url ? (
                  <img src={selected.contacts.avatar_url} alt="" className="w-full h-full object-cover" />
                ) : (
                <span className="text-sm font-bold text-primary">
                  {getInitials(selected.contacts?.name, selected.contacts?.email)}
                </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-bold text-foreground truncate">
                  {conversationTitle(selected, t, locale)}
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <span className={cn('px-1.5 py-0.5 rounded-full text-[10.5px] font-medium border', statusColors[selected.status ?? 'open'])}>
                    {statusLabels[selected.status ?? 'open']}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {selected.status === 'open' && (
                  <button
                    aria-label={t('inbox.resolve') || 'Resolve'}
                    onClick={() => workspace?.id && updateConv.mutate({ id: selectedId, workspace_id: workspace.id, status: 'resolved' })}
                    className="p-2 rounded-xl text-success hover:bg-success/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CheckCircle2 className="w-5 h-5" />
                  </button>
                )}
                <button
                  aria-label={showSidebar ? (t('inbox.hideDetails') || 'Hide details') : (t('inbox.showDetails') || 'Show details')}
                  aria-expanded={showSidebar}
                  onClick={() => activeCallConversationId === selectedId ? setShowSidebar(true) : setShowSidebar(!showSidebar)}
                  className="p-2 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Eye className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* ── Messages Area ──
                Operator UI convention: "you" (agent/AI) align RIGHT, visitor LEFT.
                Mirrors WhatsApp/Intercom/Crisp behavior so operators read their
                own replies on the side closest to the composer. */}
            <div
              className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-4 bg-background overscroll-contain"
              ref={messagesContainerRef}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
            >
              {rawMessages?.map((msg, idx) => {
                const isVisitor = msg.sender_type === 'contact';
                const isAgent = !isVisitor;
                const isAi = msg.sender_type === 'ai';
                const prev = idx > 0 ? rawMessages[idx - 1] : null;
                const senderKey = (item: typeof msg | null) => {
                  if (!item) return '';
                  if (item.sender_type === 'agent') return `agent:${item.sender_id || 'unknown'}`;
                  if (item.sender_type === 'ai' || item.sender_type === 'bot') return 'ai';
                  if (item.sender_type === 'contact') return `contact:${item.sender_id || selected?.contact_id || 'visitor'}`;
                  return `${item.sender_type}:${item.sender_id || 'system'}`;
                };
                // Day separator — a new calendar day starts a fresh divider.
                const dayKey = (d?: string | null) => (d ? new Date(d).toDateString() : '');
                const showDaySeparator = !prev || dayKey(prev.created_at) !== dayKey(msg.created_at);
                // Channel menu taps (e.g. Telegram bot buttons) are navigation,
                // not conversation content: consecutive taps collapse into a
                // single horizontal strip so they never mix with real messages.
                const isMenuEvent = (m: unknown) =>
                  String(((m as any)?.metadata || {}).channel_menu_event || '') === 'true';
                const sameSenderAsPrev = !!prev
                  && !showDaySeparator
                  && !isMenuEvent(prev)
                  && !isMenuEvent(msg)
                  && senderKey(prev) === senderKey(msg);
                const dayLabel = (() => {
                  const d = new Date(msg.created_at);
                  const today = new Date();
                  const yesterday = new Date(Date.now() - 86400000);
                  if (d.toDateString() === today.toDateString()) return t('inbox.today') || 'Today';
                  if (d.toDateString() === yesterday.toDateString()) return t('inbox.yesterday') || 'Yesterday';
                  return formatLongDate(d);
                })();
                const senderName = (msg as any).sender_name as string | null | undefined;
                const senderAvatar = (msg as any).sender_avatar as string | null | undefined;
                const agentLabel = isAi
                  ? (senderName || t('inbox.aiAssistant') || 'AI assistant')
                  : (senderName || t('inbox.support') || 'Support');
                // One identity marker per consecutive sender group. A different
                // operator, AI/visitor switch, or new day starts a fresh group.
                const showAvatar = !sameSenderAsPrev;
                const showMeta = !sameSenderAsPrev;
                // Pass A — system call_ended summary renders as a centered
                // pill, not as an operator/visitor bubble.
                const meta = (msg as { metadata?: Record<string, unknown> | null }).metadata || {};

                if (isMenuEvent(msg)) {
                  if (prev && isMenuEvent(prev)) return null;
                  const run: typeof rawMessages = [];
                  for (let i = idx; i < (rawMessages?.length || 0); i++) {
                    if (!isMenuEvent(rawMessages[i])) break;
                    run.push(rawMessages[i]);
                  }
                  return (
                    <div key={msg.id} className="flex justify-center my-3">

                      <div className="max-w-full">
                        <div className="flex items-center justify-center gap-1.5 flex-wrap px-1">

                          <span className="text-[10px] text-muted-foreground/70 shrink-0">
                            {t('inbox.menuTaps') && !t('inbox.menuTaps').startsWith('inbox.')
                              ? t('inbox.menuTaps')
                              : 'Menu'}
                          </span>
                          {run.map((item) => (
                            <span
                              key={item.id}
                              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-muted/50 border border-border/50 text-[11px] text-muted-foreground whitespace-nowrap"
                            >
                              {item.body}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                }


                // Routing system notices are stored in English by the server;
                // render them from metadata so they follow the app locale.
                if (msg.sender_type === 'system' && (meta as any).kind === 'routing_agent_joined') {
                  const name = String((meta as any).agent_name || '').trim();
                  const tpl = name ? t('inbox.system.agentJoined') : t('inbox.system.agentJoinedGeneric');
                  const text = tpl && !tpl.startsWith('inbox.')
                    ? tpl.replace('{name}', name)
                    : (name ? `${name} joined the conversation` : 'A colleague joined the conversation');
                  return (
                    <div key={msg.id} className="flex justify-center my-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-[11px] border border-border/60">
                        <span>{text}</span>
                      </div>
                    </div>
                  );
                }
                if (msg.sender_type === 'system' && (meta as any).kind === 'routing_no_agent_available') {
                  const tpl = t('inbox.system.noAgentAvailable');
                  const text = tpl && !tpl.startsWith('inbox.')
                    ? tpl
                    : "All our colleagues are currently busy. Your message was recorded and we'll respond as soon as we can.";
                  return (
                    <div key={msg.id} className="flex justify-center my-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-[11px] border border-border/60">
                        <span>{text}</span>
                      </div>
                    </div>
                  );
                }
                if (msg.sender_type === 'system' && (meta as any).kind === 'call_ended') {

                  const endedBy = String((meta as any).ended_by || 'system');
                  const endReason = String((meta as any).end_reason || '');
                  const dur = Number((meta as any).duration_seconds || 0);
                  const fmtDur = (() => {
                    const s = Math.max(0, Math.floor(dur));
                    const hh = Math.floor(s / 3600);
                    const mm = Math.floor((s % 3600) / 60);
                    const ss = s % 60;
                    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
                    return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
                  })();
                  const isMissed = endReason === 'failed' || dur <= 0;
                  const key =
                    isMissed
                      ? 'inbox.callEnded.summary.notConnected'
                      : endedBy === 'operator'
                        ? 'inbox.callEnded.summary.byOperator'
                        : endedBy === 'visitor'
                          ? 'inbox.callEnded.summary.byVisitor'
                          : 'inbox.callEnded.summary.bySystem';
                  const fallback = isMissed
                    ? 'Call did not connect'
                    : endedBy === 'operator'
                      ? `Call ended by operator · Duration ${fmtDur}`
                      : endedBy === 'visitor'
                        ? `Call ended by visitor · Duration ${fmtDur}`
                        : `Call ended · Duration ${fmtDur}`;
                  const raw = t(key);
                  const text = raw && raw !== key
                    ? raw.replace('{duration}', fmtDur)
                    : fallback;
                  return (
                    <div key={msg.id} className="flex justify-center my-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-[11px] border border-border/60">
                        <PhoneOff className="w-3 h-3" />
                        <span>{text}</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={msg.id}>
                  {showDaySeparator && (
                    <div className="flex items-center gap-3 my-3">
                      <div className="h-px flex-1 bg-border/70" />
                      <span className="text-[11px] font-medium text-muted-foreground px-2.5 py-0.5 rounded-full bg-muted/60 border border-border/50">
                        {dayLabel}
                      </span>
                      <div className="h-px flex-1 bg-border/70" />
                    </div>
                  )}
                  <div
                    dir="ltr"
                    className={cn(
                      'flex gap-2.5 group',
                      isAgent ? 'flex-row-reverse' : 'flex-row',
                      sameSenderAsPrev ? '-mt-3' : '',
                    )}
                  >
                    {/* Avatar — hidden on grouped follow-ups, replaced by spacer */}
                    {showAvatar ? (
                      isAgent ? (
                        <div className={cn(
                          'w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-0.5 shadow-sm ring-1 overflow-hidden text-[12px] font-bold',
                          isAi
                            ? 'bg-accent/30 text-accent-foreground ring-accent/40'
                            : 'bg-primary/15 text-primary ring-primary/20',
                        )}
                          title={agentLabel}
                        >
                          {!isAi && senderAvatar ? (
                            <img src={senderAvatar} alt={agentLabel} className="w-full h-full object-cover" />
                          ) : isAi ? (
                            <Bot className="w-[18px] h-[18px]" />
                          ) : senderName ? (
                            <span>{getInitials(senderName)}</span>
                          ) : (
                            <User className="w-[18px] h-[18px]" />
                          )}
                        </div>
                      ) : (
                        <ContactAvatar
                          name={selected?.contacts?.name}
                          email={selected?.contacts?.email}
                          avatarUrl={selected?.contacts?.avatar_url}
                          os={(selected as any)?.visitor_os}
                          device={(selected as any)?.visitor_device}
                          countryCode={(selected as any)?.visitor_country_code}
                          countryName={localizedCountryName((selected as any)?.visitor_country_code, locale, (selected as any)?.visitor_country_name)}
                          size="sm"
                          className="mt-0.5"
                        />
                      )
                    ) : (
                      <div className="w-9 shrink-0" aria-hidden />
                    )}
                    <div className={cn('max-w-[82%] sm:max-w-[75%] flex flex-col min-w-0', isAgent ? 'items-end' : 'items-start')}>
                      {showMeta && (
                        <div dir={dir} className="text-[11px] text-muted-foreground mb-1 flex items-center gap-1.5">
                          <span className="font-medium">
                            {isAgent
                              ? agentLabel
                              : contactDisplayName(selected?.contacts, selected?.contact_id ?? selectedId, t, selected?.visitor_network?.geo, locale)}
                          </span>
                          {isAi && (
                            <span className="px-1.5 py-px rounded bg-accent/40 text-accent-foreground text-[10px] font-semibold uppercase tracking-wide">
                              {t('inbox.auto') || 'AUTO'}
                            </span>
                          )}
                          <span className="opacity-30">•</span>
                          <bdi title={formatDateTime(msg.created_at)}>{formatTime(msg.created_at)}</bdi>
                        </div>
                      )}
                      <div dir={dir} className={cn(
                        'rounded-2xl px-4 py-2.5 text-[14px] leading-[1.7] shadow-sm',
                        isAgent
                          ? 'bg-primary text-primary-foreground rounded-br-sm'
                          : 'bg-secondary text-foreground rounded-bl-sm'
                      )}>
                        {(msg as { attachment?: MessageAttachment | null }).attachment && (
                          <MessageAttachmentView att={(msg as { attachment: MessageAttachment }).attachment} t={t} />
                        )}
                        {msg.body && <p className={cn((msg as any).attachment ? 'mt-2' : '', 'whitespace-pre-wrap break-words')}>{msg.body}</p>}
                      </div>
                      {/* Hover actions + seen state */}
                      <div className={cn(
                        'flex items-center gap-2 mt-1 h-3.5',
                        isAgent ? 'flex-row-reverse' : 'flex-row',
                      )}>
                        <button
                          onClick={() => { navigator.clipboard.writeText(msg.body); toast({ title: t('inbox.copied') || 'Copied to clipboard' }); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-0.5 rounded"
                          aria-label={t('inbox.copy') || 'Copy message'}
                          title={t('inbox.copy') || 'Copy message'}
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        {isAgent && (msg as { seen_at?: string | null }).seen_at && idx === rawMessages.length - 1 && (
                          <span className="text-[11px] text-primary/70 font-medium flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> {t('inbox.seen') || 'Seen'}
                          </span>
                        )}
                      </div>
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
                  {contactDisplayName(selected?.contacts, selected?.contact_id ?? selectedId, t, selected?.visitor_network?.geo, locale)} {t('inbox.visitorTyping') || 'typing…'}
                </span>
              </div>
            )}

            {/* ── Input Area ── */}
            <div
              className="border-t border-border px-3 py-3 bg-card/60 shrink-0"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
              dir={dir}
            >
              {/* Phase 2 — AI Agent suggestion card (suggest_only mode).
                  Visitor never sees this. "Send now" delivers as a normal
                  operator message, not as an AI message. */}
              {selectedId && (
                <AiSuggestionCard
                  conversationId={selectedId}
                  dir={dir}
                  t={t}
                  onInsert={(text) => {
                    setMessage((prev) => (prev ? `${prev}\n${text}` : text));
                    requestAnimationFrame(() => {
                      messageInputRef.current?.focus();
                    });
                  }}
                  onSendNow={(text) =>
                    new Promise<boolean>((resolve) => {
                      if (!user) { resolve(false); return; }
                      sendMessage.mutate(
                        { body: text, attachmentId: null },
                        {
                          onSuccess: () => resolve(true),
                          onError: () => resolve(false),
                        },
                      );
                    })
                  }
                />
              )}
              {selectedId && workspace?.id && (
                <OperatorAssistPanel
                  workspaceId={workspace.id}
                  conversationId={selectedId}
                  composerHasText={!!message.trim()}
                  dir={dir}
                  onInsert={(text, mode) => {
                    setMessage((prev) =>
                      mode === 'append' && prev
                        ? `${prev}\n\n---\nAI draft:\n${text}`
                        : text,
                    );
                    requestAnimationFrame(() => messageInputRef.current?.focus());
                  }}
                />
              )}
              {/* Human Guidance UX — composer mode switch. Only while the AI
                  still owns the conversation; a human takeover hides it. */}
              {selectedId && aiManagedConversation && (
                <div className="mb-2 inline-flex items-center rounded-lg border border-border/60 bg-secondary/40 p-0.5 text-[11px] font-medium">
                  <button
                    type="button"
                    onClick={() => setComposerMode('reply')}
                    className={cn(
                      'px-2.5 py-1 rounded-md transition-colors',
                      composerMode === 'reply'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('inbox.guidance.modeReply')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerMode('guide')}
                    className={cn(
                      'px-2.5 py-1 rounded-md transition-colors inline-flex items-center gap-1',
                      composerMode === 'guide'
                        ? 'bg-background text-primary shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Bot className="w-3.5 h-3.5" />
                    {t('inbox.guidance.modeGuide')}
                  </button>
                </div>
              )}

              {composerMode === 'guide' && selectedId && aiManagedConversation ? (
                <GuidanceComposer
                  conversationId={selectedId}
                  dir={dir as 'ltr' | 'rtl'}
                  answeringRequestId={guidanceRequestId}
                  onClearAnsweringRequest={() => setGuidanceRequestId(null)}
                  onChanged={() => setGuidanceRefresh((n) => n + 1)}
                />
              ) : (
              <>
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
                'relative flex gap-1 items-end rounded-xl border bg-background p-1.5 transition-shadow shadow-sm',
                'border-border focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15',
              )}>
                <CannedResponsePicker
                  ref={pickerRef}
                  workspaceId={workspace?.id}
                  locale={operatorLocale}
                  query={pickerQuery}
                  open={pickerOpen}
                  slashMode={pickerSlash}
                  onSelect={insertCanned}
                  onQueryChange={setPickerQuery}
                  onClose={closePicker}
                />
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
                <button
                  type="button"
                  onClick={() => {
                    if (pickerOpen && !pickerSlash) { closePicker(); return; }
                    setPickerSlash(false);
                    setPickerQuery('');
                    slashAnchorRef.current = null;
                    setPickerOpen(true);
                  }}
                  className={cn(
                    'p-1.5 rounded-lg transition-colors shrink-0',
                    pickerOpen && !pickerSlash
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                  )}
                  title={t('inbox.cannedResponsesTip') || 'Canned responses'}
                  aria-label={t('inbox.cannedResponses') || 'Canned responses'}
                >
                  <Sparkles className="w-4 h-4" />
                </button>
                <Textarea
                  ref={messageInputRef}
                  placeholder={t('inbox.typeMessage') || 'Type a message...'}
                  value={message}
                  onChange={e => onMessageChange(e.target.value)}
                  onSelect={() => {
                    // Re-evaluate trigger on caret moves.
                    const ta = messageInputRef.current;
                    if (!ta) return;
                    const trig = detectSlashTrigger(ta.value, ta.selectionStart ?? 0);
                    if (trig) {
                      slashAnchorRef.current = trig.anchor;
                      setPickerSlash(true); setPickerOpen(true); setPickerQuery(trig.query);
                    } else if (pickerSlash) {
                      closePicker();
                    }
                  }}
                  onKeyDown={e => {
                    // Picker key handling takes precedence when open.
                    if (pickerOpen && pickerSlash) {
                      if (e.key === 'ArrowDown') { if (pickerRef.current?.moveHighlight(1)) { e.preventDefault(); return; } }
                      else if (e.key === 'ArrowUp') { if (pickerRef.current?.moveHighlight(-1)) { e.preventDefault(); return; } }
                      else if (e.key === 'Enter' || e.key === 'Tab') {
                        if (pickerRef.current?.commit()) { e.preventDefault(); return; }
                      } else if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  className="min-h-[36px] max-h-32 resize-none border-0 bg-transparent text-[14px] leading-relaxed focus-visible:ring-0 px-1.5 py-1.5"
                  rows={1}
                  dir={dir}
                />
                <Button
                  onClick={handleSend}
                  size="icon"
                  disabled={
                    sendMessage.isPending ||
                    att.status === 'uploading' ||
                    (!message.trim() && att.status !== 'ready')
                  }
                  className="h-9 w-9 rounded-lg shrink-0 transition-transform active:scale-95"
                >
                  {sendMessage.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
              <div className="text-[10px] text-muted-foreground/60 mt-1.5 px-1 flex items-center gap-2">
                <kbd className="px-1 py-0.5 rounded bg-secondary/60 border border-border/40 text-[9px] font-mono font-semibold">Enter</kbd>
                <span>{t('inbox.enterToSend') || 'to send'}</span>
                <span className="opacity-30">·</span>
                <kbd className="px-1 py-0.5 rounded bg-secondary/60 border border-border/40 text-[9px] font-mono font-semibold">Shift+Enter</kbd>
                <span>new line</span>
                <span className="opacity-30">·</span>
                <kbd className="px-1 py-0.5 rounded bg-secondary/60 border border-border/40 text-[9px] font-mono font-semibold">/</kbd>
                <span>shortcuts</span>
              </div>
              </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ═══════ RIGHT: Contact Sidebar ═══════
          Desktop ≥lg: inline panel (280px)
          Tablet/mobile: drawer overlay (slides from inline-end), backdrop tap closes */}
      {selected && (showSidebar || activeCallConversationId === selectedId) && (
        <>
          {/* Mobile/tablet backdrop — only below lg */}
          <button
            type="button"
            aria-label={t('inbox.closePanel') || 'Close panel'}
            onClick={() => activeCallConversationId === selectedId ? setShowSidebar(true) : setShowSidebar(false)}
            className="lg:hidden fixed inset-0 z-40 bg-foreground/30 backdrop-blur-[2px] animate-in fade-in"
          />
          <div className={cn(
            'flex w-[300px] max-w-[88vw] border-s border-border flex-col bg-card shrink-0 overflow-hidden',
            // Mobile/tablet: drawer
            'fixed top-0 bottom-0 z-50 shadow-elevated lg:shadow-none',
            dir === 'rtl' ? 'left-0' : 'right-0',
            // Desktop: inline
            'lg:static lg:z-auto lg:w-[280px]',
          )}>
          {/* Invitation-first call entry point (replaces legacy queue dock + panel) */}
          {workspace?.id && selectedId && (
            <div className="p-2.5 border-b border-border bg-card/40">
              <SidebarCallCard
                workspaceId={workspace.id}
                conversationId={selectedId}
                contactName={selected?.contacts?.name ?? null}
                onActiveCallChange={setActiveCallConversationId}
              />
            </div>
          )}
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
                  'flex-1 flex items-center justify-center gap-1.5 py-3 text-[12.5px] font-semibold transition-all border-b-2',
                  sidebarTab === tab.id
                    ? 'border-primary text-primary bg-primary/5'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1 [&>div>div]:!block">
            {sidebarTab === 'info' && (
              <div className="p-3 space-y-2.5" dir={dir}>
                {/* Contact Hero */}
                <div className="rounded-xl bg-gradient-to-b from-primary/5 to-transparent border border-border/50 p-4">
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      <ContactAvatar
                        name={selected.contacts?.name}
                        email={selected.contacts?.email}
                        avatarUrl={selected.contacts?.avatar_url}
                        os={(selected as any)?.visitor_os}
                        device={(selected as any)?.visitor_device}
                        countryCode={(selected as any)?.visitor_country_code}
                        countryName={localizedCountryName((selected as any)?.visitor_country_code, locale, (selected as any)?.visitor_country_name)}
                        size="lg"
                        ringClassName="ring-2 ring-primary/20"
                      />
                      <div className={cn(
                        'absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full border-2 border-card',
                        statusDots[selected.status ?? 'open']
                      )} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={openContactProfile}
                        disabled={!(selected as any)?.contact_id}
                        title={t('inbox.openContact') || 'View contact'}
                        className="block w-full text-start text-[15px] font-bold text-foreground truncate hover:text-primary transition-colors disabled:hover:text-foreground disabled:cursor-default"
                      >
                        {contactDisplayName(selected.contacts, selected?.contact_id ?? selectedId, t, selected?.visitor_network?.geo, locale)}
                      </button>
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className={cn('text-[11px] px-2 py-0.5 rounded-full border font-medium', statusColors[selected.status ?? 'open'])}>
                          {statusLabels[selected.status ?? 'open']}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Quick actions — spam + resolve, right under the profile */}
                  <div className="mt-3 flex items-center gap-2">
                    {(selected as any)?.is_spam ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-2 text-[11.5px] font-semibold"
                        onClick={async () => {
                          if (!workspace?.id || !selectedId) return;
                          try {
                            await conversationsApi.unmarkSpam({ workspace_id: workspace.id, conversation_id: selectedId });
                            toast({ title: t('inbox.removedFromSpam') || 'Removed from spam' });
                            qc.invalidateQueries({ queryKey: ['conversations', workspace.id] });
                          } catch (e: any) {
                            toast({ title: t('inbox.actionFailed') || 'Action failed', description: e?.message || '—', variant: 'destructive' });
                          }
                        }}
                      >
                        <ShieldOff className={cn('w-3.5 h-3.5', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                        {t('inbox.notSpam') || 'Not spam'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-2 text-[11.5px] font-semibold text-muted-foreground hover:text-warning hover:border-warning/40"
                        onClick={async () => {
                          if (!workspace?.id || !selectedId) return;
                          try {
                            await conversationsApi.markSpam({ workspace_id: workspace.id, conversation_id: selectedId });
                            toast({
                              title: t('inbox.markedSpamTitle') || 'Marked as spam',
                              description: t('inbox.markedSpamDesc') || 'Conversation moved to Spam.',
                            });
                            qc.invalidateQueries({ queryKey: ['conversations', workspace.id] });
                          } catch (e: any) {
                            toast({ title: t('inbox.actionFailed') || 'Action failed', description: e?.message || '—', variant: 'destructive' });
                          }
                        }}
                      >
                        <Ban className={cn('w-3.5 h-3.5', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                        {t('inbox.markSpam') || 'Mark as spam'}
                      </Button>
                    )}
                    {selected.status === 'resolved' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-2 text-[11.5px] font-semibold"
                        onClick={() => workspace?.id && updateConv.mutate({ id: selectedId, workspace_id: workspace.id, status: 'open' })}
                      >
                        {t('inbox.reopen') || 'Reopen'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 px-2 text-[11.5px] font-semibold bg-success/10 border-success/20 text-success hover:bg-success/20"
                        onClick={() => workspace?.id && updateConv.mutate({ id: selectedId, workspace_id: workspace.id, status: 'resolved' })}
                      >
                        <CheckCircle2 className={cn('w-3.5 h-3.5', dir === 'rtl' ? 'ml-1' : 'mr-1')} />
                        {t('inbox.resolve') || 'Resolve'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Contact Details */}
                <div className="rounded-xl border border-border/50 bg-card/60 divide-y divide-border/20">
                  {selected.contacts?.email && (
                    <div className="flex items-center gap-2.5 px-3 py-2.5 group/row hover:bg-secondary/20">
                      <Mail className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-[12.5px] text-foreground truncate flex-1 font-medium" dir="ltr">{selected.contacts.email}</span>
                      <button
                        onClick={() => { navigator.clipboard.writeText(selected.contacts?.email || ''); toast({ title: t('inbox.copiedShort') || 'Copied!' }); }}
                        className="opacity-0 group-hover/row:opacity-100 text-muted-foreground hover:text-foreground"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Provider-side identity (Telegram & other channels). */}
                <ChannelIdentityCard
                  metadata={{
                    ...(((selected as any)?.contacts?.metadata as Record<string, unknown>) || {}),
                    ...(((selected as any)?.metadata?.channel ? { channel: (selected as any).metadata.channel } : {}) as Record<string, unknown>),
                  }}
                  t={t as any}
                  dir={dir as any}
                />

                {/* Canonical visitor network identity (shared with Call Center
                    and the Visitors drawer — one endpoint, one policy). */}
                <VisitorNetworkCard
                  workspaceId={workspace?.id}
                  reference={{ conversationId: selectedId }}
                  t={t as any}
                  dir={dir as any}
                  locale={locale}
                />

                {/* Stats */}
                <div className="rounded-xl border border-border/50 bg-card/60 p-2.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="bg-secondary/30 rounded-lg py-2 px-2 text-center border border-border/20">
                      <div className="text-lg font-extrabold text-foreground tabular-nums">{rawMessages?.length || 0}</div>
                      <div className="text-[11px] text-muted-foreground">{t('inbox.messages') || 'Messages'}</div>
                    </div>
                    <div className="bg-secondary/30 rounded-lg py-2 px-2 text-center border border-border/20">
                      <div className="text-[13px] font-extrabold text-foreground">{selected.created_at ? timeAgo(selected.created_at) : '—'}</div>
                      <div className="text-[11px] text-muted-foreground">{t('inbox.duration') || 'Duration'}</div>
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

                {/* vNext — private operator guidance while the AI is handling this. */}
                {selectedId && (
                  <AiGuidancePanel
                    conversationId={selectedId}
                    aiManaged={aiManagedConversation}
                    dir={dir as 'ltr' | 'rtl'}
                    refreshToken={guidanceRefresh}
                    onAnswerRequest={(requestId) => {
                      setGuidanceRequestId(requestId);
                      setComposerMode('guide');
                    }}
                  />
                )}

                {/* Phase 3 — Editable action panel */}
                <ConversationActionPanel
                  conversationId={selectedId!}
                  workspaceId={workspace?.id ?? ''}
                  status={selected.status ?? 'open'}
                  priority={selected.priority ?? 'normal'}
                  assignedTo={selected.assigned_to ?? null}
                  tags={selected.tags ?? []}
                  onMutate={(vars) =>
                    workspace?.id && updateConv.mutate({
                      id: selectedId!,
                      workspace_id: workspace.id,
                      ...vars,
                    })
                  }
                  isPending={updateConv.isPending}
                  t={t}
                  dir={dir}
                />
                <div className="rounded-xl border border-border/50 bg-card/60 px-3 py-2 flex items-center justify-between">
                  <span className="text-[12px] text-muted-foreground">{t('inbox.created') || 'Created'}</span>
                  <bdi className="text-[12px] font-medium text-foreground">
                    {selected.created_at ? formatLongDate(selected.created_at) : '—'}
                  </bdi>
                </div>
              </div>
            )}

            {sidebarTab === 'activity' && selectedId && workspace?.id && (
              <ConversationActivityPanel
                conversationId={selectedId}
                workspaceId={workspace.id}
                currentUserId={user?.id ?? null}
                t={t}
                dir={dir}
              />
            )}
          </ScrollArea>
        </div>
        </>
      )}
      <ContactDrawer
        contactId={contactDrawerId}
        open={!!contactDrawerId}
        onOpenChange={(o) => { if (!o) setContactDrawerId(null); }}
      />
    </div>
  );
}
