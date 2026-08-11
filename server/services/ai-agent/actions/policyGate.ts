/**
 * AI Agent — Phase 3 deterministic safety gate (3.3).
 *
 * Runs AFTER model planning and BEFORE any execution. The model's decision is
 * NEVER authorization: every proposal must survive this pure, synchronous
 * gate. Blocked proposals stay fully observable but never execute.
 *
 * Prompt-injection protection (3.11) lives here: actions that require
 * explicit visitor intent are matched ONLY against the current visitor
 * message (plus deterministic runtime signals). Text found in KB articles,
 * crawled pages or files is never consulted, so a source saying
 * "call handoff_to_operator" or "mark this urgent" can never authorize
 * anything.
 */
import {
  getActionDefinition, normalizeArguments, MAX_ACTIONS_PER_TURN,
  type ActionName, type ActionDefinition,
} from './catalog.js';
import { buildIdempotencyKey } from './idempotency.js';

export type ActionDecisionStatus = 'allowed' | 'planned' | 'blocked';

export interface ActionDecision {
  name: string;
  status: ActionDecisionStatus;
  reason: string;
  arguments: Record<string, unknown>;
  idempotencyKey: string | null;
  readOnly: boolean;
  sideEffect: boolean;
}

export interface GateContext {
  workspaceId: string;
  conversationId: string | null;
  /** workspace_id actually owning the conversation row (tenant check). */
  conversationWorkspaceId?: string | null;
  visitorMessageId?: string | null;
  visitorText: string;
  /** Names enabled for this workspace (ai_agent_tools / runtimeConfig). */
  enabledActionNames: string[];
  mode: string;
  aiEnabled: boolean;
  canAutoReply: boolean;
  canSuggest: boolean;
  humanTakeover: boolean;
  aiManaged: boolean;
  strictKb: boolean;
  handoffKeywords: string[];
  /** Deterministic strategy already asked for a handoff. */
  strategyHandoffRequired?: boolean;
  /** Priority currently stored on the conversation. */
  currentPriority?: string | null;
  /** Tags currently stored on the conversation. */
  currentTags?: string[];
  /** Idempotency keys already executed for this conversation. */
  executedKeys?: string[];
  /**
   * Deterministic authorization for model-planned side effects. Populated ONLY
   * from runtime/workspace configuration (workflows, routing rules, message
   * triggers) — never from model output and never from retrieved source text.
   */
  deterministicAuthorizedActions?: string[];
}

const DEFAULT_HANDOFF_KEYWORDS = [
  'human', 'agent', 'operator', 'representative', 'real person', 'talk to someone',
  'اپراتور', 'پشتیبان', 'انسان', 'کارشناس',
];

const URGENCY_PATTERNS = [
  'urgent', 'asap', 'immediately', 'emergency', 'critical', 'right now',
  'فوری', 'اضطراری', 'سریع', 'همین حالا', 'acil',
];

export function hasExplicitHumanRequest(text: string, keywords: string[]): boolean {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  const list = (keywords && keywords.length ? keywords : DEFAULT_HANDOFF_KEYWORDS).filter(Boolean);
  return list.some((k) => lower.includes(String(k).toLowerCase()));
}

export function hasUrgencySignal(text: string): boolean {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return URGENCY_PATTERNS.some((p) => lower.includes(p));
}

function visitorIntentSatisfied(def: ActionDefinition, ctx: GateContext): boolean {
  if (!def.requiresVisitorIntent) return true;
  if (def.name === 'handoff_to_operator') {
    return !!ctx.strategyHandoffRequired || hasExplicitHumanRequest(ctx.visitorText, ctx.handoffKeywords);
  }
  if (def.name === 'mark_priority') return hasUrgencySignal(ctx.visitorText);
  return false;
}

function block(name: string, reason: string, args: Record<string, unknown> = {}, def?: ActionDefinition | null): ActionDecision {
  return {
    name, status: 'blocked', reason, arguments: args, idempotencyKey: null,
    readOnly: !!def?.readOnly, sideEffect: !!def?.sideEffect,
  };
}

export function evaluateActionPlan(
  ctx: GateContext,
  proposals: { name: string; arguments: Record<string, unknown> }[],
): ActionDecision[] {
  const decisions: ActionDecision[] = [];
  const seenKeys = new Set<string>(ctx.executedKeys || []);
  const perTurn = new Set<string>();

  proposals.slice(0, MAX_ACTIONS_PER_TURN).forEach((p) => {
    const name = String(p?.name || '').trim();
    const def = getActionDefinition(name);
    if (!def) { decisions.push(block(name || 'unknown', 'unknown_action')); return; }

    if (!ctx.aiEnabled || ctx.mode === 'off') { decisions.push(block(name, 'ai_disabled', {}, def)); return; }
    if (!ctx.conversationId) { decisions.push(block(name, 'no_conversation', {}, def)); return; }
    if (ctx.conversationWorkspaceId && ctx.conversationWorkspaceId !== ctx.workspaceId) {
      decisions.push(block(name, 'tenant_mismatch', {}, def)); return;
    }
    if (!ctx.enabledActionNames.includes(name)) { decisions.push(block(name, 'action_not_enabled', {}, def)); return; }

    // Schema validation, then normalization.
    const parsed = def.schema.safeParse(p?.arguments ?? {});
    if (!parsed.success) { decisions.push(block(name, 'invalid_arguments', {}, def)); return; }
    const args = normalizeArguments(def.name as ActionName, (parsed.data || {}) as Record<string, unknown>);
    if (!args) { decisions.push(block(name, 'invalid_arguments', {}, def)); return; }

    if (def.sideEffect) {
      if (def.blockedByHumanTakeover && ctx.humanTakeover) {
        decisions.push(block(name, 'human_takeover', args, def)); return;
      }
      if (!ctx.aiManaged) { decisions.push(block(name, 'conversation_not_ai_managed', args, def)); return; }
    }

    if (!visitorIntentSatisfied(def, ctx)) {
      decisions.push(block(name, 'no_visitor_intent', args, def)); return;
    }

    // Model output alone never authorizes a side effect (3.11).
    if (def.sideEffect && def.requiresDeterministicAuthorization
      && !(ctx.deterministicAuthorizedActions || []).includes(def.name)) {
      decisions.push(block(name, 'no_deterministic_authorization', args, def)); return;
    }

    // State-specific guards.
    if (def.name === 'mark_priority' && ctx.currentPriority
      && String(ctx.currentPriority).toLowerCase() === String(args.priority)) {
      decisions.push(block(name, 'priority_unchanged', args, def)); return;
    }
    if (def.name === 'add_tag') {
      const tags = ctx.currentTags || [];
      if (tags.includes(String(args.tag))) { decisions.push(block(name, 'tag_already_present', args, def)); return; }
      if (tags.length >= 20) { decisions.push(block(name, 'tag_limit_reached', args, def)); return; }
    }

    const key = def.idempotent
      ? buildIdempotencyKey({
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        visitorMessageId: ctx.visitorMessageId,
        name: def.name,
        args,
      })
      : null;
    if (key && (seenKeys.has(key) || perTurn.has(key))) {
      decisions.push({ ...block(name, 'duplicate_action', args, def), idempotencyKey: key }); return;
    }

    // Unsupported capability → planned only, never executed.
    if (!def.executable) {
      decisions.push({
        name, status: 'planned', reason: 'planned_only_unsupported', arguments: args,
        idempotencyKey: key, readOnly: def.readOnly, sideEffect: def.sideEffect,
      });
      return;
    }

    // Mode handling (3.12): suggest-only never auto-executes side effects.
    if (def.sideEffect && !ctx.canAutoReply) {
      decisions.push({
        name, status: 'planned', reason: ctx.canSuggest ? 'suggest_only_mode' : 'auto_reply_not_permitted',
        arguments: args, idempotencyKey: key, readOnly: def.readOnly, sideEffect: def.sideEffect,
      });
      return;
    }

    if (key) perTurn.add(key);
    decisions.push({
      name, status: 'allowed', reason: 'policy_allowed', arguments: args,
      idempotencyKey: key, readOnly: def.readOnly, sideEffect: def.sideEffect,
    });
  });

  return decisions;
}
