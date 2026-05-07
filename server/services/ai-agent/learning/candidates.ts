/**
 * AI Agent — learning candidates v1.
 *
 * When an operator sends a real human reply in a conversation where the AI
 * recently failed / handed off / asked for clarification, we pair the
 * visitor's last question with the operator's answer and store it as a
 * pending candidate. Approval (and conversion to Q&A or KB) is manual.
 *
 * Hard rules:
 *   - Workspace-scoped. Never cross workspaces.
 *   - Never created from spam conversations.
 *   - Never created from AI-authored messages.
 *   - Sensitive-token / ack-only / too-short answers are dropped.
 *   - Duplicates per (workspace_id, normalized_question) are skipped.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { isConversationSpam } from '../spamGuard.js';
import { isAiAgentMessage, isHumanOperatorMessage } from '../handoffState.js';
import { detectInputLanguage } from '../language.js';
import { normalizeQuestion } from './normalize.js';
import { isAnswerLearnable, isQuestionLearnable } from './safety.js';

export interface MaybeCreateCandidateInput {
  workspaceId: string;
  conversationId: string;
  operatorMessageId: string;
  operatorMessageBody: string;
  operatorId: string | null;
}

export interface MaybeCreateCandidateResult {
  created: boolean;
  candidateId?: string;
  reason?: string;
}

/**
 * Called after an operator message is inserted in the inbox. Best-effort:
 * any failure is logged and swallowed.
 */
export async function maybeCreateLearningCandidateFromOperatorReply(
  config: ServerConfig,
  input: MaybeCreateCandidateInput,
): Promise<MaybeCreateCandidateResult> {
  try {
    const sb = getServiceClient(config);

    // 1. Settings — workspace must have learning enabled.
    const { data: settings } = await sb
      .from('ai_agent_settings')
      .select('learning_enabled, auto_create_learning_candidates, allowed_locales')
      .eq('workspace_id', input.workspaceId)
      .maybeSingle();
    if (!settings) return { created: false, reason: 'no_settings' };
    if ((settings as any).learning_enabled === false) return { created: false, reason: 'learning_disabled' };
    if ((settings as any).auto_create_learning_candidates === false) return { created: false, reason: 'auto_create_disabled' };

    // 2. Spam guard.
    if (await isConversationSpam(config, input.conversationId)) {
      return { created: false, reason: 'spam' };
    }

    // 3. Operator-answer safety.
    const ansSafety = isAnswerLearnable(input.operatorMessageBody || '');
    if (!ansSafety.ok) return { created: false, reason: ansSafety.reason };

    // 4. Find the most recent visitor question + recent AI run that bailed.
    const { data: msgs } = await sb
      .from('conversation_messages')
      .select('id, body, sender_type, sender_id, metadata, created_at')
      .eq('conversation_id', input.conversationId)
      .order('created_at', { ascending: false })
      .limit(30);
    const ordered = (msgs || []).slice().reverse();

    // The visitor question should be the last visitor message BEFORE the
    // operator reply.
    let visitorMessageId: string | null = null;
    let visitorBody = '';
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const m: any = ordered[i];
      if (m.id === input.operatorMessageId) continue;
      const st = (m.sender_type || '').toLowerCase();
      if (st === 'contact' || st === 'visitor' || st === 'user_visitor') {
        if (isAiAgentMessage(m)) continue;
        visitorMessageId = m.id;
        visitorBody = (m.body || '').toString();
        break;
      }
      if (isHumanOperatorMessage(m)) break; // hit an earlier operator reply — give up.
    }
    const qSafety = isQuestionLearnable(visitorBody);
    if (!qSafety.ok) return { created: false, reason: qSafety.reason };

    // 5. AI run signal — was there a recent failed / handoff / clarification run?
    const { data: runs } = await sb
      .from('ai_agent_runs')
      .select('id, status, run_type, metadata, created_at')
      .eq('conversation_id', input.conversationId)
      .order('created_at', { ascending: false })
      .limit(10);
    const aiSignalled = (runs || []).some((r: any) => {
      const status = (r.status || '').toLowerCase();
      const decision = r?.metadata?.answer_strategy?.decision_type || '';
      if (['no_answer','handoff','failed','suggested'].includes(status)) return true;
      if (['no_answer_silent','handoff','ask_clarifying_question'].includes(decision)) return true;
      return false;
    });
    if (!aiSignalled) return { created: false, reason: 'no_ai_failure_signal' };

    // 6. Locale & dedupe.
    const detected = detectInputLanguage(visitorBody);
    const locale = detected !== 'unknown' ? detected : null;
    const normalized = normalizeQuestion(visitorBody);
    if (!normalized) return { created: false, reason: 'normalize_empty' };

    const { data: existing } = await sb
      .from('ai_agent_learning_candidates')
      .select('id, status')
      .eq('workspace_id', input.workspaceId)
      .eq('normalized_question', normalized)
      .in('status', ['pending','approved','converted_to_qna','converted_to_kb','rejected'])
      .limit(1)
      .maybeSingle();
    if (existing?.id) return { created: false, reason: 'duplicate' };

    // 7. Insert.
    const suggestedTitle = visitorBody.slice(0, 120);
    const { data: inserted, error } = await sb
      .from('ai_agent_learning_candidates')
      .insert({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        visitor_message_id: visitorMessageId,
        operator_message_id: input.operatorMessageId,
        question_text: visitorBody,
        answer_text: input.operatorMessageBody,
        normalized_question: normalized,
        source_type: 'operator_reply',
        locale,
        status: 'pending',
        suggested_title: suggestedTitle,
        suggested_answer: input.operatorMessageBody,
        reason: 'operator_answer_available',
        metadata: {
          operator_id: input.operatorId,
          ai_signalled: true,
          reason: 'operator_answer_available',
        },
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[ai-agent.learning] insert failed:', error.message);
      return { created: false, reason: error.message };
    }
    return { created: true, candidateId: inserted.id };
  } catch (err: any) {
    console.warn('[ai-agent.learning] candidate hook failed:', err?.message || err);
    return { created: false, reason: err?.message || 'unknown' };
  }
}

/**
 * Placeholder — engine.ts imports this so future passes can create a
 * candidate the moment AI bails out (without waiting for the operator reply).
 * v1 returns no-op; the actual creation happens after the operator replies.
 */
export async function maybeCreateLearningCandidateFromAiSkip(
  _config: ServerConfig,
  _args: { workspaceId: string; conversationId: string; visitorMessageId: string; question: string; reason: string },
): Promise<void> {
  /* noop in v1 */
}