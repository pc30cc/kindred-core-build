/**
 * vNext — AI Guidance panel (private operator → AI steering).
 *
 * Sits in the conversation sidebar while the AI still owns the conversation.
 * Since the Human Guidance UX upgrade this panel is a VIEWER/MANAGER only —
 * writing guidance and "AI reply now" live in the inbox composer. Here the
 * operator can:
 *   - see the guidance currently steering this conversation, and revoke it
 *   - see a question the AI privately asked, and jump to the composer to
 *     answer it (or dismiss it)
 *
 * Nothing in this panel is ever visible to the visitor.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Brain, Loader2, Lock, Trash2, X, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { aiAgentApi, type AiGuidance, type AiGuidanceRequest } from '@/lib/ai-agent-api';
import { cn } from '@/lib/utils';

interface Props {
  conversationId: string;
  /** Bumped by the composer after a write so the viewer refetches. */
  refreshToken?: number;
  /** Move the operator into the composer's Guide-AI mode for this request. */
  onAnswerRequest?: (requestId: string) => void;
  /** Hide entirely once a human has taken the conversation over. */
  aiManaged: boolean;
  dir?: 'ltr' | 'rtl';
  className?: string;
}

export function AiGuidancePanel({
  conversationId, aiManaged, dir = 'ltr', className,
  refreshToken = 0, onAnswerRequest,
}: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AiGuidance[]>([]);
  const [requests, setRequests] = useState<AiGuidanceRequest[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const res = await aiAgentApi.getConversationGuidance(conversationId);
      setItems(res.items || []);
      setRequests(res.requests || []);
    } catch {
      // Guidance is an enhancement; a read failure must not break the inbox.
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const pendingRequest = requests.find((r) => r.status === 'pending') || null;

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
            onClick={() => onAnswerRequest?.(pendingRequest.id)}
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

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('inbox.guidance.viewerHint')}
      </p>
    </div>
  );
}
