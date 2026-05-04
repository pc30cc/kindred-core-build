/**
 * AI Agent Console — Pass B2: Overview / Diagnostics aggregator.
 *
 * Pure read-only aggregation across configuration tables and ai_agent_runs.
 * No side effects. Used by GET /api/ai-agent/overview.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getOrCreateSettings } from './settings.js';
import { getKnowledgeIndexStatus } from './knowledgeIndex/sync.js';

export interface OverviewWarning {
  code: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

export async function buildOverview(config: ServerConfig, workspaceId: string) {
  const sb = getServiceClient(config);
  const settings = await getOrCreateSettings(config, workspaceId);

  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();

  // Parallel counts via head:true for efficiency
  const countQ = (table: string, filters: Array<[string, any]> = []) => {
    let q = sb.from(table).select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    for (const [col, val] of filters) q = q.eq(col, val);
    return q;
  };

  const [
    guidance, routing, topics, workflows, triggers, tools, qna,
    pendingLearning, dataSources, activeChunks, embeddedChunks,
    aiRuns24, handoffs24, noAns24, replies24, failed24,
  ] = await Promise.all([
    countQ('ai_agent_guidance_rules'),
    countQ('ai_agent_routing_rules'),
    countQ('ai_agent_topics'),
    countQ('ai_agent_workflows'),
    countQ('ai_agent_message_triggers'),
    countQ('ai_agent_tools'),
    countQ('ai_agent_qna'),
    countQ('ai_agent_learning_candidates', [['status', 'pending']]),
    countQ('ai_data_sources'),
    sb.from('ai_knowledge_chunks').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'active'),
    sb.from('ai_knowledge_chunks').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).not('embedding', 'is', null),
    sb.from('ai_agent_runs').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).gte('created_at', since24),
    sb.from('ai_agent_runs').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'handoff').gte('created_at', since24),
    sb.from('ai_agent_runs').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'no_answer').gte('created_at', since24),
    sb.from('ai_agent_runs').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'replied').gte('created_at', since24),
    sb.from('ai_agent_runs').select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'failed').gte('created_at', since24),
  ]);

  // Recent runs
  const { data: recentRunsRows } = await sb
    .from('ai_agent_runs')
    .select('id,run_type,status,mode,created_at,input_text,output_text,confidence')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(15);

  // Recent sync logs
  const { data: syncLogsRows } = await sb
    .from('ai_source_sync_logs')
    .select('id,source_id,status,message,pages_found,chunks_created,embedded_chunks,errors,created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(10);

  // Output language repairs in last 24h (metadata flag)
  let outputLanguageRepairs24h = 0;
  try {
    const { data: repairs } = await sb
      .from('ai_agent_runs')
      .select('id, metadata')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since24)
      .limit(1000);
    for (const r of repairs || []) {
      const m: any = r.metadata || {};
      if (m?.language?.outputRepaired || m?.outputLanguageRepaired) outputLanguageRepairs24h += 1;
    }
  } catch { /* best-effort */ }

  // KB / QnA knowledge index status (lightweight)
  let knowledgeIndex: any = null;
  try {
    knowledgeIndex = await getKnowledgeIndexStatus(config, workspaceId);
  } catch { /* ignore */ }

  const counts = {
    guidanceRules: guidance.count ?? 0,
    routingRules: routing.count ?? 0,
    topics: topics.count ?? 0,
    workflows: workflows.count ?? 0,
    messageTriggers: triggers.count ?? 0,
    tools: tools.count ?? 0,
    qna: qna.count ?? 0,
    pendingLearningCandidates: pendingLearning.count ?? 0,
    dataSources: dataSources.count ?? 0,
    activeChunks: activeChunks.count ?? 0,
    embeddedChunks: embeddedChunks.count ?? 0,
    aiRuns24h: aiRuns24.count ?? 0,
    replies24h: replies24.count ?? 0,
    handoffs24h: handoffs24.count ?? 0,
    noAnswer24h: noAns24.count ?? 0,
    failed24h: failed24.count ?? 0,
    outputLanguageRepairs24h,
  };

  // Warnings
  const warnings: OverviewWarning[] = [];
  if (settings.enabled && counts.qna === 0 && counts.dataSources === 0) {
    warnings.push({ code: 'no_knowledge_sources', severity: 'warn', message: 'AI Agent is enabled but no Q&A or data sources are configured.' });
  }
  if (counts.activeChunks > 0 && counts.embeddedChunks === 0) {
    warnings.push({ code: 'no_embedded_chunks', severity: 'warn', message: 'Knowledge chunks exist but none are embedded yet. Rebuild the knowledge index.' });
  }
  if (counts.qna === 0) {
    warnings.push({ code: 'no_qna', severity: 'info', message: 'No Q&A pairs yet. Adding Q&A improves accuracy quickly.' });
  }
  if (counts.pendingLearningCandidates > 0) {
    warnings.push({ code: 'learning_candidates_pending', severity: 'info', message: `${counts.pendingLearningCandidates} learning candidate(s) awaiting review.` });
  }
  if (counts.workflows > 0) {
    warnings.push({ code: 'workflow_runtime_disabled', severity: 'info', message: 'Workflow runtime execution is not yet enabled. Workflows are configurable but inert.' });
  }
  if (counts.tools > 0) {
    warnings.push({ code: 'mcp_runtime_disabled', severity: 'info', message: 'MCP / tool runtime execution is disabled until platform admin enables it.' });
  }
  if (outputLanguageRepairs24h > 0) {
    warnings.push({ code: 'output_language_repairs', severity: 'info', message: `${outputLanguageRepairs24h} output language repair(s) in the last 24h.` });
  }
  // Website source not synced
  try {
    const { data: stale } = await sb
      .from('ai_data_sources')
      .select('id,name,last_synced_at,source_type')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'website')
      .is('last_synced_at', null)
      .limit(1);
    if (stale && stale.length > 0) {
      warnings.push({ code: 'website_not_synced', severity: 'warn', message: `Website source "${stale[0].name}" has not been synced yet.` });
    }
  } catch { /* ignore */ }

  return {
    settings,
    counts,
    knowledgeIndex,
    recentRuns: recentRunsRows || [],
    recentSyncLogs: syncLogsRows || [],
    warnings,
    runtime: {
      workflowExecutionEnabled: false,
      mcpExecutionEnabled: process.env.AI_AGENT_MCP_TEST_ENABLED === '1',
    },
  };
}

/**
 * Dry-run / test-run pipeline. Reuses the topic detector and retrieval
 * pipeline but never creates a real conversation, never sends a message,
 * and never executes workflows or tools.
 */
export async function runDryRun(
  config: ServerConfig,
  input: { workspaceId: string; message: string; pageUrl?: string; visitorLocale?: string },
) {
  const sb = getServiceClient(config);
  const { detectInputLanguageDetailed } = await import('./language.js');
  const { detectTopics } = await import('./topics/detector.js');
  const { loadAiAgentRuntimeConfig } = await import('./runtimeConfig.js');
  const { evaluateRoutingRules, buildRoutingMetadata } = await import('./runtime/routingRuntime.js');

  const langDetail = detectInputLanguageDetailed(input.message);
  const detectedLang = langDetail.language;
  const decisionTimeline: string[] = ['runtime_config_loaded', 'conversation_state_loaded'];

  // Load full runtime config (cached) so the dry-run uses the same evaluators.
  const runtimeCfg = await loadAiAgentRuntimeConfig(config, input.workspaceId).catch(() => null);

  // Topics
  const { data: topicRows } = await sb
    .from('ai_agent_topics').select('*')
    .eq('workspace_id', input.workspaceId).eq('enabled', true);
  const topicResult = detectTopics(input.message, (topicRows || []) as any[]);
  if (topicResult.detectedTopics?.length) decisionTimeline.push('topics_detected');

  // Routing — use the same C2 evaluator as the runtime engine.
  const settings = await getOrCreateSettings(config, input.workspaceId);
  const topTopic = topicResult.detectedTopics?.[0] || null;
  const routingResult = evaluateRoutingRules({
    workspaceId: input.workspaceId,
    conversationId: null,
    visitorText: input.message,
    inputLanguage: detectedLang || 'en',
    responseLanguage: input.visitorLocale || detectedLang || 'en',
    topTopic: topTopic as any,
    detectedTopics: (topicResult.detectedTopics || []) as any,
    settings,
    runtimeConfig: runtimeCfg,
    conversationState: null,
    now: Date.now(),
  });
  const routingMeta = buildRoutingMetadata(routingResult);
  if (routingResult.matchedRuleIds.length) decisionTimeline.push('routing_evaluated');
  if (routingResult.hardHandoff) decisionTimeline.push('routing_handoff_executed');

  // Message triggers — surface event matches (no execution)
  const { data: triggerRows } = await sb
    .from('ai_agent_message_triggers').select('*')
    .eq('workspace_id', input.workspaceId).eq('enabled', true);
  const triggersMatched = (triggerRows || [])
    .filter((t) => t.event_type === 'visitor_first_message' || t.event_type === 'topic_detected')
    .map((t) => ({ id: t.id, name: t.name, event_type: t.event_type, action_type: t.action_type }));

  // Workflow matches (by trigger.event)
  const { data: workflowRows } = await sb
    .from('ai_agent_workflows').select('id,name,trigger_json,status,enabled')
    .eq('workspace_id', input.workspaceId).eq('enabled', true);
  const workflowMatches = (workflowRows || [])
    .filter((w) => {
      const ev = (w.trigger_json as any)?.event;
      return ev === 'visitor_first_message' || ev === 'topic_detected';
    })
    .map((w) => ({ id: w.id, name: w.name, status: w.status }));

  // Retrieval (real, but read-only)
  const { retrieveSources } = await import('./retrieval.js');
  const sources = routingResult.hardHandoff
    ? []
    : await retrieveSources(config, input.workspaceId, input.message, detectedLang || 'en', 5);

  // Decision
  const { decide } = await import('./policy.js');
  const decision = routingResult.hardHandoff
    ? { action: 'handoff' as const, reason: 'routing_handoff', confidence: 0.95 }
    : decide({ settings, question: input.message, sources });
  decisionTimeline.push('answer_strategy_selected');

  // Final answer preview is left empty in dry-run (no LLM call).
  // Operators can use the existing Playground for a real LLM completion.
  const warnings: OverviewWarning[] = [];
  if (sources.length === 0) warnings.push({ code: 'no_sources', severity: 'info', message: 'No knowledge sources matched this query.' });
  if (langDetail.confidence < 0.5) warnings.push({ code: 'language_low_confidence', severity: 'info', message: 'Input language could not be confidently detected.' });

  return {
    language: { detected: detectedLang, confidence: langDetail.confidence, mixed: langDetail.mixed },
    topics: topicResult,
    guidanceRulesApplied: (runtimeCfg?.guidanceRules || []).map((g) => ({ id: g.id, title: g.title, type: g.type })),
    retrieval: {
      query: input.message,
      sourceCount: sources.length,
    },
    selectedSources: sources.map((s) => ({
      id: s.id, kind: s.kind, title: s.title, slug: s.slug ?? null, locale: s.locale ?? null, score: Number(s.score.toFixed(3)),
    })),
    routingRulesMatched: routingMeta.matchedRuleIds.map((id, i) => ({
      id, name: routingMeta.matchedRuleNames[i] || id,
    })),
    routing: routingMeta,
    plannedActions: [...routingMeta.plannedActions],
    finalAction: decision.action,
    decisionTimeline,
    workflowMatches,
    messageTriggersMatched: triggersMatched,
    answerStrategy: { action: decision.action, reason: decision.reason ?? null, confidence: decision.confidence },
    finalAnswer: null,
    runtime: {
      conversationCreated: false,
      workflowExecutionEnabled: false,
      mcpExecutionEnabled: process.env.AI_AGENT_MCP_TEST_ENABLED === '1',
    },
    warnings,
  };
}

export const DEFAULT_INTERNAL_TOOLS: Array<{
  name: string;
  description: string;
  risk_level: 'low' | 'medium' | 'high';
}> = [
  { name: 'search_kb', description: 'Search the workspace knowledge base', risk_level: 'low' },
  { name: 'handoff_to_operator', description: 'Hand the conversation to a human operator', risk_level: 'low' },
  { name: 'create_ticket', description: 'Create a support ticket from the conversation', risk_level: 'medium' },
  { name: 'get_business_hours', description: 'Look up the workspace business hours', risk_level: 'low' },
  { name: 'get_pricing_info', description: 'Look up plan and pricing information', risk_level: 'low' },
  { name: 'add_internal_note', description: 'Add an internal-only note to the conversation', risk_level: 'low' },
  { name: 'mark_priority', description: 'Mark the conversation as high priority', risk_level: 'medium' },
  { name: 'assign_team', description: 'Assign the conversation to a team', risk_level: 'medium' },
];