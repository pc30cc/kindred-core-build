/**
 * AI Agent — topic detection types.
 * Self-host. Pure data types, no runtime deps.
 */

/**
 * 'decline' is the one deterministic, server-enforced action: when the
 * top-detected topic for a turn carries it, the engine returns a fixed
 * refusal WITHOUT ever calling the model (see engine/answerStage.ts). Every
 * other action is advisory only — it labels/routes the turn but still lets
 * the LLM see and answer the message.
 */
export type TopicAction = 'label_only' | 'route' | 'trigger_workflow' | 'suggest_reply' | 'decline';

export interface TopicRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  slug: string;
  keywords: string[];
  examples: string[];
  language: string | null;
  confidence_threshold: number;
  action: TopicAction;
  action_json: Record<string, unknown>;
  enabled: boolean;
  system: boolean;
  created_at: string;
  updated_at: string;
}

export interface DetectedTopic {
  id: string;
  name: string;
  slug: string;
  confidence: number;
  matchedKeywords: string[];
  matchedExamples: string[];
  action: TopicAction;
  actionJson: Record<string, unknown>;
}

export interface DetectionResult {
  detectedTopics: DetectedTopic[];
  language: string;
  explanation: string;
}