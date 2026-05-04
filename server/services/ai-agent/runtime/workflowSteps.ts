/**
 * AI Agent — Pass D: Normalize workflow steps from heterogeneous builder shapes
 * into a single normalized form the executor can reason about.
 *
 * Never throws. Unknown shapes resolve to actionType="unknown".
 */

export interface NormalizedWorkflowStep {
  stepIndex: number;
  raw: any;
  type: string;            // outer wrapper type (action / send_message / assign / ...)
  actionType: string;      // canonical action: send_message | ask_question | handoff | mark_priority | ...
  payload: Record<string, any>;
  label: string | null;
}

function pickPayload(step: any): Record<string, any> {
  if (!step || typeof step !== 'object') return {};
  // Common nesting locations
  if (step.action && typeof step.action === 'object' && step.action.payload && typeof step.action.payload === 'object') {
    return { ...step.action.payload };
  }
  if (step.action_json && typeof step.action_json === 'object') return { ...step.action_json };
  if (step.payload && typeof step.payload === 'object') return { ...step.payload };
  return {};
}

function canonicalAction(input: string | undefined | null): string {
  const v = String(input || '').toLowerCase().trim();
  if (!v) return 'unknown';
  // Map known synonyms
  if (v === 'send_message' || v === 'message' || v === 'reply') return 'send_message';
  if (v === 'ask_question' || v === 'question' || v === 'ask') return 'ask_question';
  if (v === 'handoff' || v === 'handoff_to_operator' || v === 'human_handoff') return 'handoff';
  if (v === 'mark_priority' || v === 'set_priority' || v === 'priority') return 'mark_priority';
  if (v === 'add_internal_note' || v === 'internal_note' || v === 'note') return 'add_internal_note';
  if (v === 'add_tag' || v === 'tag') return 'add_tag';
  if (v === 'assign_team' || v === 'assign-team') return 'assign_team';
  if (v === 'assign_operator' || v === 'assign-operator') return 'assign_operator';
  if (v === 'assign') return 'assign'; // generic — resolved using payload below
  if (v === 'internal_tool' || v === 'tool' || v === 'tool_call') return 'internal_tool';
  if (v === 'webhook' || v === 'http' || v === 'http_request' || v === 'external_api') return v === 'http_request' ? 'http_request' : v === 'external_api' ? 'external_api' : 'webhook';
  if (v === 'mcp' || v === 'mcp_call') return 'mcp';
  if (v === 'crm_action' || v === 'crm') return 'crm_action';
  if (v === 'create_ticket' || v === 'ticket') return 'create_ticket';
  if (v === 'wait' || v === 'delay') return 'wait';
  if (v === 'condition' || v === 'condition_branch' || v === 'branch' || v === 'if') return 'condition_branch';
  if (v === 'start_workflow' || v === 'run_workflow') return 'start_workflow';
  if (v === 'sql' || v === 'shell' || v === 'arbitrary_code' || v === 'code') return v;
  if (v === 'payment' || v === 'refund' || v === 'billing_action') return v;
  if (v === 'export_data' || v === 'delete_data' || v === 'create_api_key' || v === 'change_plan') return v;
  return v;
}

/**
 * Resolve the canonical action type from a raw step.
 */
function resolveActionType(step: any): { type: string; actionType: string } {
  if (!step || typeof step !== 'object') return { type: 'unknown', actionType: 'unknown' };

  // Shape 1: { type: "action", action: { type: "handoff", payload } }
  if (step.type === 'action' && step.action && typeof step.action === 'object') {
    return { type: 'action', actionType: canonicalAction(step.action.type || step.action.action) };
  }

  // Shape 3: { action_type, action_json }
  if (step.action_type) {
    return { type: String(step.type || 'action'), actionType: canonicalAction(step.action_type) };
  }

  // Shape 5: { type: "assign", team_id?, operator_id? } — resolve sub-action
  if (step.type === 'assign') {
    const payload = pickPayload(step);
    const teamId = step.team_id || payload.team_id;
    const operatorId = step.operator_id || payload.operator_id;
    if (operatorId) return { type: 'assign', actionType: 'assign_operator' };
    if (teamId) return { type: 'assign', actionType: 'assign_team' };
    return { type: 'assign', actionType: 'assign' };
  }

  // Shape 6: { type: "internal_tool", tool: "..." }
  if (step.type === 'internal_tool') {
    const tool = canonicalAction(step.tool || step.name);
    // Map well-known internal tools to first-class actions
    if (tool === 'handoff' || tool === 'handoff_to_operator') return { type: 'internal_tool', actionType: 'handoff' };
    if (tool === 'mark_priority') return { type: 'internal_tool', actionType: 'mark_priority' };
    return { type: 'internal_tool', actionType: 'internal_tool' };
  }

  // Shape 2 + general: outer type IS the action (send_message, ask_question, handoff, ...)
  if (step.type) {
    return { type: String(step.type), actionType: canonicalAction(step.type) };
  }

  // Last resort: action field as string
  if (typeof step.action === 'string') {
    return { type: 'action', actionType: canonicalAction(step.action) };
  }

  return { type: 'unknown', actionType: 'unknown' };
}

function buildPayload(step: any, actionType: string): Record<string, any> {
  const base = pickPayload(step);

  // Hoist common per-shape fields into the payload.
  if (typeof step?.message === 'string') base.message = base.message ?? step.message;
  if (typeof step?.question === 'string') base.message = base.message ?? step.question;
  if (step?.translations && typeof step.translations === 'object') {
    base.translations = { ...(base.translations || {}), ...step.translations };
  }
  if (typeof step?.continue_ai === 'boolean' && base.continue_ai === undefined) {
    base.continue_ai = step.continue_ai;
  }
  if (typeof step?.priority === 'string' && base.priority === undefined) base.priority = step.priority;
  if (typeof step?.team_id === 'string' && base.team_id === undefined) base.team_id = step.team_id;
  if (typeof step?.operator_id === 'string' && base.operator_id === undefined) base.operator_id = step.operator_id;
  if (typeof step?.tag === 'string' && base.tag === undefined) base.tag = step.tag;
  if (typeof step?.note === 'string' && base.note === undefined) base.note = step.note;
  if (typeof step?.body === 'string' && base.body === undefined) base.body = step.body;
  if (typeof step?.url === 'string' && base.url === undefined) base.url = step.url;
  if (typeof step?.tool === 'string' && base.tool === undefined) base.tool = step.tool;

  // Sensible defaults per action.
  if (actionType === 'ask_question' && base.continue_ai === undefined) base.continue_ai = false;
  if (actionType === 'send_message' && base.continue_ai === undefined) base.continue_ai = true;

  return base;
}

export function normalizeWorkflowSteps(stepsJson: unknown): NormalizedWorkflowStep[] {
  let steps: any[] = [];
  if (Array.isArray(stepsJson)) steps = stepsJson;
  else if (stepsJson && typeof stepsJson === 'object' && Array.isArray((stepsJson as any).steps)) {
    steps = (stepsJson as any).steps;
  }
  if (!Array.isArray(steps)) steps = [];

  return steps.map((raw, i) => {
    try {
      const { type, actionType } = resolveActionType(raw);
      const payload = buildPayload(raw, actionType);
      const label = (raw && (raw.label || raw.name || raw.title)) || null;
      return { stepIndex: i, raw, type, actionType, payload, label: label ? String(label) : null };
    } catch {
      return { stepIndex: i, raw, type: 'unknown', actionType: 'unknown', payload: {}, label: null };
    }
  });
}

export function pickStepMessage(
  payload: Record<string, any>,
  responseLanguage: string | undefined,
  inputLanguage?: string | undefined,
): string | null {
  const t = (payload?.translations || {}) as Record<string, string>;
  const cands = [responseLanguage, inputLanguage, 'en'].filter(Boolean) as string[];
  for (const c of cands) {
    const k = c.toLowerCase();
    if (typeof t[k] === 'string' && t[k].trim()) return t[k];
    const short = k.split('-')[0];
    if (short !== k && typeof t[short] === 'string' && t[short].trim()) return t[short];
  }
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  if (typeof payload?.body === 'string' && payload.body.trim()) return payload.body;
  if (typeof payload?.template === 'string' && payload.template.trim()) return payload.template;
  const first = Object.values(t).find((v) => typeof v === 'string' && v.trim());
  return first || null;
}