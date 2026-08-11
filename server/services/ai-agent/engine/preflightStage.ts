/**
 * AI Agent engine — preflight stage.
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit B). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, and terminal-result wrapping of
 * existing early `return` statements) is new. No behavior change.
 *
 * Responsibilities: empty-question short-circuit, platform kill-switch /
 * entitlement gate, workspace AI settings load + enabled/mode-off check,
 * runtime config load (best-effort), spam guard.
 *
 * IMPORTANT: platform-gate rejection currently logs a skipped run;
 * workspace-disabled does NOT. This asymmetry is preserved exactly as-is
 * (not "standardized").
 */
import type { ServerConfig } from '../../../config.js';
import { getOrCreateSettings } from '../settings.js';
import { logRun } from '../logs.js';
import { isConversationSpam } from '../spamGuard.js';
import { loadAiAgentRuntimeConfig } from '../runtimeConfig.js';
import { isAutoAnswerAllowedForWorkspace } from '../platformGuards.js';
import { detectPageIntent } from './helpers.js';
import type { MaybeRunInput, MaybeRunResult } from './types.js';

export interface PreflightResult {
  pageContext: MaybeRunInput['pageContext'] | null;
  isPageIntent: boolean;
  settings: Awaited<ReturnType<typeof getOrCreateSettings>>;
  runtimeCfg: Awaited<ReturnType<typeof loadAiAgentRuntimeConfig>> | null;
  decisionTimeline: string[];
}

export async function runPreflightStage(
  config: ServerConfig,
  input: MaybeRunInput,
): Promise<{ terminal: MaybeRunResult } | PreflightResult> {
  const { workspaceId, conversationId, visitorMessageId } = input;
  const question = (input.question || '').trim();
  if (!question) {
    return { terminal: { ran: false, action: 'skipped', reason: 'empty_question' } };
  }

  // E12 Platform kill switch + auto_answer toggle. Visitor messages still
  // flow normally to the operator inbox; we only short-circuit AI side
  // effects (LLM, AI reply, suggestion, handoff).
  const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
  if (platformGate.allowed !== true) {
    const reason = (platformGate as { allowed: false; reason: string }).reason;
    try {
      await logRun(config, {
        workspaceId,
        conversationId,
        visitorMessageId,
        runType: 'skip',
        mode: 'off',
        status: 'skipped',
        inputText: input.question,
        skipReason: reason,
      });
    } catch { /* never break visitor flow */ }
    return { terminal: { ran: false, action: 'skipped', reason } };
  }

  const pageContext = input.pageContext || null;
  // E2C — lightweight intent detector for "what is this page" questions.
  const isPageIntent = detectPageIntent(question);

  const settings = await getOrCreateSettings(config, workspaceId);
  if (!settings.enabled || settings.mode === 'off') {
    return { terminal: { ran: false, action: 'skipped', reason: 'disabled_or_off' } };
  }

  // Pass C1 — load runtime configuration (cached 30s per workspace).
  // Best-effort: any failure must not break the existing auto-reply flow.
  const runtimeCfg = await loadAiAgentRuntimeConfig(config, workspaceId).catch((err) => {
    console.warn('[ai-agent.runtime] runtimeConfig load failed:', err?.message || err);
    return null;
  });
  const decisionTimeline: string[] = ['runtime_config_loaded'];
  if (runtimeCfg) {
    console.log('[ai-agent.runtime] config loaded', {
      workspaceId,
      topics: runtimeCfg.topics.length,
      guidance: runtimeCfg.guidanceRules.length,
      routing: runtimeCfg.routingRules.length,
      triggers: runtimeCfg.messageTriggers.length,
      tools: runtimeCfg.internalTools.length,
      warnings: runtimeCfg.warnings,
    });
  }

  // Spam guard — never auto-reply or suggest on flagged conversations.
  // This runs before retrieval/LLM so we don't burn tokens on spam.
  if (await isConversationSpam(config, conversationId)) {
    const runId = await logRun(config, {
      workspaceId,
      conversationId,
      visitorMessageId,
      runType: 'skip',
      mode: settings.mode,
      status: 'skipped',
      inputText: input.question,
      skipReason: 'spam',
    });
    return { terminal: { ran: false, action: 'skipped', reason: 'spam', runId } };
  }

  return { pageContext, isPageIntent, settings, runtimeCfg, decisionTimeline };
}
