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
  /**
   * Precise reason behind the widget's online/offline availability state
   * (see server/services/widget/availability.ts's AvailabilityReason), NOT
   * the reduced online/offline boolean. Only 'outside_hours'/'override_closed'
   * mean "outside the configured business-hours schedule" — 'no_operators_online'
   * and 'always_offline'/'disabled' are distinct availability states that must
   * not be conflated with a business-hours match (Follow-up 9C).
   */
  availabilityReason?: string | null;
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