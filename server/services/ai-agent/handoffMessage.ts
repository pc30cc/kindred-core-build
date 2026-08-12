/**
 * AI Agent — context-aware handoff message composer.
 *
 * A handoff is a DECISION made deterministically (or proposed by the model
 * and approved by the policy gate). Its WORDING should not be one frozen
 * robotic sentence for every conversation, so when a provider is available
 * we ask the model for one short, context-aware sentence.
 *
 * Hard rules:
 *   - never throws; always returns a usable string
 *   - the owner-configured handoff/fallback text is used as tone guidance
 *     and as the fallback whenever the provider fails, is unavailable, or
 *     returns something unusable
 *   - the generated sentence makes no business promises and states no facts
 */
import type { ServerConfig } from '../../config.js';
import type { AgentSettings } from './settings.js';
import { executeAICompletion } from '../ai/index.js';
import { sanitizeAgentName } from './prompt.js';
import { languageDisplayName } from './language.js';

export interface ComposeHandoffInput {
  workspaceId: string;
  locale: string;
  /** Deterministic reason (human_request, no_kb_match, low_confidence, …). */
  reason: string;
  visitorText: string;
  conversationContext?: string | null;
  settings: AgentSettings;
  /** Deterministic message used when generation is unavailable. */
  fallback: string;
}

const MAX_LEN = 320;

export async function composeHandoffMessage(
  config: ServerConfig,
  input: ComposeHandoffInput,
): Promise<string> {
  const fallback = (input.fallback || '').trim();
  try {
    const agentName = sanitizeAgentName(input.settings.agent_name);
    const ownerText =
      (input.settings.handoff_message_localized || {})[input.locale]
      || input.settings.fallback_message
      || fallback;
    const system = [
      `You are ${agentName}, an AI assistant. Write ONE short sentence telling the visitor you are bringing in a human colleague.`,
      `Write it in ${input.locale} (${languageDisplayName(input.locale)}).`,
      'Rules: one sentence, warm and professional, reference what the visitor was asking about when it is obvious, make NO promises about timing, prices, policies or outcomes, state no business facts, add no greeting and no signature.',
      ownerText ? `Match the tone and intent of this workspace-configured message: "${ownerText}"` : '',
    ].filter(Boolean).join('\n');
    const user = [
      input.conversationContext ? String(input.conversationContext).slice(0, 800) : '',
      `Escalation reason: ${input.reason || 'unspecified'}`,
      `Visitor's latest message: ${String(input.visitorText || '').slice(0, 400)}`,
      'Sentence:',
    ].filter(Boolean).join('\n');

    const res = await executeAICompletion(config, {
      workspaceId: input.workspaceId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 120,
      temperature: 0.4,
    });
    const text = (res?.text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!text || text.length > MAX_LEN) return fallback;
    return text;
  } catch (err: any) {
    // Provider failure is NOT "the AI has no answer" — fall back to the
    // deterministic, owner-controlled wording and keep the run observable.
    console.warn('[ai-agent.handoff] message generation failed, using configured fallback:', err?.message || err);
    return fallback;
  }
}
