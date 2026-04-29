/**
 * AI Agent — workflow validation (Pass B1).
 *
 * Self-host. No external execution. Pure validator + dry-run preview.
 * Runtime execution lands in a later pass; this only validates structure
 * and reports what *would* trigger / *would* run.
 */

export const ALLOWED_TRIGGERS = [
  'conversation_started',
  'after_prechat',
  'visitor_first_message',
  'topic_detected',
  'ai_no_answer',
  'human_requested',
  'no_operator_online',
  'business_hours_closed',
] as const;

export const ALLOWED_CONDITION_TYPES = [
  'topic_equals',
  'language_equals',
  'page_url_contains',
  'visitor_email_exists',
  'ai_confidence_below',
  'business_hours_status',
  'plan_feature_available',
] as const;

export const ALLOWED_ACTION_TYPES = [
  'send_ai_message',
  'ask_visitor_question',
  'handoff',
  'assign_main_inbox',
  'assign_team',
  'add_internal_note',
  'mark_priority',
  'add_tag',
  'create_ticket',
] as const;

export type WorkflowDraft = {
  name?: string;
  trigger_json?: Record<string, any>;
  steps_json?: Array<Record<string, any>>;
  description?: string;
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWorkflow(draft: WorkflowDraft): ValidationResult {
  const errors: string[] = [];

  if (!draft || typeof draft !== 'object') {
    return { valid: false, errors: ['Workflow draft is required.'] };
  }
  if (!draft.name || typeof draft.name !== 'string' || draft.name.trim().length === 0) {
    errors.push('Workflow name is required.');
  }

  const trig = draft.trigger_json || {};
  const trigType = String((trig as any).type || '');
  if (!trigType) errors.push('Workflow must have a trigger.');
  else if (!(ALLOWED_TRIGGERS as readonly string[]).includes(trigType)) {
    errors.push(`Trigger "${trigType}" is not supported.`);
  }
  if (trigType === 'topic_detected' && !(trig as any).topic_slug) {
    errors.push('Trigger "topic_detected" requires a topic_slug.');
  }

  const steps = Array.isArray(draft.steps_json) ? draft.steps_json : [];
  if (steps.length === 0) errors.push('Workflow must have at least one step.');

  steps.forEach((step, idx) => {
    if (!step || typeof step !== 'object') {
      errors.push(`Step ${idx + 1} is invalid.`);
      return;
    }
    if (step.type === 'condition') {
      const c = step.condition || {};
      if (!c.type) errors.push(`Step ${idx + 1}: condition is missing type.`);
      else if (!(ALLOWED_CONDITION_TYPES as readonly string[]).includes(c.type)) {
        errors.push(`Step ${idx + 1}: unsupported condition "${c.type}".`);
      }
    } else if (step.type === 'action') {
      const a = step.action || {};
      if (!a.type) errors.push(`Step ${idx + 1}: action is missing type.`);
      else if (!(ALLOWED_ACTION_TYPES as readonly string[]).includes(a.type)) {
        errors.push(`Step ${idx + 1}: unsupported action "${a.type}". External tools and code execution are not allowed.`);
      }
      if (a.type === 'send_ai_message' && !a.template && !a.message) {
        errors.push(`Step ${idx + 1}: "send_ai_message" requires a template or message.`);
      }
      if (a.type === 'assign_team' && !a.team_id) {
        errors.push(`Step ${idx + 1}: "assign_team" requires team_id.`);
      }
    } else {
      errors.push(`Step ${idx + 1}: unknown step type "${step.type}".`);
    }
  });

  return { valid: errors.length === 0, errors };
}

export interface PreviewInput {
  workflowDraft: WorkflowDraft;
  sampleMessage?: string;
  sampleContext?: {
    detectedTopicSlug?: string;
    language?: string;
    pageUrl?: string;
    visitorEmail?: string | null;
    aiConfidence?: number;
    businessHoursOpen?: boolean;
  };
}

export interface PreviewResult {
  valid: boolean;
  errors: string[];
  wouldTrigger: boolean;
  matchedConditions: string[];
  plannedActions: Array<{ type: string; details: Record<string, unknown> }>;
}

function evalCondition(c: any, ctx: NonNullable<PreviewInput['sampleContext']>): boolean {
  switch (c?.type) {
    case 'topic_equals': return !!c.value && ctx.detectedTopicSlug === c.value;
    case 'language_equals': return !!c.value && ctx.language === c.value;
    case 'page_url_contains': return !!c.value && (ctx.pageUrl || '').includes(c.value);
    case 'visitor_email_exists': return !!ctx.visitorEmail;
    case 'ai_confidence_below':
      return typeof c.value === 'number' && (ctx.aiConfidence ?? 1) < c.value;
    case 'business_hours_status':
      return c.value === 'open' ? !!ctx.businessHoursOpen : !ctx.businessHoursOpen;
    case 'plan_feature_available': return true; // always allow in preview
    default: return false;
  }
}

export function previewWorkflow(input: PreviewInput): PreviewResult {
  const v = validateWorkflow(input.workflowDraft);
  const ctx = input.sampleContext || {};
  const trig = input.workflowDraft?.trigger_json || ({} as any);
  const trigType = String(trig.type || '');

  let wouldTrigger = false;
  if (trigType === 'topic_detected') {
    wouldTrigger = !!ctx.detectedTopicSlug && ctx.detectedTopicSlug === trig.topic_slug;
  } else if (trigType === 'visitor_first_message' || trigType === 'conversation_started' || trigType === 'after_prechat') {
    wouldTrigger = !!input.sampleMessage;
  } else {
    wouldTrigger = !!trigType; // optimistic for runtime-only triggers
  }

  const matchedConditions: string[] = [];
  const plannedActions: PreviewResult['plannedActions'] = [];
  const steps = Array.isArray(input.workflowDraft?.steps_json) ? input.workflowDraft!.steps_json! : [];
  for (const step of steps) {
    if (step?.type === 'condition') {
      if (evalCondition(step.condition, ctx)) {
        matchedConditions.push(String(step.condition?.type));
      }
    } else if (step?.type === 'action') {
      plannedActions.push({ type: String(step.action?.type || ''), details: step.action || {} });
    }
  }

  return {
    valid: v.valid,
    errors: v.errors,
    wouldTrigger: wouldTrigger && v.valid,
    matchedConditions,
    plannedActions,
  };
}