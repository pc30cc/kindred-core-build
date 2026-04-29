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
  trigger_value: string | null;
  action: string;
  action_target: string | null;
  priority: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface MessageTrigger {
  id: string;
  name: string;
  event: string;
  conditions: Record<string, unknown>;
  action_type: string;
  action_payload: Record<string, unknown>;
  enabled: boolean;
  run_once_per_conversation: boolean;
}

export interface InternalToolRecord {
  id: string;
  name: string;
  slug: string;
  kind: 'internal';
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ExtendedInstructions {
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

  const [guidanceRes, routingRes, topicsRes, triggersRes, toolsRes, kbStatsRes] =
    await Promise.all([
      sb
        .from('ai_agent_guidance_rules')
        .select('id,type,title,description,body,priority,enabled,metadata')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .order('priority', { ascending: true }),
      sb
        .from('ai_agent_routing_rules')
        .select('id,name,trigger_type,trigger_value,action,action_target,priority,enabled,metadata')
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
        .select('id,name,event,conditions,action_type,action_payload,enabled,run_once_per_conversation')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .order('priority', { ascending: true }),
      sb
        .from('ai_agent_tools')
        .select('id,name,slug,kind,enabled,config')
        .eq('workspace_id', workspaceId)
        .eq('enabled', true)
        .eq('kind', 'internal'),
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

  const instructions: ExtendedInstructions = (settings.instructions as any) || {};

  const out: AiAgentRuntimeConfig = {
    settings,
    instructions,
    guidanceRules: (guidanceRes.data || []) as GuidanceRule[],
    routingRules: (routingRes.data || []) as RoutingRule[],
    topics: (topicsRes.data || []) as TopicRecord[],
    messageTriggers: (triggersRes.data || []) as MessageTrigger[],
    internalTools: (toolsRes.data || []) as InternalToolRecord[],
    knowledgeStatus,
    warnings,
    loadedAt: Date.now(),
  };

  cache.set(workspaceId, out);
  return out;
}