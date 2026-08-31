/**
 * AI Agent Console — Pass B2: Overview / Diagnostics aggregator.
 *
 * Pure read-only aggregation across configuration tables and ai_agent_runs.
 * No side effects. Used by GET /api/ai-agent/overview.
 */
import { resolveHumanRequestSignal } from './humanRequest.js';
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
  // C2B runtime diagnostics
  let triggerExecutions24h = 0;
  let workflowPlanned24h = 0;
  let routingHandoffs24h = 0;
  let routingKeepAi24h = 0;
  let toolExecutions24h = 0;
  let hardHandoffs24h = 0;
  let duplicateTriggersSkipped24h = 0;
  // Pass D — workflow execution diagnostics
  let workflowExecuted24h = 0;
  let workflowBlocked24h = 0;
  let workflowSkipped24h = 0;
  let workflowStopAi24h = 0;
  let workflowHandoffs24h = 0;
  let workflowMessagesSent24h = 0;
  let workflowDuplicateSkips24h = 0;
  const recentRuntimeActions: Array<Record<string, unknown>> = [];
  try {
    const { data: repairs } = await sb
      .from('ai_agent_runs')
      .select('id, status, created_at, metadata')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since24)
      .limit(1000);
    for (const r of repairs || []) {
      const m: any = r.metadata || {};
      if (m?.language?.outputRepaired || m?.outputLanguageRepaired) outputLanguageRepairs24h += 1;
      const tr = m?.message_triggers || {};
      const wf = m?.workflows || {};
      const tl = m?.tools || {};
      const ro = m?.routing || {};
      triggerExecutions24h += Array.isArray(tr.executed) ? tr.executed.length : 0;
      duplicateTriggersSkipped24h += Array.isArray(tr.skipped)
        ? tr.skipped.filter((s: any) => (s?.reason || '').includes('duplicate')).length : 0;
      workflowPlanned24h += Array.isArray(wf.plannedActions) ? wf.plannedActions.length : 0;
      workflowExecuted24h += Array.isArray(wf.executedActions) ? wf.executedActions.length : 0;
      workflowBlocked24h += Array.isArray(wf.blockedActions) ? wf.blockedActions.length : 0;
      workflowSkipped24h += Array.isArray(wf.skippedActions) ? wf.skippedActions.length : 0;
      if (Array.isArray(wf.executedActions)) {
        for (const a of wf.executedActions) {
          if (a?.action_type === 'handoff') workflowHandoffs24h += 1;
          if (a?.action_type === 'send_message' || a?.action_type === 'ask_question') workflowMessagesSent24h += 1;
        }
      }
      if (Array.isArray(wf.skippedActions)) {
        workflowDuplicateSkips24h += wf.skippedActions.filter((s: any) => (s?.reason || '').includes('duplicate')).length;
      }
      if (m?.workflow_only === true || (Array.isArray(m?.decision_timeline) && m.decision_timeline.includes('workflow_stopped_ai'))) {
        workflowStopAi24h += 1;
      }
      toolExecutions24h += Array.isArray(tl.usedTools) ? tl.usedTools.length : 0;
      if (Array.isArray(ro.executedActions)) {
        for (const a of ro.executedActions) {
          if (a?.type === 'handoff') routingHandoffs24h += 1;
          if (a?.type === 'keep_ai') routingKeepAi24h += 1;
        }
      }
      if (r.status === 'handoff') hardHandoffs24h += 1;
      if (recentRuntimeActions.length < 25 && (
        (Array.isArray(tr.executed) && tr.executed.length) ||
        (Array.isArray(wf.executedActions) && wf.executedActions.length) ||
        (Array.isArray(wf.blockedActions) && wf.blockedActions.length) ||
        (Array.isArray(wf.plannedActions) && wf.plannedActions.length) ||
        (Array.isArray(tl.usedTools) && tl.usedTools.length)
      )) {
        recentRuntimeActions.push({
          run_id: r.id, created_at: r.created_at, status: r.status,
          triggers_executed: tr.executed || [],
          workflows_executed: wf.executedActions || [],
          workflows_planned: wf.plannedActions || [],
          workflows_blocked: wf.blockedActions || [],
          tools_used: tl.usedTools || [],
        });
      }
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
    triggerExecutions24h,
    workflowPlanned24h,
    routingHandoffs24h,
    routingKeepAi24h,
    toolExecutions24h,
    hardHandoffs24h,
    duplicateTriggersSkipped24h,
    workflowExecuted24h,
    workflowBlocked24h,
    workflowSkipped24h,
    workflowStopAi24h,
    workflowHandoffs24h,
    workflowMessagesSent24h,
    workflowDuplicateSkips24h,
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
  if (counts.workflows === 0) {
    // No active workflows — skip warning.
  }
  if (workflowBlocked24h > 0) {
    warnings.push({ code: 'workflow_actions_blocked', severity: 'warn', message: `${workflowBlocked24h} workflow step(s) blocked in the last 24h (external/unsafe actions are never executed).` });
  }
  if (workflowDuplicateSkips24h > 0) {
    warnings.push({ code: 'workflow_duplicate_skips', severity: 'info', message: `${workflowDuplicateSkips24h} duplicate workflow execution(s) prevented in the last 24h.` });
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
    recentRuntimeActions,
    warnings,
    runtime: {
      workflowExecutionEnabled: true,
      workflowSafeExecutionOnly: true,
      triggerExecutionEnabled: true,
      internalToolExecutionEnabled: true,
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
  const { evaluateMessageTriggers, buildTriggerMetadata } = await import('./runtime/triggerRuntime.js');
  const { evaluateWorkflows, buildWorkflowMetadata } = await import('./runtime/workflowRuntime.js');
  const { evaluateInternalTools, buildToolMetadata } = await import('./runtime/toolRuntime.js');
  const { dryRunMatchedWorkflows } = await import('./runtime/workflowExecutor.js');

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

  // C2B — triggers / workflows / tools using the runtime evaluators.
  const ctxBase = {
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
    currentPageUrl: input.pageUrl || null,
    answerStrategy: null,
    now: Date.now(),
  };
  const triggerEvents: Array<'visitor_first_message' | 'topic_detected' | 'human_requested'> = ['visitor_first_message'];
  if ((topicResult.detectedTopics || []).length) triggerEvents.push('topic_detected');
  // Preview must mirror runtime: topic alone is not a human request.
  if (resolveHumanRequestSignal({
    text: input.message,
    configuredKeywords: (settings as any)?.handoff_keywords || [],
    topicHumanRequest: (topTopic as any)?.slug === 'human-request',
  }).explicit) triggerEvents.push('human_requested');

  let triggerMatched: any[] = [];
  let triggerExec: any[] = [];
  let triggerPlan: any[] = [];
  let triggerSkip: any[] = [];
  let workflowMeta: any = {
    matchedWorkflowIds: [], matchedWorkflowNames: [],
    wouldExecuteActions: [], plannedActions: [], blockedActions: [], skippedActions: [],
    stopAiWouldBe: false,
    runtimeExecutionEnabled: true, safeExecutionOnly: true, dryRun: true,
  };
  for (const ev of triggerEvents) {
    const r = evaluateMessageTriggers(ctxBase as any, ev);
    const meta = buildTriggerMetadata(r);
    triggerMatched = [...triggerMatched, ...meta.matched];
    triggerExec = [...triggerExec, ...meta.executed];
    triggerPlan = [...triggerPlan, ...meta.planned];
    triggerSkip = [...triggerSkip, ...meta.skipped];
    if (r.matchedTriggerIds.length) decisionTimeline.push('trigger_evaluated');
    const w = evaluateWorkflows(ctxBase as any, ev as any);
    const wm = buildWorkflowMetadata(w);
    const dry = dryRunMatchedWorkflows(w);
    workflowMeta = {
      matchedWorkflowIds: [...workflowMeta.matchedWorkflowIds, ...wm.matchedWorkflowIds],
      matchedWorkflowNames: [...workflowMeta.matchedWorkflowNames, ...wm.matchedWorkflowNames],
      wouldExecuteActions: [...workflowMeta.wouldExecuteActions, ...dry.wouldExecuteActions],
      plannedActions: [...workflowMeta.plannedActions, ...dry.plannedActions, ...wm.plannedActions.filter((p: any) => p.capability !== 'blocked')],
      blockedActions: [...workflowMeta.blockedActions, ...dry.blockedActions, ...(wm.blockedActions || [])],
      skippedActions: [...workflowMeta.skippedActions, ...dry.skippedActions, ...wm.skippedActions],
      stopAiWouldBe: workflowMeta.stopAiWouldBe || dry.stopAiWouldBe,
      runtimeExecutionEnabled: true,
      safeExecutionOnly: true,
      dryRun: true,
    };
    if (w.matchedWorkflowIds.length) decisionTimeline.push('workflow_evaluated');
    if (dry.wouldExecuteActions.length) decisionTimeline.push('workflow_would_execute');
    if (dry.blockedActions.length) decisionTimeline.push('workflow_step_blocked');
    if (dry.stopAiWouldBe) decisionTimeline.push('workflow_would_stop_ai');
  }
  // Tools — show what would be allowed; mark handoff_to_operator for human_requested.
  const requestedTools: Array<{ name: string; source: any }> = [];
  if ((topTopic as any)?.slug === 'human-request') requestedTools.push({ name: 'handoff_to_operator', source: 'runtime_policy' });
  if (routingResult.actions.some((a) => a.type === 'mark_priority' && a.executed)) requestedTools.push({ name: 'mark_priority', source: 'routing_rule' });
  const toolRes = evaluateInternalTools(ctxBase as any, requestedTools);
  const toolMeta = buildToolMetadata(toolRes);
  if (requestedTools.length) decisionTimeline.push('tools_evaluated');

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
    messageTriggers: {
      matched: triggerMatched, executed: triggerExec, planned: triggerPlan, skipped: triggerSkip,
    },
    workflows: workflowMeta,
    tools: toolMeta,
    executedActionsDryRun: triggerExec,
    plannedActions: [...routingMeta.plannedActions],
    finalAction: decision.action,
    decisionTimeline,
    workflowMatches: workflowMeta.matchedWorkflowIds.map((id: string, i: number) => ({
      id, name: workflowMeta.matchedWorkflowNames[i] || id, status: 'active',
    })),
    messageTriggersMatched: triggerMatched.map((m: any) => ({ id: m.id, name: m.name })),
    answerStrategy: { action: decision.action, reason: decision.reason ?? null, confidence: decision.confidence },
    finalAnswer: null,
    runtime: {
      conversationCreated: false,
      workflowExecutionEnabled: true,
      workflowSafeExecutionOnly: true,
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