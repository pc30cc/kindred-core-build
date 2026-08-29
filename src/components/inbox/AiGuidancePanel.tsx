/**
 * vNext — AI Guidance panel (private operator → AI steering).
 *
 * Sits in the conversation sidebar while the AI still owns the conversation.
 * The operator can:
 *   - answer a question the AI privately asked ("what is our refund window?")
 *   - push a direction ("stop offering the trial, it ended yesterday")
 *   - push a fact the knowledge base does not contain
 *   - revoke guidance they no longer want applied
 *
 * Nothing in this panel is ever visible to the visitor.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Brain, Loader2, Lock, Send, Trash2, X, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { aiAgentApi, type AiGuidance, type AiGuidanceRequest, type GuidanceKind, type GuidanceScope } from '@/lib/ai-agent-api';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface Props {
  conversationId: string;
  /** Hide entirely once a human has taken the conversation over. */
  aiManaged: boolean;
  dir?: 'ltr' | 'rtl';
  className?: string;
}

export function AiGuidancePanel({ conversationId, aiManaged, dir = 'ltr', className }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AiGuidance[]>([]);
  const [requests, setRequests] = useState<AiGuidanceRequest[]>([]);
  const [maxBody, setMaxBody] = useState(2000);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<GuidanceKind>('direction');
  const [scope, setScope] = useState<GuidanceScope>('conversation');
  const [answeringRequestId, setAnsweringRequestId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const res = await aiAgentApi.getConversationGuidance(conversationId);
      setItems(res.items || []);
      setRequests(res.requests || []);
      if (res.maxBody) setMaxBody(res.maxBody);
    } catch {
      // Guidance is an enhancement; a read failure must not break the inbox.
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);

  const pendingRequest = useMemo(
    () => requests.find((r) => r.status === 'pending') || null,
    [requests],
  );

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    setSaving(true);
    try {
      await aiAgentApi.createConversationGuidance(conversationId, {
        body: text,
        kind,
        scope,
        ...(answeringRequestId ? { requestId: answeringRequestId } : {}),
      });
      setBody('');
      setAnsweringRequestId(null);
      toast({ title: t('inbox.guidance.saved') });
      await load();
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

  const revoke = async (id: string) => {
    setItems((prev) => prev.filter((g) => g.id !== id));
    try {
      await aiAgentApi.revokeConversationGuidance(id);
    } catch {
      await load();
    }
  };

  const dismissRequest = async (id: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    try {
      await aiAgentApi.dismissGuidanceRequest(id);
    } catch {
      await load();
    }
  };

  if (!aiManaged) return null;

  return (
    <div dir={dir} className={cn('rounded-xl border border-border/60 bg-card/60 p-3 space-y-3', className)}>
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">{t('inbox.guidance.title')}</span>
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <Lock className="h-3 w-3" />
          {t('inbox.guidance.private')}
        </Badge>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* The AI privately asked the team a question. */}
      {pendingRequest && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 space-y-2">
          <div className="flex items-start gap-2">
            <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">{t('inbox.guidance.aiAsks')}</p>
              <p className="mt-0.5 text-sm leading-relaxed">{pendingRequest.question}</p>
              {pendingRequest.missing_information && (
                <p className="mt-1 text-xs text-muted-foreground">{pendingRequest.missing_information}</p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => void dismissRequest(pendingRequest.id)}
              aria-label={t('inbox.guidance.dismiss') as string}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => setAnsweringRequestId(pendingRequest.id)}
          >
            {t('inbox.guidance.answer')}
          </Button>
        </div>
      )}

      {/* Active guidance already steering this conversation. */}
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((g) => (
            <li key={g.id} className="group flex items-start gap-2 rounded-lg bg-muted/50 p-2">
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {g.kind === 'fact'
                  ? t('inbox.guidance.kindFact')
                  : t('inbox.guidance.kindDirection')}
              </Badge>
              <span className="min-w-0 flex-1 text-xs leading-relaxed break-words">{g.body}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={() => void revoke(g.id)}
                aria-label={t('inbox.guidance.remove') as string}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, maxBody))}
        rows={3}
        placeholder={
          answeringRequestId
            ? (t('inbox.guidance.answerPlaceholder') as string)
            : (t('inbox.guidance.placeholder') as string)
        }
        className="resize-none text-sm"
      />

      <div className="flex flex-wrap items-center gap-2">
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
            <SelectItem value="conversation">{t('inbox.guidance.scopeConversation')}</SelectItem>
            <SelectItem value="next_turn">{t('inbox.guidance.scopeNextTurn')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          className="ms-auto h-8 gap-1.5 text-xs"
          disabled={!body.trim() || saving}
          onClick={() => void submit()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {t('inbox.guidance.send')}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('inbox.guidance.hint')}
      </p>
    </div>
  );
}
