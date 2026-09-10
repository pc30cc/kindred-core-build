/**
 * Human Guidance UX — private "Guide AI" composer.
 *
 * Replaces the public reply box while the operator is in "Guide AI" mode.
 * Nothing typed here is ever shown to the visitor:
 *   - "Save guidance"  → stores a private instruction/fact for the AI
 *   - "AI reply now"   → stores it (when present) and asks the real Core AI
 *                        Agent pipeline to answer the latest visitor message
 *
 * The component never renders guidance text as a reply and never posts to the
 * conversation itself; the server owns generation, grounding and delivery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Bot, Loader2, Lock, Save, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  aiAgentApi,
  type GuidanceKind,
  type GuidanceScope,
  type ReplyNowEligibility,
  type SayNowAttribution,
} from '@/lib/ai-agent-api';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface Props {
  conversationId: string;
  dir?: 'ltr' | 'rtl';
  /** Pending AI question this guidance answers, when the operator chose one. */
  answeringRequestId?: string | null;
  onClearAnsweringRequest?: () => void;
  /** Bump the sidebar viewer after a write. */
  onChanged?: () => void;
  className?: string;
}

function randomKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function GuidanceComposer({
  conversationId,
  dir = 'ltr',
  answeringRequestId = null,
  onClearAnsweringRequest,
  onChanged,
  className,
}: Props) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<GuidanceKind>('direction');
  // vNext default for the composer: steer only the very next reply.
  const [scope, setScope] = useState<GuidanceScope>('next_turn');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** 'guide' = private steering, 'say' = AI delivers the operator's dictation now. */
  const [mode, setMode] = useState<'guide' | 'say'>('guide');
  const [attribution, setAttribution] = useState<SayNowAttribution>('specialist');
  const [sending, setSending] = useState(false);
  const [eligibility, setEligibility] = useState<ReplyNowEligibility | null>(null);
  /** Stable per-attempt token so a double click can never double-answer. */
  const idempotencyRef = useRef<string>(randomKey());

  const loadEligibility = useCallback(async () => {
    if (!conversationId) return;
    try {
      setEligibility(await aiAgentApi.getReplyNowEligibility(conversationId));
    } catch {
      setEligibility(null);
    }
  }, [conversationId]);

  useEffect(() => {
    setBody('');
    idempotencyRef.current = randomKey();
    void loadEligibility();
    // Eligibility changes as soon as the visitor writes again or a handoff
    // resolves; without re-checking, the button stays stuck in its first state.
    const timer = window.setInterval(() => void loadEligibility(), 10_000);
    const onFocus = () => void loadEligibility();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [conversationId, loadEligibility]);

  const blockedReason = useMemo(() => {
    if (!eligibility || eligibility.eligible) return null;
    switch (eligibility.reason) {
      case 'no_visitor_message': return t('inbox.guidance.blockedNoVisitorMessage');
      case 'human_active': return t('inbox.guidance.blockedHumanActive');
      case 'conversation_closed': return t('inbox.guidance.blockedClosed');
      case 'handoff_in_progress': return t('inbox.guidance.blockedHandoff');
      case 'not_ai_managed': return t('inbox.guidance.blockedNotAiManaged');
      case 'reply_now_in_progress': return t('inbox.guidance.blockedInProgress');
      default: return t('inbox.guidance.blockedGeneric');
    }
  }, [eligibility, t]);

  const busy = saving || generating || sending;

  /** Operator dictation → AI-authored visitor-facing message, sent now. */
  const sayNow = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setSending(true);
    try {
      await aiAgentApi.aiSayNow(conversationId, { body: text, attribution });
      setBody('');
      toast({ title: t('inbox.guidance.sayNowSent') });
      onChanged?.();
    } catch (e: any) {
      toast({
        title: t('inbox.guidance.sayNowFailed'),
        description: e?.message || 'unknown',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  const saveGuidance = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setSaving(true);
    try {
      await aiAgentApi.createConversationGuidance(conversationId, {
        body: text,
        kind,
        scope,
        ...(answeringRequestId ? { requestId: answeringRequestId } : {}),
      });
      setBody('');
      onClearAnsweringRequest?.();
      onChanged?.();
      toast({ title: t('inbox.guidance.saved') });
    } catch (e: any) {
      toast({
        title: t('inbox.guidance.saveFailed'),
        description: e?.message || 'unknown',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const replyNow = async () => {
    if (busy) return;
    setGenerating(true);
    const text = body.trim();
    try {
      const res = await aiAgentApi.aiReplyNow(conversationId, {
        ...(text ? { body: text } : {}),
        kind,
        scope,
        ...(answeringRequestId ? { requestId: answeringRequestId } : {}),
        idempotencyKey: idempotencyRef.current,
      });
      idempotencyRef.current = randomKey();
      setBody('');
      onClearAnsweringRequest?.();
      onChanged?.();
      if (res.action === 'replied') {
        toast({ title: t('inbox.guidance.replyNowSent') });
      } else if (res.action === 'handoff') {
        toast({ title: t('inbox.guidance.replyNowHandoff') });
      } else {
        toast({
          title: t('inbox.guidance.replyNowNoReply'),
          description: res.reason || undefined,
        });
      }
      void loadEligibility();
    } catch (e: any) {
      toast({
        title: t('inbox.guidance.replyNowFailed'),
        description: e?.message || 'unknown',
        variant: 'destructive',
      });
      void loadEligibility();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      dir={dir}
      className={cn(
        'rounded-xl border border-primary/30 bg-primary/[0.04] p-2.5 space-y-2 transition-colors',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-[12px] font-medium">{t('inbox.guidance.composerTitle')}</span>
        {mode === 'guide' ? (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Lock className="h-3 w-3" />
            {t('inbox.guidance.private')}
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 border-primary/40 text-[10px] text-primary">
            <Send className="h-3 w-3" />
            {t('inbox.guidance.sayNowBadge')}
          </Badge>
        )}
        {answeringRequestId && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            {t('inbox.guidance.answeringRequest')}
            <button
              type="button"
              onClick={onClearAnsweringRequest}
              aria-label={t('inbox.guidance.dismiss') as string}
              className="ms-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
      </div>

      {/* Mode switch: private steering vs. "AI, say this to the visitor now". */}
      <div className="inline-flex rounded-lg border bg-background p-0.5">
        {(['guide', 'say'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
              mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m === 'guide' ? t('inbox.guidance.tabGuide') : t('inbox.guidance.modeSayNow')}
          </button>
        ))}
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, 2000))}
        rows={2}
        dir={dir}
        placeholder={
          mode === 'say'
            ? (t('inbox.guidance.sayNowPlaceholder') as string)
            : answeringRequestId
              ? (t('inbox.guidance.answerPlaceholder') as string)
              : (t('inbox.guidance.placeholder') as string)
        }
        className="resize-none bg-background text-[14px]"
      />

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'guide' ? (
          <>
            <Select value={kind} onValueChange={(v) => setKind(v as GuidanceKind)}>
              <SelectTrigger className="h-8 w-[7.5rem] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="direction">{t('inbox.guidance.kindDirection')}</SelectItem>
                <SelectItem value="fact">{t('inbox.guidance.kindFact')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={(v) => setScope(v as GuidanceScope)}>
              <SelectTrigger className="h-8 w-[9.5rem] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="next_turn">{t('inbox.guidance.scopeNextTurn')}</SelectItem>
                <SelectItem value="conversation">{t('inbox.guidance.scopeConversation')}</SelectItem>
              </SelectContent>
            </Select>
          </>
        ) : (
          <Select value={attribution} onValueChange={(v) => setAttribution(v as SayNowAttribution)}>
            <SelectTrigger className="h-8 w-[11rem] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="specialist">{t('inbox.guidance.voiceSpecialist')}</SelectItem>
              <SelectItem value="assistant">{t('inbox.guidance.voiceAssistant')}</SelectItem>
            </SelectContent>
          </Select>
        )}

        <div className="ms-auto flex items-center gap-2">
          {mode === 'guide' ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={!body.trim() || busy}
                onClick={() => void saveGuidance()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t('inbox.guidance.save')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={busy || (eligibility ? !eligibility.eligible : false)}
                onClick={() => void replyNow()}
                title={blockedReason || undefined}
              >
                {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {generating ? t('inbox.guidance.generating') : t('inbox.guidance.replyNow')}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={!body.trim() || busy}
              onClick={() => void sayNow()}
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {sending ? t('inbox.guidance.sayNowSending') : t('inbox.guidance.sayNowAction')}
            </Button>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {mode === 'say' ? t('inbox.guidance.sayNowHint') : blockedReason || t('inbox.guidance.hint')}
      </p>
    </div>
  );
}
