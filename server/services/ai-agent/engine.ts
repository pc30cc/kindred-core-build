/**
 * AI Agent — conversation engine entry point.
 *
 * Phase 3 — Runtime Pro:
 *   - off / disabled    → no-op
 *   - suggest_only      → operator-facing suggestion (Phase 2 behaviour)
 *   - auto_reply_when_offline       → AI replies only when operators offline
 *   - auto_reply_until_human_joins  → AI replies until a human agent posts
 *   - auto_reply_always             → AI replies subject to safety caps
 *
 * Hard rules (do not relax):
 *   - never throws; widget /message must never break
 *   - answer_only_from_kb → no LLM call without a Q&A/KB match
 *   - human_request keyword → handoff, no LLM call
 *   - per-conversation cap, per-hour cap, pending handoff all enforced
 *
 * Phase 5 — staged extraction. runInternal() used to be a single ~1270-line
 * function; its exact original logic now lives, byte-for-byte unchanged,
 * across the 8 stage modules under ./engine/ (preflight → context →
 * automation → runtimeDecision → retrieval → answer → generation →
 * delivery). This function is just the orchestrator: it calls each stage in
 * the same order the original code ran in, and returns early the moment a
 * stage produces a terminal MaybeRunResult (mirroring the original's early
 * `return` statements exactly). No behavior change.
 */
import type { ServerConfig } from '../../config.js';
import type { RetrievedSource } from './retrieval.js';
import type { MaybeRunInput, MaybeRunResult } from './engine/types.js';
import { runPreflightStage } from './engine/preflightStage.js';
import { runContextStage } from './engine/contextStage.js';
import { runAutomationStage } from './engine/automationStage.js';
import { runRuntimeDecisionStage } from './engine/runtimeDecisionStage.js';
import { runRetrievalStage } from './engine/retrievalStage.js';
import { runAnswerStage } from './engine/answerStage.js';
import { runGenerationStage } from './engine/generationStage.js';
import { runDeliveryStage } from './engine/deliveryStage.js';
import { logRun } from './logs.js';

export type { MaybeRunInput, MaybeRunResult } from './engine/types.js';

export async function maybeRunAiAssistantAfterVisitorMessage(
  config: ServerConfig,
  input: MaybeRunInput,
): Promise<MaybeRunResult> {
  try {
    return await runInternal(config, input);
  } catch (err: any) {
    console.warn('[ai-agent] engine failed:', err?.message || err);
    // Persist the failure so a silent AI (no reply, no run row) is always
    // diagnosable from ai_agent_runs instead of only from server stdout.
    try {
      await logRun(config, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId || null,
        runType: 'auto_reply',
        mode: 'unknown',
        status: 'failed',
        inputText: input.question || null,
        outputText: null,
        metadata: { error: String(err?.message || err), stack: String(err?.stack || '').slice(0, 2000) },
      });
    } catch { /* logging must never mask the original failure */ }
    return { ran: false, action: 'failed', reason: err?.message || 'engine_error' };
  }
}

async function runInternal(
  config: ServerConfig,
  input: MaybeRunInput,
): Promise<MaybeRunResult> {
  const pre = await runPreflightStage(config, input);
  if ('terminal' in pre) return pre.terminal;

  const ctxStage = await runContextStage(config, input, pre);

  const auto = await runAutomationStage(config, input, pre, ctxStage);

  const decisionStage = await runRuntimeDecisionStage(config, input, pre, ctxStage, auto);
  if ('terminal' in decisionStage) return decisionStage.terminal;

  const retrieval = await runRetrievalStage(config, input, pre, ctxStage);

  const answer = await runAnswerStage(config, input, pre, ctxStage, auto, decisionStage, retrieval);
  if ('terminal' in answer) return answer.terminal;

  const generation = await runGenerationStage(config, input, pre, ctxStage, auto, decisionStage, retrieval, answer);
  if ('terminal' in generation) return generation.terminal;

  return runDeliveryStage(config, input, pre, ctxStage, auto, decisionStage, retrieval, answer, generation);
}

// Suppress unused-var warning for _RetrievedSource if added later
export type { RetrievedSource };
