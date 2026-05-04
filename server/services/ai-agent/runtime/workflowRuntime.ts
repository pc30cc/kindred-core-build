/**
 * AI Agent — C2B Workflow planned-only runtime.
 *
 * Matches enabled active workflows by trigger_json.event/type and returns
 * planned RuntimeActions for each step. NEVER executes a workflow step.
 */
import type { WorkflowRecord } from '../runtimeConfig.js';
import type { RuntimeEvaluationContext, RuntimeAction } from './types.js';
import { readRuntimeFlags } from './conversationState.js';

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
    plannedActions: [], skippedActions: [],
  };
  const workflows = ctx.runtimeConfig?.workflows || [];
  if (!workflows.length) return out;

  const flags = readRuntimeFlags((ctx.conversationState as any)?._metadata);
  const plannedKeys = new Set(flags.workflowPlannedIds);

  for (const w of workflows) {
    if (!w.enabled || w.status !== 'active') continue;
    if (!triggerMatchesEvent(w, eventType)) continue;
    if (!workflowConditionsMatch(w, ctx)) continue;

    out.matchedWorkflowIds.push(w.id);
    out.matchedWorkflowNames.push(w.name);
    console.log('[ai-agent.runtime.workflow] matched', { id: w.id, name: w.name, event: eventType });

    const key = dedupKey(w.id, eventType, ctx);
    if (plannedKeys.has(key) || plannedKeys.has(w.id)) {
      const sk: RuntimeAction = {
        type: 'skip', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType, executed: false, skippedReason: 'duplicate_workflow_plan',
      };
      out.actions.push(sk); out.skippedActions.push(sk);
      console.log('[ai-agent.runtime.workflow] skipped', { id: w.id, reason: 'duplicate_workflow_plan' });
      continue;
    }

    const steps = Array.isArray(w.steps_json) ? (w.steps_json as any[])
      : Array.isArray((w.steps_json as any)?.steps) ? ((w.steps_json as any).steps as any[])
      : [];

    if (!steps.length) {
      const a: RuntimeAction = {
        type: 'workflow_planned', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType, payload: { step_index: -1, step_type: 'noop', dedup_key: key },
        executed: false, skippedReason: 'workflow_runtime_disabled',
      };
      out.actions.push(a); out.plannedActions.push(a);
      continue;
    }

    steps.forEach((step: any, i: number) => {
      const a: RuntimeAction = {
        type: 'workflow_planned', source: 'workflow', sourceId: w.id, sourceName: w.name,
        reason: eventType,
        payload: {
          step_index: i,
          step_type: step?.type || step?.action || 'unknown',
          step_summary: step?.label || step?.name || null,
          dedup_key: key,
        },
        executed: false, skippedReason: 'workflow_runtime_disabled',
      };
      out.actions.push(a); out.plannedActions.push(a);
      console.log('[ai-agent.runtime.workflow] planned', { id: w.id, step: i, type: a.payload?.step_type });
    });
  }

  return out;
}

export function buildWorkflowMetadata(result: WorkflowEvaluationResult) {
  return {
    matchedWorkflowIds: result.matchedWorkflowIds,
    matchedWorkflowNames: result.matchedWorkflowNames,
    plannedActions: result.plannedActions.map((a) => ({
      workflow_id: a.sourceId, workflow_name: a.sourceName,
      step_index: (a.payload as any)?.step_index ?? null,
      step_type: (a.payload as any)?.step_type ?? null,
      reason: a.skippedReason || a.reason || null,
    })),
    skippedActions: result.skippedActions.map((a) => ({
      workflow_id: a.sourceId, workflow_name: a.sourceName,
      reason: a.skippedReason || a.reason || null,
    })),
    runtimeExecutionEnabled: false,
  };
}