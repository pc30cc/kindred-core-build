/**
 * AI Agent — Pass D: Safe Workflow Executor.
 *
 * Executes ONLY a strict allowlist of internal, non-destructive workflow
 * actions (send_message, ask_question, handoff, mark_priority, and — when
 * the host has the capability — add_internal_note).
 *
 * Anything else is logged as `planned` or `blocked` and never executed.
 *
 * Safety guarantees:
 *   - never makes external HTTP calls
 *   - never invokes MCP / webhooks / CRM / billing
 *   - never executes shell / sql / arbitrary code
 *   - idempotent per (workflowId, eventType, topic) via
 *     conversations.metadata.ai_workflow_executed_keys
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { RuntimeEvaluationContext } from './types.js';
import type { AgentSettings } from '../settings.js';
import {
  classifyWorkflowStep,
  DEFAULT_HOST_CAPABILITIES,
  type WorkflowEvaluationResult,
  type WorkflowEventType,
  type StepCapability,
  type WorkflowHostCapabilities,
} from './workflowRuntime.js';
import { pickStepMessage, type NormalizedWorkflowStep } from './workflowSteps.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markNeedsHuman, readAiConversationMeta } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { pickHandoffAckMessage } from './templates.js';

export interface WorkflowExecutorContext {
  config: ServerConfig;
  workspaceId: string;
  conversationId: string;
  responseLanguage: string;
  inputLanguage?: string | null;
  settings: AgentSettings;
  runId?: string | null;
  capabilities?: WorkflowHostCapabilities;
}

export interface ExecutedStepRecord {
  workflowId: string;
  workflowName: string;
  stepIndex: number;
  actionType: string;
  capability: StepCapability;
  reason: string;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WorkflowExecutionResult {
  executedActions: ExecutedStepRecord[];
  plannedActions: ExecutedStepRecord[];
  blockedActions: ExecutedStepRecord[];
  skippedActions: ExecutedStepRecord[];
  stopAi: boolean;
  insertedMessageIds: string[];
  handoffExecuted: boolean;
  priorityUpdated: boolean;
  executedDedupKeys: string[];
}

function emptyResult(): WorkflowExecutionResult {
  return {
    executedActions: [], plannedActions: [], blockedActions: [], skippedActions: [],
    stopAi: false, insertedMessageIds: [], handoffExecuted: false, priorityUpdated: false,
    executedDedupKeys: [],
  };
}

const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

async function appendExecutedKey(
  config: ServerConfig,
  conversationId: string,
  key: string,
): Promise<void> {
  if (!conversationId || !key) return;
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('conversations').select('metadata').eq('id', conversationId).maybeSingle();
  const meta: any = (row as any)?.metadata || {};
  const arr: string[] = Array.isArray(meta.ai_workflow_executed_keys) ? meta.ai_workflow_executed_keys : [];
  if (!arr.includes(key)) arr.push(key);
  meta.ai_workflow_executed_keys = arr;
  meta.ai_last_workflow_action_at = new Date().toISOString();
  await sb.from('conversations').update({ metadata: meta }).eq('id', conversationId);
}

async function executeSendMessage(
  ctx: WorkflowExecutorContext,
  workflow: { id: string; name: string },
  step: NormalizedWorkflowStep,
  isQuestion: boolean,
): Promise<{ messageId: string | null; stopAi: boolean; reason: string }> {
  const body = pickStepMessage(step.payload, ctx.responseLanguage, ctx.inputLanguage || undefined);
  if (!body) return { messageId: null, stopAi: false, reason: 'empty_message' };
  const display = deriveAgentDisplay(ctx.settings);
  // ask_question defaults stopAi=true; send_message defaults stopAi=false.
  const continueAi = step.payload.continue_ai === true ? true
    : step.payload.continue_ai === false ? false
    : !isQuestion;
  try {
    const inserted = await insertAiMessage(ctx.config, {
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      body,
      source: 'ai_agent',
      runId: ctx.runId ?? null,
      mode: ctx.settings.mode,
      handoff: false,
      agentName: display.agentName,
      agentLogoUrl: display.agentLogoUrl,
    });
    return { messageId: inserted.id || null, stopAi: !continueAi, reason: isQuestion ? 'ask_question' : 'send_message' };
  } catch (err: any) {
    console.warn('[ai-agent.runtime.workflowExecutor] send_message failed:', err?.message || err);
    return { messageId: null, stopAi: false, reason: 'send_message_failed' };
  }
}

async function executeHandoff(
  ctx: WorkflowExecutorContext,
  _workflow: { id: string; name: string },
): Promise<{ messageId: string | null; alreadyDone: boolean }> {
  const current = await readAiConversationMeta(ctx.config, ctx.conversationId).catch(() => null);
  const alreadyHandoff = !!current && (
    current.state === 'needs_human' ||
    current.state === 'human_active' ||
    current.handoff_requested === true ||
    !!current.human_takeover_at ||
    (current.metadata as any)?.ai_handoff_sent === true
  );
  if (alreadyHandoff) return { messageId: null, alreadyDone: true };
  await markHandoffRequested(ctx.config, ctx.conversationId).catch(() => {});
  // Insert the ack BEFORE markNeedsHuman() — markNeedsHuman synchronously
  // runs routing and inserts its own "X joined" / "no one's available"
  // system message, so the ack has to land first or the routing outcome
  // renders ahead of the AI's own "connecting you now" message.
  const display = deriveAgentDisplay(ctx.settings);
  const ack = pickHandoffAckMessage(ctx.settings, ctx.responseLanguage);
  const inserted = await insertAiMessage(ctx.config, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    body: ack,
    source: 'ai_agent_handoff',
    runId: ctx.runId ?? null,
    mode: ctx.settings.mode,
    handoff: true,
    agentName: display.agentName,
    agentLogoUrl: display.agentLogoUrl,
  });
  await markNeedsHuman(ctx.config, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    reason: 'human_request',
  }).catch(() => {});
  return { messageId: inserted.id || null, alreadyDone: false };
}

async function executeMarkPriority(
  ctx: WorkflowExecutorContext,
  step: NormalizedWorkflowStep,
): Promise<{ ok: boolean; priority: string }> {
  const raw = String(step.payload.priority || step.payload.level || 'high').toLowerCase();
  const desired = VALID_PRIORITIES.has(raw) ? raw : 'high';
  try {
    const sb = getServiceClient(ctx.config);
    await sb.from('conversations').update({ priority: desired })
      .eq('id', ctx.conversationId).eq('workspace_id', ctx.workspaceId);
    return { ok: true, priority: desired };
  } catch (err: any) {
    console.warn('[ai-agent.runtime.workflowExecutor] mark_priority failed:', err?.message || err);
    return { ok: false, priority: desired };
  }
}

async function executeInternalNote(
  ctx: WorkflowExecutorContext,
  workflow: { id: string; name: string },
  step: NormalizedWorkflowStep,
): Promise<{ ok: boolean; noteId: string | null; reason: string }> {
  const body = (step.payload.note || step.payload.body
    || pickStepMessage(step.payload, ctx.responseLanguage, ctx.inputLanguage || undefined)) as string | null;
  if (!body || !String(body).trim()) return { ok: false, noteId: null, reason: 'empty_note' };
  try {
    const sb = getServiceClient(ctx.config);
    const { data, error } = await sb.from('conversation_notes').insert({
      conversation_id: ctx.conversationId,
      workspace_id: ctx.workspaceId,
      body: String(body),
      author_id: null,
      author_type: 'ai_agent',
      metadata: {
        runtime_source: 'workflow',
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        step_index: step.stepIndex,
      },
    }).select('id').maybeSingle();
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      // If schema doesn't match, downgrade to planned silently.
      if (msg.includes('column') || msg.includes('does not exist') || msg.includes('schema')) {
        return { ok: false, noteId: null, reason: 'internal_note_schema_mismatch' };
      }
      return { ok: false, noteId: null, reason: error.message };
    }
    return { ok: true, noteId: (data as any)?.id || null, reason: 'add_internal_note' };
  } catch (err: any) {
    console.warn('[ai-agent.runtime.workflowExecutor] add_internal_note failed:', err?.message || err);
    return { ok: false, noteId: null, reason: 'add_internal_note_failed' };
  }
}

async function executeAddTag(
  ctx: WorkflowExecutorContext,
  step: NormalizedWorkflowStep,
): Promise<{ ok: boolean; tag: string | null; reason: string }> {
  const tag = String(step.payload.tag || step.payload.value || '').trim();
  if (!tag) return { ok: false, tag: null, reason: 'empty_tag' };
  try {
    const sb = getServiceClient(ctx.config);
    const { data: row } = await sb.from('conversations').select('tags').eq('id', ctx.conversationId).maybeSingle();
    const current: string[] = Array.isArray((row as any)?.tags) ? (row as any).tags : [];
    if (current.includes(tag)) return { ok: true, tag, reason: 'tag_already_present' };
    await sb.from('conversations').update({ tags: [...current, tag] })
      .eq('id', ctx.conversationId).eq('workspace_id', ctx.workspaceId);
    return { ok: true, tag, reason: 'add_tag' };
  } catch (err: any) {
    console.warn('[ai-agent.runtime.workflowExecutor] add_tag failed:', err?.message || err);
    return { ok: false, tag, reason: 'add_tag_failed' };
  }
}

export async function executeMatchedWorkflows(
  ctx: WorkflowExecutorContext,
  matchResult: WorkflowEvaluationResult,
  evalCtx: RuntimeEvaluationContext,
): Promise<WorkflowExecutionResult> {
  const out = emptyResult();
  if (!matchResult || !matchResult.matches?.length) return out;

  // Hard safety: never execute if a human has taken over.
  const stateMeta = (evalCtx.conversationState as any)?._metadata || {};
  const humanTakeover = stateMeta.human_takeover_at || (evalCtx.conversationState as any)?.state === 'human_active';
  if (humanTakeover) {
    console.log('[ai-agent.runtime.workflowExecutor] human takeover — workflows skipped');
    for (const m of matchResult.matches) {
      out.skippedActions.push({
        workflowId: m.workflow.id, workflowName: m.workflow.name,
        stepIndex: -1, actionType: 'workflow', capability: 'skipped',
        reason: 'human_takeover',
      });
    }
    return out;
  }

  const caps = ctx.capabilities || DEFAULT_HOST_CAPABILITIES;

  for (const match of matchResult.matches) {
    const wf = { id: match.workflow.id, name: match.workflow.name };
    let executedAny = false;

    for (const step of match.normalizedSteps) {
      const cls = classifyWorkflowStep(step, caps);
      const base: ExecutedStepRecord = {
        workflowId: wf.id, workflowName: wf.name,
        stepIndex: step.stepIndex, actionType: step.actionType,
        capability: cls.capability, reason: cls.reason,
      };

      if (cls.capability === 'blocked') {
        out.blockedActions.push(base);
        console.log('[ai-agent.runtime.workflowExecutor] blocked', { workflow: wf.id, step: step.stepIndex, action: step.actionType });
        continue;
      }
      if (cls.capability === 'planned' || cls.capability === 'skipped') {
        out.plannedActions.push(base);
        continue;
      }

      // capability === 'executed'
      try {
        if (step.actionType === 'send_message' || step.actionType === 'ask_question') {
          const r = await executeSendMessage(ctx, wf, step, step.actionType === 'ask_question');
          if (r.messageId) out.insertedMessageIds.push(r.messageId);
          base.messageId = r.messageId;
          base.reason = r.reason;
          if (!r.messageId && r.reason === 'empty_message') {
            base.capability = 'skipped';
            out.skippedActions.push(base);
            continue;
          }
          out.executedActions.push(base);
          executedAny = true;
          if (r.stopAi) out.stopAi = true;
        } else if (step.actionType === 'handoff') {
          const r = await executeHandoff(ctx, wf);
          base.messageId = r.messageId;
          base.metadata = { already_done: r.alreadyDone };
          out.executedActions.push(base);
          executedAny = true;
          if (r.messageId) out.insertedMessageIds.push(r.messageId);
          out.handoffExecuted = true;
          out.stopAi = true;
        } else if (step.actionType === 'mark_priority') {
          const r = await executeMarkPriority(ctx, step);
          base.metadata = { priority: r.priority, ok: r.ok };
          out.executedActions.push(base);
          if (r.ok) out.priorityUpdated = true;
          executedAny = true;
          // mark_priority does not stop AI by default.
          if (step.payload.continue_ai === false) out.stopAi = true;
        } else if (step.actionType === 'add_internal_note') {
          const r = await executeInternalNote(ctx, wf, step);
          if (!r.ok) {
            base.capability = 'planned';
            base.reason = r.reason;
            out.plannedActions.push(base);
          } else {
            base.metadata = { note_id: r.noteId };
            out.executedActions.push(base);
            executedAny = true;
          }
        } else if (step.actionType === 'add_tag') {
          const r = await executeAddTag(ctx, step);
          if (!r.ok) {
            base.capability = 'planned';
            base.reason = r.reason;
            out.plannedActions.push(base);
          } else {
            base.metadata = { tag: r.tag, reason: r.reason };
            out.executedActions.push(base);
            executedAny = true;
          }
        } else {
          // Should not happen — classifier returned executed for an action
          // we can't actually execute. Treat as planned defensively.
          base.capability = 'planned';
          base.reason = `no_executor_for:${step.actionType}`;
          out.plannedActions.push(base);
        }
      } catch (err: any) {
        console.warn('[ai-agent.runtime.workflowExecutor] step crashed:', err?.message || err);
        base.capability = 'skipped';
        base.reason = `executor_crash:${err?.message || 'unknown'}`;
        out.skippedActions.push(base);
      }
    }

    if (executedAny) {
      await appendExecutedKey(ctx.config, ctx.conversationId, match.dedupKey).catch(() => {});
      out.executedDedupKeys.push(match.dedupKey);
    }
  }

  return out;
}

export function buildExecutedWorkflowMetadata(result: WorkflowExecutionResult) {
  const map = (a: ExecutedStepRecord) => ({
    workflow_id: a.workflowId,
    workflow_name: a.workflowName,
    step_index: a.stepIndex,
    action_type: a.actionType,
    capability: a.capability,
    reason: a.reason,
    messageId: a.messageId ?? null,
    metadata: a.metadata ?? null,
  });
  return {
    executedActions: result.executedActions.map(map),
    plannedActions: result.plannedActions.map(map),
    blockedActions: result.blockedActions.map(map),
    skippedActions: result.skippedActions.map(map),
    runtimeExecutionEnabled: true,
    safeExecutionOnly: true,
  };
}

/**
 * Pure dry-run — classifies steps and reports what WOULD execute without
 * touching the database, the AI, or the conversation. Safe for Playground.
 */
export function dryRunMatchedWorkflows(
  matchResult: WorkflowEvaluationResult,
  caps: WorkflowHostCapabilities = DEFAULT_HOST_CAPABILITIES,
): {
  wouldExecuteActions: ExecutedStepRecord[];
  plannedActions: ExecutedStepRecord[];
  blockedActions: ExecutedStepRecord[];
  skippedActions: ExecutedStepRecord[];
  stopAiWouldBe: boolean;
} {
  const out = {
    wouldExecuteActions: [] as ExecutedStepRecord[],
    plannedActions: [] as ExecutedStepRecord[],
    blockedActions: [] as ExecutedStepRecord[],
    skippedActions: [] as ExecutedStepRecord[],
    stopAiWouldBe: false,
  };
  if (!matchResult?.matches?.length) return out;
  for (const m of matchResult.matches) {
    for (const step of m.normalizedSteps) {
      const cls = classifyWorkflowStep(step, caps);
      const rec: ExecutedStepRecord = {
        workflowId: m.workflow.id, workflowName: m.workflow.name,
        stepIndex: step.stepIndex, actionType: step.actionType,
        capability: cls.capability, reason: cls.reason,
      };
      if (cls.capability === 'executed') {
        out.wouldExecuteActions.push(rec);
        if (step.actionType === 'handoff') out.stopAiWouldBe = true;
        if (step.actionType === 'ask_question' && step.payload.continue_ai !== true) out.stopAiWouldBe = true;
        if (step.actionType === 'send_message' && step.payload.continue_ai === false) out.stopAiWouldBe = true;
      } else if (cls.capability === 'blocked') out.blockedActions.push(rec);
      else if (cls.capability === 'skipped') out.skippedActions.push(rec);
      else out.plannedActions.push(rec);
    }
  }
  return out;
}