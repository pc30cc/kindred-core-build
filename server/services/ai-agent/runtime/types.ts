/**
 * AI Agent — C2 runtime evaluator shared types.
 */
import type { AgentSettings } from '../settings.js';
import type { AiAgentRuntimeConfig } from '../runtimeConfig.js';
import type { ConversationState } from '../conversationState.js';
import type { DetectedTopic } from '../topics/types.js';

export interface RuntimeEvaluationContext {
  workspaceId: string;
  conversationId: string | null;
  visitorMessageId?: string | null;
  visitorText: string;
  inputLanguage: string;
  responseLanguage: string;
  topTopic?: DetectedTopic | null;
  detectedTopics: DetectedTopic[];
  settings: AgentSettings;
  runtimeConfig: AiAgentRuntimeConfig | null;
  conversationState: ConversationState | null;
  currentPageUrl?: string | null;
  prechat?: Record<string, unknown> | null;
  answerStrategy?: { action?: string; confidence?: number; reason?: string | null } | null;
  now: number;
}

export type RuntimeActionType =
  | 'reply_template'
  | 'handoff'
  | 'keep_ai'
  | 'mark_priority'
  | 'assign_team_planned'
  | 'assign_operator_planned'
  | 'create_ticket_planned'
  | 'internal_note_planned'
  | 'tag_planned'
  | 'workflow_planned'
  | 'tool_planned'
  | 'tool_executed'
  | 'skip';

export type RuntimeActionSource =
  | 'routing_rule'
  | 'message_trigger'
  | 'workflow'
  | 'internal_tool'
  | 'runtime_policy';

export interface RuntimeAction {
  type: RuntimeActionType;
  reason?: string;
  source: RuntimeActionSource;
  sourceId?: string | null;
  sourceName?: string | null;
  payload?: Record<string, unknown>;
  executed: boolean;
  skippedReason?: string;
}