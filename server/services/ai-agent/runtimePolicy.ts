/**
 * AI Agent — runtime policy.
 *
 * Pure decision layer that combines settings, conversation state and
 * operator availability into a single "what should the engine do now?"
 * verdict. No IO inside this file beyond what the engine passes in.
 */
import type { AgentSettings, AgentMode } from './settings.js';
import type { ConversationState } from './conversationState.js';
import type { AvailabilityInfo } from './availability.js';

export type RuntimeAction =
  | 'skip'
  | 'suggest'
  | 'auto_reply'
  | 'handoff';

export type RuntimeReason =
  | 'disabled_or_off'
  | 'mode_suggest_only'
  | 'operators_online'
  | 'human_already_joined'
  | 'pending_handoff'
  | 'max_replies_reached'
  | 'rate_limited'
  | 'human_request'
  | 'ok';

export interface RuntimeDecision {
  action: RuntimeAction;
  reason: RuntimeReason;
  mode: AgentMode;
  availability: AvailabilityInfo['state'];
  /** True when AI is allowed to call the LLM and respond to the visitor. */
  canAutoReply: boolean;
  /** True when AI may produce an operator-facing suggestion instead. */
  canSuggest: boolean;
  notes: Record<string, unknown>;
}

export function isHumanRequest(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (keywords || []).some((k) => k && lower.includes(k.toLowerCase()));
}

export interface RuntimePolicyInput {
  settings: AgentSettings;
  state: ConversationState;
  availability: AvailabilityInfo;
  visitorText: string;
}

export function decideRuntime(input: RuntimePolicyInput): RuntimeDecision {
  const { settings, state, availability, visitorText } = input;
  const base = {
    mode: settings.mode,
    availability: availability.state,
    canAutoReply: false,
    canSuggest: false,
    notes: {} as Record<string, unknown>,
  };

  if (!settings.enabled || settings.mode === 'off') {
    return { ...base, action: 'skip', reason: 'disabled_or_off' };
  }

  // Human request keyword always wins — don't try to "outsmart" the user.
  if (
    settings.handoff_on_human_request &&
    isHumanRequest(visitorText, settings.handoff_keywords || [])
  ) {
    return { ...base, action: 'handoff', reason: 'human_request' };
  }

  // Pending handoff: AI stays quiet until operator picks up & resets.
  if ((settings as any).stop_on_handoff !== false && state.pendingHandoffRequested) {
    return { ...base, action: 'skip', reason: 'pending_handoff' };
  }

  // Per-conversation reply cap.
  const cap = Number(
    (settings as any).max_auto_replies_per_conversation ??
      settings.max_replies_per_conversation ?? 3,
  );
  if (cap > 0 && state.aiRepliesCountInConversation >= cap) {
    return { ...base, action: 'skip', reason: 'max_replies_reached' };
  }

  // Per-hour throttle.
  if (settings.max_replies_per_hour > 0 && state.aiRepliesInLastHour >= settings.max_replies_per_hour) {
    return { ...base, action: 'skip', reason: 'rate_limited' };
  }

  if (settings.mode === 'suggest_only') {
    return { ...base, action: 'suggest', reason: 'mode_suggest_only', canSuggest: true };
  }

  if (settings.mode === 'auto_reply_when_offline') {
    if (availability.state === 'offline') {
      return { ...base, action: 'auto_reply', reason: 'ok', canAutoReply: true };
    }
    return { ...base, action: 'suggest', reason: 'operators_online', canSuggest: true };
  }

  if (settings.mode === 'auto_reply_until_human_joins') {
    if (state.hasHumanAgentReplied) {
      return { ...base, action: 'suggest', reason: 'human_already_joined', canSuggest: true };
    }
    return { ...base, action: 'auto_reply', reason: 'ok', canAutoReply: true };
  }

  if (settings.mode === 'auto_reply_always') {
    return { ...base, action: 'auto_reply', reason: 'ok', canAutoReply: true };
  }

  return { ...base, action: 'skip', reason: 'disabled_or_off' };
}
