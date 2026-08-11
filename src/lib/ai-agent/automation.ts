/**
 * AI Agent API client — automation domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Guidance, routing, topics, workflows, message triggers, tools and tool
 * servers. Same URLs, methods, bodies, and response types as before.
 */
import { jsonFetch } from './client.js';


export type GuidanceRuleType =
  | 'tone' | 'answer_policy' | 'escalation_policy' | 'restricted_topic'
  | 'fallback_behavior' | 'sales_guidance' | 'support_guidance' | 'pricing_guidance';


export interface GuidanceRule {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  rule_type: GuidanceRuleType;
  condition_json: Record<string, unknown>;
  instruction: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}


export type RoutingTrigger =
  | 'human_request' | 'no_answer' | 'low_confidence' | 'topic_detected'
  | 'business_hours' | 'language' | 'vip_customer' | 'plan_limit';

export type RoutingAction =
  | 'handoff' | 'assign_team' | 'assign_operator' | 'keep_ai' | 'create_ticket' | 'mark_priority';


export interface RoutingRule {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  trigger_type: RoutingTrigger;
  conditions_json: Record<string, unknown>;
  action_type: RoutingAction;
  action_json: Record<string, unknown>;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}


// ─── Pass B1 types ───
export type TopicAction = 'label_only' | 'route' | 'trigger_workflow' | 'suggest_reply';

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
  id: string; name: string; slug: string; confidence: number;
  matchedKeywords: string[]; matchedExamples: string[];
  action: TopicAction; actionJson: Record<string, unknown>;
}

export interface TopicDetectionResult {
  detectedTopics: DetectedTopic[];
  language: string;
  explanation: string;
}

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface WorkflowRecord {
  id: string; workspace_id: string; name: string;
  description: string | null;
  trigger_json: Record<string, any>;
  steps_json: Array<Record<string, any>>;
  enabled: boolean; version: number; status: WorkflowStatus;
  created_at: string; updated_at: string;
}

export interface WorkflowPreviewResult {
  valid: boolean;
  errors: string[];
  wouldTrigger: boolean;
  matchedConditions: string[];
  plannedActions: Array<{ type: string; details: Record<string, unknown> }>;
}

export type MessageTriggerEvent =
  | 'visitor_first_message' | 'conversation_started' | 'after_prechat'
  | 'no_operator_online' | 'ai_no_answer' | 'topic_detected'
  | 'human_requested' | 'business_hours_closed';

export type MessageTriggerAction =
  | 'send_message' | 'start_workflow' | 'handoff' | 'assign' | 'tag' | 'internal_note';

export interface MessageTriggerRecord {
  id: string; workspace_id: string; name: string;
  description: string | null;
  event_type: MessageTriggerEvent;
  conditions_json: Record<string, any>;
  action_type: MessageTriggerAction;
  action_json: Record<string, any>;
  delay_seconds: number;
  enabled: boolean;
  created_at: string; updated_at: string;
}


// ─── Pass B2 types ───
export type ToolType = 'internal' | 'mcp' | 'webhook' | 'crm' | 'ticket';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  tool_type: ToolType;
  provider: string | null;
  server_id: string | null;
  config_json: Record<string, any>;
  enabled: boolean;
  permissions_json: Record<string, any>;
  risk_level: ToolRiskLevel;
  created_at: string;
  updated_at: string;
}


export type ToolServerType = 'mcp' | 'internal' | 'webhook';

export type ToolServerStatus = 'disabled' | 'enabled' | 'error';

export type ToolServerAuth = 'none' | 'bearer' | 'basic' | 'api_key' | 'oauth';

export interface ToolServerRecord {
  id: string;
  workspace_id: string;
  name: string;
  server_type: ToolServerType;
  endpoint_url: string | null;
  status: ToolServerStatus;
  auth_type: ToolServerAuth;
  hasConfig?: boolean;
  allowed_tools: string[];
  permissions_json: Record<string, any>;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}


export const automationApi = {
  // Pass A — Guidance
  listGuidance: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/guidance?workspaceId=${workspaceId}`) as Promise<{ items: GuidanceRule[] }>,
  createGuidance: (input: Partial<GuidanceRule> & { workspaceId: string; title: string; rule_type: GuidanceRule['rule_type'] }) =>
    jsonFetch(`/api/ai-agent/guidance`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: GuidanceRule }>,
  updateGuidance: (id: string, patch: Partial<GuidanceRule>) =>
    jsonFetch(`/api/ai-agent/guidance/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: GuidanceRule }>,
  deleteGuidance: (id: string) =>
    jsonFetch(`/api/ai-agent/guidance/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  // Pass A — Routing
  listRouting: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/routing?workspaceId=${workspaceId}`) as Promise<{ items: RoutingRule[] }>,
  createRouting: (input: Partial<RoutingRule> & { workspaceId: string; name: string; trigger_type: RoutingRule['trigger_type']; action_type: RoutingRule['action_type'] }) =>
    jsonFetch(`/api/ai-agent/routing`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: RoutingRule }>,
  updateRouting: (id: string, patch: Partial<RoutingRule>) =>
    jsonFetch(`/api/ai-agent/routing/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: RoutingRule }>,
  deleteRouting: (id: string) =>
    jsonFetch(`/api/ai-agent/routing/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  // Pass B1 — Topics
  listTopics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/topics?workspaceId=${workspaceId}`) as Promise<{ items: TopicRecord[] }>,
  createTopic: (input: Partial<TopicRecord> & { workspaceId: string; name: string }) =>
    jsonFetch(`/api/ai-agent/topics`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: TopicRecord }>,
  updateTopic: (id: string, patch: Partial<TopicRecord>) =>
    jsonFetch(`/api/ai-agent/topics/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: TopicRecord }>,
  deleteTopic: (id: string) =>
    jsonFetch(`/api/ai-agent/topics/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  seedDefaultTopics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/topics/seed-defaults`, { method: 'POST', body: JSON.stringify({ workspaceId }) }) as Promise<{ ok: boolean; created: number }>,
  testTopics: (input: { workspaceId: string; text: string; language?: string }) =>
    jsonFetch(`/api/ai-agent/topics/test`, { method: 'POST', body: JSON.stringify(input) }) as Promise<TopicDetectionResult>,
  // Pass B1 — Workflows
  listWorkflows: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/workflows?workspaceId=${workspaceId}`) as Promise<{ items: WorkflowRecord[] }>,
  createWorkflow: (input: Partial<WorkflowRecord> & { workspaceId: string; name: string }) =>
    jsonFetch(`/api/ai-agent/workflows`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: WorkflowRecord }>,
  updateWorkflow: (id: string, patch: Partial<WorkflowRecord>) =>
    jsonFetch(`/api/ai-agent/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: WorkflowRecord }>,
  deleteWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  duplicateWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}/duplicate`, { method: 'POST' }) as Promise<{ item: WorkflowRecord }>,
  validateWorkflow: (id: string) =>
    jsonFetch(`/api/ai-agent/workflows/${id}/validate`, { method: 'POST' }) as Promise<{ valid: boolean; errors: string[] }>,
  previewWorkflow: (input: { workspaceId: string; workflowDraft: any; sampleMessage?: string; sampleContext?: any }) =>
    jsonFetch(`/api/ai-agent/workflows/preview`, { method: 'POST', body: JSON.stringify(input) }) as Promise<WorkflowPreviewResult>,
  getWorkflowMeta: () =>
    jsonFetch(`/api/ai-agent/workflows/_meta`) as Promise<{ triggers: string[]; conditions: string[]; actions: string[] }>,
  // Pass B1 — Message triggers
  listMessageTriggers: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/message-triggers?workspaceId=${workspaceId}`) as Promise<{ items: MessageTriggerRecord[] }>,
  createMessageTrigger: (input: Partial<MessageTriggerRecord> & { workspaceId: string; name: string; event_type: MessageTriggerRecord['event_type']; action_type: MessageTriggerRecord['action_type'] }) =>
    jsonFetch(`/api/ai-agent/message-triggers`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: MessageTriggerRecord }>,
  updateMessageTrigger: (id: string, patch: Partial<MessageTriggerRecord>) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: MessageTriggerRecord }>,
  deleteMessageTrigger: (id: string) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  testMessageTrigger: (id: string) =>
    jsonFetch(`/api/ai-agent/message-triggers/${id}/test`, { method: 'POST' }) as Promise<{ ok: boolean; dryRun: boolean; runtimeExecutionEnabled: boolean; planned: any; note: string }>,
  listTools: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/tools?workspaceId=${workspaceId}`) as Promise<{ items: ToolRecord[]; defaultInternalTools: Array<{ name: string; description: string; risk_level: ToolRiskLevel }>; runtimeExecutionEnabled: boolean }>,
  createTool: (input: Partial<ToolRecord> & { workspaceId: string; name: string; tool_type: ToolRecord['tool_type'] }) =>
    jsonFetch(`/api/ai-agent/tools`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: ToolRecord }>,
  updateTool: (id: string, patch: Partial<ToolRecord> & { confirm_high_risk?: boolean }) =>
    jsonFetch(`/api/ai-agent/tools/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: ToolRecord }>,
  deleteTool: (id: string) =>
    jsonFetch(`/api/ai-agent/tools/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  listToolServers: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/tool-servers?workspaceId=${workspaceId}`) as Promise<{ items: ToolServerRecord[]; runtimeExecutionEnabled: boolean }>,
  createToolServer: (input: Partial<ToolServerRecord> & { workspaceId: string; name: string; server_type: ToolServerRecord['server_type'] }) =>
    jsonFetch(`/api/ai-agent/tool-servers`, { method: 'POST', body: JSON.stringify(input) }) as Promise<{ item: ToolServerRecord }>,
  updateToolServer: (id: string, patch: Partial<ToolServerRecord>) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Promise<{ item: ToolServerRecord }>,
  deleteToolServer: (id: string) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}`, { method: 'DELETE' }) as Promise<{ ok: boolean }>,
  testToolServer: (id: string) =>
    jsonFetch(`/api/ai-agent/tool-servers/${id}/test`, { method: 'POST' }) as Promise<{ ok: boolean; runtimeExecutionEnabled: boolean; validations: Array<{ key: string; ok: boolean; message?: string }>; message: string }>,
};
