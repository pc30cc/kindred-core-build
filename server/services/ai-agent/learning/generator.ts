/**
 * AI Agent — pending learning-candidate generator.
 *
 * Scans recent ai_agent_runs and pairs each AI failure (no_answer / handoff /
 * low-confidence / page_not_indexed / repeated clarification) with the
 * triggering visitor question, creating a pending candidate the admin can
 * later approve, edit, convert to Q&A, or convert to KB.
 *
 * Hard rules:
 *  - Workspace-scoped. Never crosses workspaces.
 *  - Never auto-approves. Never indexes pending rows.
 *  - Skips spam, ack-only, secret-bearing, or too-short messages.
 *  - Dedupes by (workspace_id, normalized_question) across pending/approved/
 *    converted_to_qna/converted_to_kb rows.
 *  - If a real human/operator replied AFTER the AI failure in the same
 *    conversation, that reply is used as suggested_answer with reason
 *    `operator_answer_available` (higher confidence than blank candidates).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { isAiAgentMessage, isHumanOperatorMessage } from '../handoffState.js';
import { detectInputLanguage } from '../language.js';
import { normalizeQuestion } from './normalize.js';
import { isAnswerLearnable, isQuestionLearnable } from './safety.js';

export type CandidateReason =
  | 'no_answer'
  | 'low_confidence'
  | 'handoff_after_ai'
  | 'repeated_clarification'
  | 'page_not_indexed'
  | 'operator_answer_available';

export interface GenerateCandidatesInput {
  workspaceId: string;
  /** ISO timestamp; defaults to last 14 days. */
  sinceIso?: string;
  /** Hard cap on runs scanned per call. */
  limit?: number;
}

export interface GenerateCandidatesResult {
  scanned: number;
  created: number;
  skipped: number;
  reasons: Record<string, number>;
}

const LOW_CONFIDENCE_FLOOR = 0.45;

function detectReason(run: any): CandidateReason | null {
  const status = (run?.status || '').toLowerCase();
  const decision = run?.metadata?.answer_strategy?.decision_type || '';
  const intentOverride = run?.metadata?.page_context?.intent_override || '';
  const conf = typeof run?.confidence === 'number' ? run.confidence : null;

  if (intentOverride === 'page_not_indexed') return 'page_not_indexed';
  if (status === 'no_answer' || decision === 'no_answer_silent') return 'no_answer';
  if (status === 'handoff' || decision === 'handoff') return 'handoff_after_ai';
  if (decision === 'ask_clarifying_question') return 'repeated_clarification';
  if (conf !== null && conf > 0 && conf < LOW_CONFIDENCE_FLOOR) return 'low_confidence';
  return null;
}

/**
 * Best-effort. Never throws to caller. Returns counts so the admin UI can
 * surface "X created, Y skipped".
 */
export async function generatePendingCandidates(
  config: ServerConfig,
  input: GenerateCandidatesInput,
): Promise<GenerateCandidatesResult> {
  const out: GenerateCandidatesResult = { scanned: 0, created: 0, skipped: 0, reasons: {} };
  const sb = getServiceClient(config);
  const since = input.sinceIso || new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
  const limit = Math.min(Math.max(1, input.limit || 200), 500);

  const { data: runs, error } = await sb
    .from('ai_agent_runs')
    .select('id, status, run_type, confidence, metadata, conversation_id, visitor_message_id, input_text, created_at')
    .eq('workspace_id', input.workspaceId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[learning.generator] runs query failed:', error.message);
    return out;
  }

  for (const run of runs || []) {
    out.scanned += 1;
    const reason = detectReason(run);
    if (!reason) { out.skipped += 1; continue; }

    const question = (run.input_text || '').toString().trim();
    const qSafety = isQuestionLearnable(question);
    if (!qSafety.ok) { out.skipped += 1; continue; }

    const normalized = normalizeQuestion(question);
    if (!normalized) { out.skipped += 1; continue; }

    // Dedupe across all "live" statuses.
    const { data: dup } = await sb
      .from('ai_agent_learning_candidates')
      .select('id')
      .eq('workspace_id', input.workspaceId)
      .eq('normalized_question', normalized)
      .in('status', ['pending', 'approved', 'converted_to_qna', 'converted_to_kb'])
      .limit(1)
      .maybeSingle();
    if (dup?.id) { out.skipped += 1; continue; }

    // Look for a real human reply AFTER the AI failure → upgrade to
    // operator_answer_available with the operator text as suggested_answer.
    let suggestedAnswer: string | null = null;
    let operatorMessageId: string | null = null;
    let confidence: number | null = null;
    let effectiveReason: CandidateReason = reason;

    if (run.conversation_id) {
      const { data: laterMsgs } = await sb
        .from('conversation_messages')
        .select('id, body, sender_type, sender_id, metadata, created_at')
        .eq('conversation_id', run.conversation_id)
        .gt('created_at', run.created_at)
        .order('created_at', { ascending: true })
        .limit(20);
      for (const m of laterMsgs || []) {
        if (isAiAgentMessage(m)) continue;
        if (isHumanOperatorMessage(m)) {
          const ans = (m.body || '').toString();
          const ansSafety = isAnswerLearnable(ans);
          if (ansSafety.ok) {
            suggestedAnswer = ans;
            operatorMessageId = m.id;
            effectiveReason = 'operator_answer_available';
            confidence = 0.7;
          }
          break;
        }
      }
    }

    const detected = detectInputLanguage(question);
    const locale = detected !== 'unknown' ? detected : null;
    const pageCtx = run?.metadata?.page_context || null;
    const selectedSources = run?.metadata?.retrieval?.selected_sources
      || run?.metadata?.selected_sources
      || null;
    const answerStrategy = run?.metadata?.answer_strategy || null;

    const { error: insErr } = await sb.from('ai_agent_learning_candidates').insert({
      workspace_id: input.workspaceId,
      conversation_id: run.conversation_id,
      visitor_message_id: run.visitor_message_id,
      operator_message_id: operatorMessageId,
      question_text: question,
      answer_text: suggestedAnswer || '',
      normalized_question: normalized,
      source_type: effectiveReason === 'operator_answer_available' ? 'operator_reply' : 'ai_failure',
      locale,
      status: 'pending',
      confidence_score: confidence,
      suggested_title: question.slice(0, 120),
      suggested_answer: suggestedAnswer,
      metadata: {
        reason: effectiveReason,
        run_id: run.id,
        run_status: run.status,
        run_confidence: run.confidence ?? null,
        page_context: pageCtx,
        selected_sources: selectedSources,
        answer_strategy_reason: answerStrategy?.reason || null,
        answer_strategy_decision: answerStrategy?.decision_type || null,
      },
    });
    if (insErr) {
      console.warn('[learning.generator] insert failed:', insErr.message);
      out.skipped += 1;
      continue;
    }
    out.created += 1;
    out.reasons[effectiveReason] = (out.reasons[effectiveReason] || 0) + 1;
  }

  return out;
}