/**
 * AI Agent — C2B Internal Tool runtime (safe).
 *
 * Only `internal` tools are returned by runtimeConfig. This evaluator decides
 * which of the requested tools are allowed to run in C2B and produces
 * RuntimeActions with executed=true for safe ones (handoff_to_operator,
 * mark_priority, search_kb mark-as-used). All MCP/webhook/CRM/external HTTP
 * are NEVER executed here.
 */
import type { RuntimeEvaluationContext, RuntimeAction } from './types.js';
import { readRuntimeFlags } from './conversationState.js';

/** Tool names that may execute side-effects in C2B. */
const EXECUTABLE_INTERNAL_TOOLS = new Set([
  'handoff_to_operator',
  'mark_priority',
  'search_kb',
]);

/** Read-only / planned-only internal tools. */
const PLANNED_INTERNAL_TOOLS = new Set([
  'get_business_hours',
  'get_pricing_info',
  'create_ticket',
  'add_internal_note',
  'assign_team',
]);

export interface ToolRequest {
  name: string;
  payload?: Record<string, unknown>;
  source?: 'routing_rule' | 'message_trigger' | 'workflow' | 'runtime_policy';
  sourceId?: string | null;
}

export interface ToolEvaluationResult {
  actions: RuntimeAction[];
  allowedTools: string[];
  usedTools: string[];
  plannedTools: string[];
  skippedTools: string[];
}

export function evaluateInternalTools(
  ctx: RuntimeEvaluationContext,
  requested: ToolRequest[],
): ToolEvaluationResult {
  const out: ToolEvaluationResult = {
    actions: [], allowedTools: [], usedTools: [], plannedTools: [], skippedTools: [],
  };
  const enabledNames = new Set((ctx.runtimeConfig?.internalTools || []).map((t) => t.name));
  out.allowedTools = Array.from(enabledNames);
  if (!requested.length) return out;

  const flags = readRuntimeFlags((ctx.conversationState as any)?._metadata);

  for (const req of requested) {
    const name = req.name;
    const source = req.source || 'runtime_policy';
    const sourceId = req.sourceId || null;

    if (!enabledNames.has(name)) {
      const sk: RuntimeAction = {
        type: 'skip', source: 'internal_tool', sourceId, sourceName: name,
        reason: 'tool_not_enabled', executed: false, skippedReason: 'tool_not_enabled',
      };
      out.actions.push(sk); out.skippedTools.push(name);
      console.log('[ai-agent.runtime.tools] skipped', { name, reason: 'tool_not_enabled' });
      continue;
    }

    if (EXECUTABLE_INTERNAL_TOOLS.has(name)) {
      // Special-case dedup for handoff
      if (name === 'handoff_to_operator' && flags.handoffSent) {
        const sk: RuntimeAction = {
          type: 'skip', source: 'internal_tool', sourceId, sourceName: name,
          reason: 'duplicate_handoff', executed: false, skippedReason: 'handoff_already_sent',
        };
        out.actions.push(sk); out.skippedTools.push(name);
        continue;
      }
      const a: RuntimeAction = {
        type: 'tool_executed', source: 'internal_tool', sourceId, sourceName: name,
        reason: source, payload: { name, ...(req.payload || {}) }, executed: true,
      };
      out.actions.push(a); out.usedTools.push(name);
      console.log('[ai-agent.runtime.tools] executed', { name, source });
      continue;
    }

    if (PLANNED_INTERNAL_TOOLS.has(name)) {
      const a: RuntimeAction = {
        type: 'tool_planned', source: 'internal_tool', sourceId, sourceName: name,
        reason: source, payload: { name, ...(req.payload || {}) },
        executed: false, skippedReason: 'planned_only',
      };
      out.actions.push(a); out.plannedTools.push(name);
      console.log('[ai-agent.runtime.tools] planned', { name, source });
      continue;
    }

    // Unknown internal tool — never execute.
    const sk: RuntimeAction = {
      type: 'skip', source: 'internal_tool', sourceId, sourceName: name,
      reason: source, executed: false, skippedReason: 'unknown_internal_tool',
    };
    out.actions.push(sk); out.skippedTools.push(name);
    console.log('[ai-agent.runtime.tools] skipped', { name, reason: 'unknown_internal_tool' });
  }

  return out;
}

export function buildToolMetadata(result: ToolEvaluationResult) {
  return {
    allowedTools: result.allowedTools,
    usedTools: result.usedTools,
    plannedTools: result.plannedTools,
    skippedTools: result.skippedTools,
  };
}