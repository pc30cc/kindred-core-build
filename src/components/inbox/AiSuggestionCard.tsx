/**
 * Phase 2 — Operator-facing AI suggestion card.
 *
 * Renders the most recent pending ai_agent_suggestions row for the open
 * conversation. Three actions:
 *   • Insert into composer  → fills operator reply box (does not send).
 *   • Send now              → calls the operator's normal send flow.
 *   • Dismiss               → marks the suggestion dismissed.
 *
 * Visitor never sees this card. The "Send now" path delivers the text as
 * a regular operator message — not as an AI message.
 */
import { Sparkles, Send, X, ChevronDown, ChevronUp, ArrowDownToLine, Clock, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useConversationSuggestions,
  useUseSuggestion,
  useDismissSuggestion,
} from '@/hooks/useAiAgent';
import { useAiAgentCapabilities } from '@/hooks/useAiAgentCapabilities';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { toast } from '@/hooks/use-toast';
import type { PostSendAction } from '@/lib/send-action-pref';

interface Props {
  conversationId: string;
  /** Fill the composer textarea with the suggestion text. */
  onInsert: (text: string) => void;
  /** Send the suggestion as a normal operator reply. Returns success. */
  onSendNow: (text: string, action?: PostSendAction) => Promise<boolean> | boolean;
  /** Operator's remembered post-send action (shared with the composer). */
  sendAction?: PostSendAction;
  onSendActionChange?: (action: PostSendAction) => void;
  dir?: 'ltr' | 'rtl';
  t?: (k: string) => string;
}


export function AiSuggestionCard({
  conversationId,
  onInsert,
  onSendNow,
  sendAction = 'none',
  onSendActionChange,
  dir = 'ltr',
  t,
}: Props) {
  const { workspace } = useActiveWorkspace();
  const { data: capabilities } = useAiAgentCapabilities(workspace?.id);
  const { data, isLoading } = useConversationSuggestions(conversationId);
  const useMut = useUseSuggestion(conversationId);
  const dismissMut = useDismissSuggestion(conversationId);
  const [expanded, setExpanded] = useState(true);
  const [sending, setSending] = useState(false);

  // Platform-wide AI Agent kill switch — when Super Admin disables AI Agent,
  // hide the suggestion card entirely. Re-appears when re-enabled.
  if (capabilities && !capabilities.ai_agent_enabled) return null;

  if (isLoading) return null;
  const suggestion = (data?.items || [])[0];
  if (!suggestion) return null;

  const tr = (k: string, fb: string) => {
    if (!t) return fb;
    const v = t(k);
    // i18n returns the key itself when missing — fall back to provided default.
    return !v || v === k ? fb : v;
  };

  const actionMeta: Record<PostSendAction, { label: string; short: string; hint: string; icon: typeof Send }> = {
    none: {
      label: tr('inbox.sendOnly', 'Send'),
      short: tr('inbox.sendOnlyShort', 'Send'),
      hint: tr('inbox.sendOnlyHint', 'Send the reply. Conversation status stays unchanged.'),
      icon: Send,
    },
    wait_for_customer: {
      label: tr('inbox.sendAndWait', 'Send & wait for customer'),
      short: tr('inbox.sendAndWaitShort', 'Wait'),
      hint: tr('inbox.sendAndWaitHint', 'Send, then move the conversation to Waiting for customer.'),
      icon: Clock,
    },
    resolve: {
      label: tr('inbox.sendAndResolve', 'Send & resolve'),
      short: tr('inbox.sendAndResolveShort', 'Resolve'),
      hint: tr('inbox.sendAndResolveHint', 'Send, then mark the conversation resolved.'),
      icon: CheckCircle2,
    },
  };

  const handleInsert = () => {
    onInsert(suggestion.suggested_reply);
    toast({ title: tr('aiAgent.suggestionInserted', 'Inserted into composer') });
  };

  const handleSendNow = async (action: PostSendAction = sendAction) => {
    if (sending) return;
    setSending(true);
    try {
      const ok = await Promise.resolve(onSendNow(suggestion.suggested_reply, action));
      if (ok) {
        await useMut.mutateAsync(suggestion.id).catch(() => { /* non-blocking */ });
      }
    } finally {
      setSending(false);
    }
  };


  const handleDismiss = async () => {
    try {
      await dismissMut.mutateAsync(suggestion.id);
    } catch (e: any) {
      toast({ title: 'Error', description: e?.message, variant: 'destructive' });
    }
  };

  const confidencePct =
    suggestion.confidence != null ? Math.round(suggestion.confidence * 100) : null;
  const confTone =
    confidencePct == null
      ? 'bg-muted text-muted-foreground'
      : confidencePct >= 75
      ? 'bg-success/15 text-success'
      : confidencePct >= 50
      ? 'bg-warning/15 text-warning'
      : 'bg-destructive/10 text-destructive';

  return (
    <div
      className={cn(
        'mb-2 rounded-xl border border-primary/30 bg-primary/5',
        'shadow-sm overflow-hidden',
      )}
      dir={dir}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20 bg-primary/10">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-[12px] font-semibold text-foreground truncate">
            {tr('aiAgent.suggestedReply', 'AI Agent suggested reply')}
          </span>
          {confidencePct != null && (
            <Badge className={cn('text-[10px] px-1.5 py-0 h-4 border-0', confTone)}>
              {confidencePct}%
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={dismissMut.isPending}
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
            aria-label={tr('aiAgent.dismiss', 'Dismiss')}
            title={tr('aiAgent.dismiss', 'Dismiss')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 py-2.5">
          <p className="text-[13px] leading-relaxed text-foreground whitespace-pre-wrap">
            {suggestion.suggested_reply}
          </p>

          {suggestion.sources && suggestion.sources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">
                {tr('aiAgent.sources', 'Sources')}:
              </span>
              {suggestion.sources.slice(0, 4).map((s) => (
                <Badge key={s.id} variant="secondary" className="text-[10px] font-normal">
                  {s.title || s.slug || s.id.slice(0, 6)}
                </Badge>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={handleInsert} className="h-7 gap-1.5 text-[12px]">
              <ArrowDownToLine className="w-3.5 h-3.5" />
              {tr('aiAgent.insertIntoComposer', 'Insert into composer')}
            </Button>
            <div className="flex items-stretch">
              <Button
                size="sm"
                onClick={() => handleSendNow()}
                disabled={sending || useMut.isPending}
                title={actionMeta[sendAction].label}
                className={cn(
                  'h-7 gap-1.5 text-[12px]',
                  dir === 'rtl' ? 'rounded-s-none rounded-e-md' : 'rounded-e-none rounded-s-md',
                )}
              >
                <Send className="w-3.5 h-3.5" />
                {sendAction === 'none'
                  ? tr('aiAgent.sendNow', 'Send now')
                  : `${tr('aiAgent.sendNow', 'Send now')} · ${actionMeta[sendAction].short}`}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    disabled={sending || useMut.isPending}
                    aria-label={tr('inbox.sendActions', 'Send actions')}
                    className={cn(
                      'h-7 w-6 p-0 border-s border-primary-foreground/20',
                      dir === 'rtl' ? 'rounded-e-none rounded-s-md' : 'rounded-s-none rounded-e-md',
                    )}
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-64">
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    {tr('inbox.sendActions', 'Send actions')}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(['none', 'wait_for_customer', 'resolve'] as PostSendAction[]).map((a) => {
                    const Icon = actionMeta[a].icon;
                    return (
                      <DropdownMenuItem
                        key={a}
                        onSelect={() => { onSendActionChange?.(a); handleSendNow(a); }}
                        className="gap-2 items-start"
                      >
                        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium flex items-center gap-1.5">
                            {actionMeta[a].label}
                            {a === sendAction && <CheckCircle2 className="w-3 h-3 text-primary shrink-0" />}
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-snug">
                            {actionMeta[a].hint}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <span className="text-[10px] text-muted-foreground ml-auto">
              {tr('aiAgent.notVisibleToVisitor', 'Not visible to visitor until you send')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}