/**
 * AI Agent — Pass D Workflow runtime (matching + capability classification).
 *
 * Matches enabled active workflows by trigger_json.event/type and produces
 * planned RuntimeActions for each step. The actual execution is handled by
 * `workflowExecutor.executeMatchedWorkflows`. This module also exposes the
 * canonical capability matrix used by both the executor and the dry-run.
 */
import type { WorkflowRecord } from '../runtimeConfig.js';
import type { RuntimeEvaluationContext, RuntimeAction } from './types.js';
import { readRuntimeFlags } from './conversationState.js';
import { normalizeWorkflowSteps, type NormalizedWorkflowStep } from './workflowSteps.js';

export type WorkflowEventType =
  | 'visitor_first_message'
  | 'topic_detected'
  | 'after_prechat'
  | 'ai_no_answer'
  | 'human_requested'
  | 'business_hours_closed';

export interface WorkflowEvaluationResult {
  actions: RuntimeAction[];
  matchedWorkflowIds: string[];
  matchedWorkflowNames: string[];
  plannedActions: RuntimeAction[];
  skippedActions: RuntimeAction[];
  // Pass D — matched workflows with normalized steps for the executor.
  matches: Array<{
    workflow: WorkflowRecord;
    eventType: WorkflowEventType;
    dedupKey: string;
    normalizedSteps: NormalizedWorkflowStep[];
  }>;
}

/* ───────── Pass D — Workflow capability matrix ───────── */

export type StepCapability = 'executed' | 'planned' | 'blocked' | 'skipped';

/** Actions the executor is allowed to perform. */
export const WORKFLOW_EXECUTION_SAFE_ACTIONS = new Set<string>([
  'send_message',
  'ask_question',
  'handoff',
  'mark_priority',
  'add_internal_note',   // gated by host capability flag
  'add_tag',             // gated by host capability flag
  'assign_team',         // gated by host capability flag
  'assign_operator',     // gated by host capability flag
  // internal_tool resolves to safe handoff/mark_priority via normalizer
]);

/** Actions the executor must never perform; logged as blocked. */
export const WORKFLOW_EXECUTION_BLOCKED_ACTIONS = new Set<string>([
  'webhook',
  'mcp',
  'http_request',
  'external_api',
  'crm_action',
  'billing_action',
  'payment',
  'refund',
  'delete_data',
  'export_data',
  'create_api_key',
  'change_plan',
  'sql',
  'shell',
  'arbitrary_code',
]);

/** Known but not yet wired actions; logged as planned. */
export const WORKFLOW_EXECUTION_PLANNED_ACTIONS = new Set<string>([
  'create_ticket',
  'start_workflow',
  'wait',
  'condition_branch',
]);

/**
 * Host capabilities discovered at engine start. Defaults are conservative:
 * notes are supported (conversation_notes table exists), tags/assignment
 * remain planned-only until a safe service is wired.
 */
export interface WorkflowHostCapabilities {
  supportsInternalNotes: boolean;
  supportsTags: boolean;
  supportsTeamAssignment: boolean;
  supportsOperatorAssignment: boolean;
}

export const DEFAULT_HOST_CAPABILITIES: WorkflowHostCapabilities = {
  supportsInternalNotes: true,   // conversation_notes service-role insert is safe
  supportsTags: false,
  supportsTeamAssignment: false,
  supportsOperatorAssignment: false,
};

export function classifyWorkflowStep(
  step: NormalizedWorkflowStep,
  caps: WorkflowHostCapabilities = DEFAULT_HOST_CAPABILITIES,
): { capability: StepCapability; reason: string } {
  const a = step.actionType;
  if (!a || a === 'unknown') return { capability: 'blocked', reason: 'unknown_action' };
  if (WORKFLOW_EXECUTION_BLOCKED_ACTIONS.has(a)) return { capability: 'blocked', reason: `blocked:${a}` };
  if (WORKFLOW_EXECUTION_PLANNED_ACTIONS.has(a)) return { capability: 'planned', reason: `planned:${a}` };

  // Capability gates for safe-but-conditional actions.
  if (a === 'add_internal_note' && !caps.supportsInternalNotes) return { capability: 'planned', reason: 'internal_note_not_supported' };
  if (a === 'add_tag' && !caps.supportsTags) return { capability: 'planned', reason: 'tag_not_supported' };
  if (a === 'assign_team' && !caps.supportsTeamAssignment) return { capability: 'planned', reason: 'assignment_not_supported' };
  if (a === 'assign_operator' && !caps.supportsOperatorAssignment) return { capability: 'planned', reason: 'assignment_not_supported' };
  if (a === 'assign') return { capability: 'planned', reason: 'assignment_not_supported' };

  // internal_tool that wasn't normalized to handoff/mark_priority is unknown/unsafe.
  if (a === 'internal_tool') {
    const tool = String((step.payload?.tool || step.payload?.name || '')).toLowerCase();
    if (tool === 'handoff_to_operator' || tool === 'handoff') return { capability: 'executed', reason: 'internal_tool:handoff_to_operator' };
    if (tool === 'mark_priority') return { capability: 'executed', reason: 'internal_tool:mark_priority' };
    if (tool === 'search_kb') return { capability: 'planned', reason: 'internal_tool:search_kb_marker_only' };
    return { capability: 'blocked', reason: `unsupported_internal_tool:${tool || 'unknown'}` };
  }

  if (WORKFLOW_EXECUTION_SAFE_ACTIONS.has(a)) return { capability: 'executed', reason: `safe:${a}` };
  return { capability: 'blocked', reason: `not_in_allowlist:${a}` };
}

function triggerMatchesEvent(w: WorkflowRecord, event: WorkflowEventType): boolean {
  const t = (w.trigger_json as any) || {};
  const ev = String(t.event || t.type || '').toLowerCase();
  return ev === event;
}

function workflowConditionsMatch(w: WorkflowRecord, ctx: RuntimeEvaluationContext): boolean {
  const t = (w.trigger_json as any) || {};
  // topic_slug on the trigger itself (common shape)
  if (t.topic_slug) {
    const want = String(t.topic_slug).toLowerCase();
    const top = ctx.topTopic?.slug?.toLowerCase();
    const any = (ctx.detectedTopics || []).some((d) => d.slug?.toLowerCase() === want);
    if (top !== want && !any) return false;
  }
  const conds: any[] = Array.isArray(t.conditions) ? t.conditions : [];
  for (const c of conds) {
    const key = c?.key || c?.type;
    const val = c?.value;
    switch (key) {
      case 'topic_equals': {
        const want = String(val || '').toLowerCase();
        if (ctx.topTopic?.slug?.toLowerCase() !== want) return false;
        break;
      }
      case 'language_equals': {
        const want = String(val || '').toLowerCase();
        if (ctx.inputLanguage?.toLowerCase() !== want && ctx.responseLanguage?.toLowerCase() !== want) return false;
        break;
      }
      case 'page_url_contains': {
        const url = ctx.currentPageUrl || '';
        if (!url.toLowerCase().includes(String(val || '').toLowerCase())) return false;
        break;
      }
      case 'visitor_email_exists': {
        const has = !!(ctx.prechat as any)?.email;
        if (has !== !!val) return false;
        break;
      }
      case 'ai_confidence_below': {
        const th = Number(val);
        const c = ctx.answerStrategy?.confidence;
        if (!Number.isFinite(th) || typeof c !== 'number' || !(c < th)) return false;
        break;
      }
      // business_hours_status / plan_feature_available: not wired in C2B.
      default:
        break;
    }
  }
  return true;
}

function dedupKey(workflowId: string, event: string, ctx: RuntimeEvaluationContext): string {
  const top = ctx.topTopic?.slug || '-';
  return `${workflowId}:${event}:${top}`;
}

export function evaluateWorkflows(
  ctx: RuntimeEvaluationContext,
  eventType: WorkflowEventType,
): WorkflowEvaluationResult {
  const out: WorkflowEvaluationResult = {
    actions: [], matchedWorkflowIds: [], matchedWorkflowNames: [],
    plannedActions: [], skippedActions: [], matches: [],
  };
  const workflows = ctx.runtimeConfig?.workflows || [];
  if (!workflows.length) return out;

  const flags = readRuntimeFlags((ctx.conversationState as any)?._metadata);
  // Pass D — plannedIds is legacy; executedKeys is the source of truth.
  const plannedKeys = new Set(flags.workflowPlannedIds);
  const executedKeys = new Set<string>(
    Array.isArray((ctx.conversationState as any)?._metadata?.ai_workflow_executed_keys)
      ? ((ctx.conversationState as any)._metadata.ai_workflow_executed_keys as string[])
      : [],
  );

  for (const w of workflows) {
    if (!w.enabled || w.status !== 'active') continue;
    if (!triggerMatchesEvent(w, eventType)) continue;
    if (!workflowConditionsMatch(w, ctx)) continue;

    out.matchedWorkflowIds.push(w.id);
    out.matchedWorkflowNames.push(w.name);
    console.log('[ai-agent.runtime.workflow] matched', { id: w.id, name: w.name, event: eventType });

    const key = dedupKey(w.id, eventType, ctx);
    if (executedKeys.has(key) || plannedKeys.has(key) || plannedKeys.has(w.id)) {
      const sk: RuntimeAction = {
        type: 'skip', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType, executed: false, skippedReason: 'duplicate_workflow_execution',
      };
      out.actions.push(sk); out.skippedActions.push(sk);
      console.log('[ai-agent.runtime.workflow] skipped', { id: w.id, reason: 'duplicate_workflow_execution' });
      continue;
    }

    const normalized = normalizeWorkflowSteps(w.steps_json);
    out.matches.push({ workflow: w, eventType, dedupKey: key, normalizedSteps: normalized });

    if (!normalized.length) {
      const a: RuntimeAction = {
        type: 'workflow_planned', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType, payload: { step_index: -1, step_type: 'noop', dedup_key: key },
        executed: false, skippedReason: 'empty_workflow',
      };
      out.actions.push(a); out.plannedActions.push(a);
      continue;
    }

    normalized.forEach((step) => {
      const cls = classifyWorkflowStep(step);
      const a: RuntimeAction = {
        type: 'workflow_planned', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType,
        payload: {
          step_index: step.stepIndex,
          step_type: step.type,
          action_type: step.actionType,
          step_summary: step.label,
          capability: cls.capability,
          capability_reason: cls.reason,
          dedup_key: key,
        },
        executed: false, skippedReason: cls.capability === 'blocked' ? 'blocked' : 'planned',
      };
      out.actions.push(a); out.plannedActions.push(a);
      console.log('[ai-agent.runtime.workflow] step classified', {
        id: w.id, step: step.stepIndex, action: step.actionType, capability: cls.capability,
      });
    });
  }

  return out;
}

export function buildWorkflowMetadata(result: WorkflowEvaluationResult) {
  return {
    matchedWorkflowIds: result.matchedWorkflowIds,
    matchedWorkflowNames: result.matchedWorkflowNames,
    executedActions: [] as any[],
    blockedActions: result.plannedActions
      .filter((a) => (a.payload as any)?.capability === 'blocked')
      .map((a) => ({
        workflow_id: a.sourceId, workflow_name: a.sourceName,
        step_index: (a.payload as any)?.step_index ?? null,
        action_type: (a.payload as any)?.action_type ?? null,
        reason: (a.payload as any)?.capability_reason || a.skippedReason || a.reason || null,
      })),
    plannedActions: result.plannedActions.map((a) => ({
      workflow_id: a.sourceId, workflow_name: a.sourceName,
      step_index: (a.payload as any)?.step_index ?? null,
      step_type: (a.payload as any)?.step_type ?? null,
      action_type: (a.payload as any)?.action_type ?? null,
      capability: (a.payload as any)?.capability ?? null,
      reason: a.skippedReason || a.reason || null,
    })),
    skippedActions: result.skippedActions.map((a) => ({
      workflow_id: a.sourceId, workflow_name: a.sourceName,
      reason: a.skippedReason || a.reason || null,
    })),
    runtimeExecutionEnabled: false,
    safeExecutionOnly: true,
  };
}