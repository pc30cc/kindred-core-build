/**
 * AI Agent — runtime configuration loader (Pass C1).
 *
 * Loads everything the runtime engine needs to answer ONE visitor message,
 * cached per workspace for 30s. No provider keys, no external MCP / webhook
 * tools are returned. Pure read.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getOrCreateSettings, type AgentSettings } from './settings.js';
import type { TopicRecord } from './topics/types.js';

export interface GuidanceRule {
  id: string;
  type: string;
  title: string;
  description: string | null;
  body: string | null;
  priority: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface RoutingRule {
  id: string;
  name: string;
  trigger_type: string;
  conditions_json: Record<string, unknown>;
  action_type: string;
  action_json: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

export interface MessageTrigger {
  id: string;
  name: string;
  event_type: string;
  conditions_json: Record<string, unknown>;
  action_type: string;
  action_json: Record<string, unknown>;
  delay_seconds: number;
  enabled: boolean;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  trigger_json: Record<string, unknown>;
  steps_json: unknown;
  enabled: boolean;
  status: string;
  version: number;
}

export interface InternalToolRecord {
  id: string;
  name: string;
  tool_type: 'internal' | 'mcp' | 'webhook' | 'crm' | 'ticket';
  risk_level: 'low' | 'medium' | 'high';
  enabled: boolean;
  config_json: Record<string, unknown>;
  permissions_json: Record<string, unknown>;
}

export interface ExtendedInstructions {
  /**
   * @deprecated legacy persisted key (ai_agent_settings.instructions.business_description).
   * Canonical field is AgentSettings.business_description (top-level column);
   * buildSystemPrompt() never reads this nested key. Not a write target for
   * any current UI -- kept only because historical rows may still contain it.
   */
  business_description?: string;
  brand_voice?: string;
  tone?: string;
  do_list?: string[];
  dont_list?: string[];
  pricing_instructions?: string;
  support_instructions?: string;
  handoff_instructions?: string;
  custom_system_instruction?: string;
  // legacy passthroughs
  custom_instructions?: string;
  escalation_instructions?: string;
  forbidden_topics?: string[];
  max_answer_length?: 'short' | 'medium' | 'long';
}

export interface KnowledgeStatusSummary {
  totalChunks: number;
  totalSources: number;
  hasEmbeddings: boolean;
}

export interface AiAgentRuntimeConfig {
  settings: AgentSettings;
  instructions: ExtendedInstructions;
  guidanceRules: GuidanceRule[];
  routingRules: RoutingRule[];
  topics: TopicRecord[];
  messageTriggers: MessageTrigger[];
  workflows: WorkflowRecord[];
  internalTools: InternalToolRecord[];
  knowledgeStatus: KnowledgeStatusSummary;
  warnings: string[];
  loadedAt: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, AiAgentRuntimeConfig>();

/** For tests / admin actions that mutate config. */
export function invalidateRuntimeConfig(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

export async function loadAiAgentRuntimeConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<AiAgentRuntimeConfig> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit;

  const sb = getServiceClient(config);
  const settings = await getOrCreateSettings(config, workspaceId);
  const warnings: string[] = [];

  const [guidanceRes, routingRes, topicsRes, triggersRes, workflowsRes, toolsRes, allEnabledToolsRes, kbStatsRes] =
    await Promise.all([
      sb
        .from('ai_agent_guidance_rules')
        .select('id,type,title,description,body,priority,enabled,metadata')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .order('priority', { ascending: true }),
      sb
        .from('ai_agent_routing_rules')
        .select('id,name,trigger_type,conditions_json,action_type,action_json,priority,enabled')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .order('priority', { ascending: true }),
      sb
        .from('ai_agent_topics')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true),
      sb
        .from('ai_agent_message_triggers')
        .select('id,name,event_type,conditions_json,action_type,action_json,delay_seconds,enabled')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true),
      sb
        .from('ai_agent_workflows')
        .select('id,name,description,trigger_json,steps_json,enabled,status,version')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .eq('status', 'active'),
      sb
        .from('ai_agent_tools')
        .select('id,name,tool_type,risk_level,enabled,config_json,permissions_json')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .eq('tool_type', 'internal'),
      sb
        .from('ai_agent_tools')
        .select('id,tool_type,enabled')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true),
      sb
        .from('ai_knowledge_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId),
    ]);

  const knowledgeStatus: KnowledgeStatusSummary = {
    totalChunks: kbStatsRes.count || 0,
    totalSources: 0,
    hasEmbeddings: (kbStatsRes.count || 0) > 0,
  };

  if (!knowledgeStatus.hasEmbeddings) warnings.push('no_knowledge_chunks_indexed');
  if (!settings.enabled) warnings.push('agent_disabled');

  const workflows = (workflowsRes.data || []) as WorkflowRecord[];
  if (workflows.length) warnings.push('workflows_planned_only');
  const externalEnabledTools = (allEnabledToolsRes.data || []).filter(
    (t: any) => t.tool_type && t.tool_type !== 'internal',
  );
  if (externalEnabledTools.length) warnings.push('external_tools_runtime_disabled');
  const triggersList = (triggersRes.data || []) as MessageTrigger[];
  const SUPPORTED_TRIGGER_ACTIONS = new Set([
    'send_message', 'handoff', 'start_workflow', 'assign', 'tag', 'internal_note',
  ]);
  if (triggersList.some((t) => !SUPPORTED_TRIGGER_ACTIONS.has(t.action_type))) {
    warnings.push('unsupported_trigger_actions');
  }

  const instructions: ExtendedInstructions = (settings.instructions as any) || {};

  const out: AiAgentRuntimeConfig = {
    settings,
    instructions,
    guidanceRules: (guidanceRes.data || []) as GuidanceRule[],
    routingRules: (routingRes.data || []) as RoutingRule[],
    topics: (topicsRes.data || []) as TopicRecord[],
    messageTriggers: triggersList,
    workflows,
    internalTools: (toolsRes.data || []) as InternalToolRecord[],
    knowledgeStatus,
    warnings,
    loadedAt: Date.now(),
  };

  cache.set(workspaceId, out);
  return out;
}