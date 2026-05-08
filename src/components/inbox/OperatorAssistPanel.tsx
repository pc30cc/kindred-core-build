/**
 * Pass E7 — Operator AI Assist panel.
 *
 * Lives above the composer in the operator inbox. Lets the operator request
 * an on-demand AI draft reply for the current conversation, choose tone /
 * give an instruction, then insert the draft into the composer (it is never
 * auto-sent). Distinct from the auto-suggestion card (AiSuggestionCard) which
 * shows pre-generated suggestions for visitor messages.
 */
import { useState } from 'react';
import { Sparkles, ArrowDownToLine, RefreshCw, X, Eye, Loader2, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  aiAgentApi,
  type OperatorSuggestReplyResponse,
  type OperatorAssistFeedbackAction,
  type OperatorAssistFeedbackReason,
} from '@/lib/ai-agent-api';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type Tone = 'friendly' | 'professional' | 'short' | 'detailed';

interface Props {
  workspaceId: string;
  conversationId: string;
  composerHasText: boolean;
  onInsert: (text: string, mode: 'replace' | 'append') => void;
  dir?: 'ltr' | 'rtl';
}

export function OperatorAssistPanel({
  workspaceId, conversationId, composerHasText, onInsert, dir = 'ltr',
}: Props) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState<Tone>('friendly');
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OperatorSuggestReplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [rating, setRating] = useState<'positive' | 'negative' | null>(null);
  const [reason, setReason] = useState<OperatorAssistFeedbackReason | ''>('');
  const [comment, setComment] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);

  const sendFeedback = async (
    payload: {
      rating?: 'positive' | 'negative' | 'neutral';
      reason?: OperatorAssistFeedbackReason | null;
      comment?: string | null;
      operatorAction?: OperatorAssistFeedbackAction;
      finalComposerText?: string | null;
    },
    silent = true,
  ) => {
    const runId = result?.assist_run_id;
    if (!runId) return;
    try {
      await aiAgentApi.submitAssistFeedback(runId, {
        rating: payload.rating || 'neutral',
        reason: payload.reason ?? null,
        comment: payload.comment ?? null,
        operatorAction: payload.operatorAction ?? null,
        finalComposerText: payload.finalComposerText ?? null,
      });
      if (!silent) toast({ title: 'Feedback sent' });
    } catch (e: any) {
      if (!silent) {
        toast({ title: 'Could not save feedback', description: e?.message || 'unknown', variant: 'destructive' });
      } else {
        // Non-blocking failure.
        console.warn('[ai-assist] feedback failed:', e?.message);
      }
    }
  };

  const run = async () => {
    // If user is regenerating an existing suggestion, log that action.
    if (result?.assist_run_id) {
      void sendFeedback({ rating: 'neutral', operatorAction: 'regenerated' });
    }
    setLoading(true);
    setError(null);
    setRating(null);
    setReason('');
    setComment('');
    setFeedbackSent(false);
    try {
      const r = await aiAgentApi.suggestReply({
        workspaceId, conversationId, tone,
        instruction: instruction.trim() || undefined,
        callLLM: true,
      });
      setResult(r);
      if (!r.suggestion) {
        toast({
          title: 'No suggestion',
          description: r.safety_notes?.join(', ') || 'The model returned no draft.',
        });
      }
    } catch (e: any) {
      const msg = e?.message || 'request_failed';
      setError(msg);
      toast({ title: 'AI Assist failed', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const dismiss = () => {
    if (result?.assist_run_id) {
      void sendFeedback({ rating: 'neutral', operatorAction: 'dismissed' });
    }
    setResult(null);
    setError(null);
    setOpen(false);
    // Preserve tone/instruction so operator can regenerate quickly.
  };

  const insert = (mode: 'replace' | 'append') => {
    if (!result?.suggestion) return;
    onInsert(result.suggestion, mode);
    const action: OperatorAssistFeedbackAction =
      mode === 'replace' ? (composerHasText ? 'replaced' : 'inserted') : 'appended';
    void sendFeedback({
      rating: 'neutral',
      operatorAction: action,
      finalComposerText: result.suggestion,
    });
    toast({ title: mode === 'append' ? 'Appended to composer' : 'Inserted into composer' });
  };

  const submitRating = async (r: 'positive' | 'negative') => {
    setRating(r);
    if (r === 'positive') {
      await sendFeedback({ rating: 'positive', reason: 'helpful' }, false);
      setFeedbackSent(true);
    }
    // For negative, wait for the operator to optionally pick a reason / comment.
  };

  const submitNegativeDetails = async () => {
    await sendFeedback({
      rating: 'negative',
      reason: (reason || 'other') as OperatorAssistFeedbackReason,
      comment: comment.trim() || null,
    }, false);
    setFeedbackSent(true);
  };

  const confidencePct = result ? Math.round((result.confidence || 0) * 100) : null;
  const confTone = confidencePct == null ? 'bg-muted text-muted-foreground'
    : confidencePct >= 70 ? 'bg-success/15 text-success'
    : confidencePct >= 40 ? 'bg-warning/15 text-warning'
    : 'bg-destructive/10 text-destructive';

  const noKnowledge =
    !!result && (
      (result.selected_sources?.length ?? 0) === 0 ||
      result.safety_notes?.includes('no_eligible_knowledge_sources')
    );

  if (!open && !result) {
    return (
      <div className="mb-2" dir={dir}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          onClick={() => setOpen(true)}
        >
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          AI Suggest Reply
        </Button>
      </div>
    );
  }

  return (
    <div
      className="mb-2 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden"
      dir={dir}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20 bg-primary/10">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-[12px] font-semibold">AI Assist (operator draft)</span>
          {confidencePct != null && (
            <Badge className={cn('text-[10px] h-4 px-1.5 border-0', confTone)}>
              {confidencePct}% confidence
            </Badge>
          )}
          {result?.provider && (
            <span className="text-[10px] text-muted-foreground">
              {result.provider}/{result.model}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 py-2.5 space-y-2.5">
        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={tone} onValueChange={(v) => setTone(v as Tone)}>
            <SelectTrigger className="h-7 w-[140px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="friendly">Friendly</SelectItem>
              <SelectItem value="professional">Professional</SelectItem>
              <SelectItem value="short">Short</SelectItem>
              <SelectItem value="detailed">Detailed</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="Add custom instruction… (optional)"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className="h-7 text-[12px] flex-1 min-w-[160px]"
            maxLength={1000}
          />
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={run}
            disabled={loading}
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : result ? <RefreshCw className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
            {result ? 'Regenerate' : 'Generate'}
          </Button>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="text-[12px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Drafting reply from your knowledge sources…
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive">
            {error === 'feature_not_available'
              ? 'AI Operator Assist is not enabled on your current plan.'
              : error === 'operator_permission_required'
              ? 'Your role does not have permission to use AI Operator Assist.'
              : error === 'ai_provider_not_configured'
              ? 'No AI provider is configured for this workspace.'
              : error === 'no_visitor_message'
              ? 'No visitor message in this conversation yet.'
              : error === 'rate_limited'
              ? 'Too many AI Assist requests. Please wait a moment and try again.'
              : `Could not generate a suggestion: ${error}`}
          </div>
        )}

        {/* Result */}
        {result?.suggestion && !loading && (
          <div className="rounded-md border border-border bg-background px-2.5 py-2">
            {noKnowledge && (
              <div className="mb-2">
                <Badge variant="outline" className="text-[10px] font-normal text-warning border-warning/40">
                  No knowledge source used
                </Badge>
              </div>
            )}
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
              {result.suggestion}
            </p>

            {result.selected_sources.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mr-1">
                  Sources:
                </span>
                {result.selected_sources.slice(0, 5).map((s) => (
                  <Badge key={s.id} variant="secondary" className="text-[10px] font-normal">
                    {s.title || s.source_type}
                  </Badge>
                ))}
              </div>
            )}

            {result.safety_notes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {result.safety_notes.map((n) => (
                  <Badge key={n} variant="outline" className="text-[10px] font-normal text-warning border-warning/40">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        {result?.suggestion && !loading && (
          <>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={() => insert(composerHasText ? 'append' : 'replace')}
              className="h-7 gap-1.5 text-[12px]"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" />
              {composerHasText ? 'Append to composer' : 'Insert into composer'}
            </Button>
            {composerHasText && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => insert('replace')}
                className="h-7 gap-1.5 text-[12px]"
              >
                Replace composer
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDebugOpen(true)}
              className="h-7 gap-1.5 text-[12px]"
            >
              <Eye className="w-3.5 h-3.5" />
              View debug
            </Button>
            <span className="text-[10px] text-muted-foreground ml-auto">
              Not visible to visitor until you send.
            </span>
          </div>

          {/* Feedback row */}
          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/40">
            <span className="text-[11px] text-muted-foreground">Was this useful?</span>
            <Button
              type="button"
              size="sm"
              variant={rating === 'positive' ? 'default' : 'outline'}
              className="h-7 gap-1.5 text-[12px]"
              disabled={feedbackSent}
              onClick={() => submitRating('positive')}
            >
              <ThumbsUp className="w-3.5 h-3.5" /> Useful
            </Button>
            <Button
              type="button"
              size="sm"
              variant={rating === 'negative' ? 'destructive' : 'outline'}
              className="h-7 gap-1.5 text-[12px]"
              disabled={feedbackSent}
              onClick={() => submitRating('negative')}
            >
              <ThumbsDown className="w-3.5 h-3.5" /> Not useful
            </Button>
            {feedbackSent && (
              <span className="text-[11px] text-success">Thanks for the feedback.</span>
            )}
          </div>

          {rating === 'negative' && !feedbackSent && (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <Select value={reason} onValueChange={(v) => setReason(v as OperatorAssistFeedbackReason)}>
                <SelectTrigger className="h-7 w-[170px] text-[12px]">
                  <SelectValue placeholder="Reason (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="wrong_answer">Wrong answer</SelectItem>
                  <SelectItem value="missing_context">Missing context</SelectItem>
                  <SelectItem value="bad_tone">Bad tone</SelectItem>
                  <SelectItem value="too_long">Too long</SelectItem>
                  <SelectItem value="too_short">Too short</SelectItem>
                  <SelectItem value="unsafe">Unsafe</SelectItem>
                  <SelectItem value="not_grounded">Not grounded</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Optional comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={2000}
                className="h-7 text-[12px] flex-1 min-w-[160px]"
              />
              <Button
                type="button"
                size="sm"
                className="h-7 text-[12px]"
                onClick={submitNegativeDetails}
              >
                Submit
              </Button>
            </div>
          )}
          </>
        )}
      </div>

      {/* Debug modal */}
      <Dialog open={debugOpen} onOpenChange={setDebugOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>AI Assist debug</DialogTitle>
          </DialogHeader>
          {result && (
            <div className="space-y-3 text-[12px]">
              <section>
                <div className="font-semibold mb-1">Answer strategy</div>
                <pre className="bg-muted/40 rounded p-2 overflow-x-auto">
                  {JSON.stringify(result.answer_strategy, null, 2)}
                </pre>
              </section>
              <section>
                <div className="font-semibold mb-1">Selected sources (redacted)</div>
                <pre className="bg-muted/40 rounded p-2 overflow-x-auto">
                  {JSON.stringify(result.selected_sources, null, 2)}
                </pre>
              </section>
              <section>
                <div className="font-semibold mb-1">Retrieval debug (redacted)</div>
                <pre className="bg-muted/40 rounded p-2 overflow-x-auto max-h-64">
                  {JSON.stringify(result.retrieval_debug, null, 2)}
                </pre>
              </section>
              {result.excluded_summary && Object.keys(result.excluded_summary).length > 0 && (
                <section>
                  <div className="font-semibold mb-1">Excluded sources (summary)</div>
                  <pre className="bg-muted/40 rounded p-2 overflow-x-auto">
                    {JSON.stringify(result.excluded_summary, null, 2)}
                  </pre>
                </section>
              )}
              {result.prompt_preview && (
                <section>
                  <div className="font-semibold mb-1">Prompt preview (admin only)</div>
                  <pre className="bg-muted/40 rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap">
                    {`# system\n${result.prompt_preview.system}\n\n# user\n${result.prompt_preview.user}`}
                  </pre>
                </section>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}