/**
 * AI Agent — Phase 3 action pipeline (3.8 ordering + 3.13 observability).
 *
 *   parse → gate → execute → record → (only then) deliver the reply
 *
 * The visitor-facing text is never delivered claiming an action succeeded
 * before it actually did: execution happens here, inside the generation
 * stage, strictly before the delivery stage inserts any message, and any
 * unverified completion claim is stripped when nothing executed.
 */
import { parseActionPlan } from './planner.js';
import { evaluateActionPlan, type ActionDecision, type GateContext } from './policyGate.js';
import type { ActionRunner } from './runner.js';
import type { IdempotencyStore } from './idempotency.js';

export interface ActionExecutionRecord {
  name: string;
  ok: boolean;
  reason: string;
  durationMs: number;
  idempotencyKey: string | null;
  data?: Record<string, unknown>;
}

export interface ActionPipelineResult {
  /** Sanitized visitor-facing text (action block removed). */
  text: string;
  decisions: ActionDecision[];
  executions: ActionExecutionRecord[];
  handoffExecuted: boolean;
  anySideEffectExecuted: boolean;
  anyFailure: boolean;
  metadata: Record<string, unknown>;
}

const CLAIM_PATTERNS = [
  /i(?:'ve| have) (?:marked|tagged|escalated|flagged|created|assigned|added)/i,
  /(?:marked|escalated) (?:this|it) as (?:urgent|high)/i,
  /connecting you (?:now|to)/i,
  /(?:علامت|ثبت|ارجاع) (?:زدم|شد|کردم)/,
];

export function containsCompletionClaim(text: string): boolean {
  const t = String(text || '');
  return CLAIM_PATTERNS.some((re) => re.test(t));
}

export function stripUnverifiedClaims(text: string, fallback: string): string {
  const sentences = String(text || '').split(/(?<=[.!?؟\n])\s+/);
  const kept = sentences.filter((s) => !containsCompletionClaim(s));
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return out || fallback;
}

export interface ActionPipelineInput {
  rawText: string;
  gate: GateContext;
  runner: ActionRunner;
  idempotency: IdempotencyStore;
  /** Safe text used when the whole reply was an unverified claim. */
  fallbackText: string;
}

export async function runActionPipeline(input: ActionPipelineInput): Promise<ActionPipelineResult> {
  const plan = parseActionPlan(input.rawText);
  const decisions = plan.actions.length
    ? evaluateActionPlan(input.gate, plan.actions)
    : [];

  const executions: ActionExecutionRecord[] = [];
  let handoffExecuted = false;
  let anySideEffectExecuted = false;
  let anyFailure = false;

  for (const d of decisions) {
    if (d.status !== 'allowed') continue;
    // Atomic claim-before-execute: only the claim winner may run the side
    // effect, so concurrent engine runs cannot duplicate it.
    if (d.idempotencyKey) {
      const claim = await input.idempotency.claim(d.idempotencyKey, { actionName: d.name });
      if (claim !== 'claimed') {
        d.status = 'blocked';
        d.reason = 'duplicate_action';
        continue;
      }
    }
    const started = Date.now();
    const res = await input.runner.run(d.name, d.arguments).catch(() => ({ ok: false, reason: 'execution_error' }));
    const rec: ActionExecutionRecord = {
      name: d.name,
      ok: !!res.ok,
      reason: res.reason || (res.ok ? 'ok' : 'failed'),
      durationMs: Date.now() - started,
      idempotencyKey: d.idempotencyKey,
      data: (res as any).data,
    };
    executions.push(rec);
    if (res.ok) {
      if (d.idempotencyKey) await input.idempotency.complete(d.idempotencyKey);
      if (d.sideEffect) anySideEffectExecuted = true;
      if (d.name === 'handoff_to_operator') handoffExecuted = true;
    } else {
      if (d.idempotencyKey) await input.idempotency.fail(d.idempotencyKey);
      anyFailure = true;
      d.reason = `execution_failed:${rec.reason}`;
    }
  }

  let text = plan.text;
  if (!anySideEffectExecuted && containsCompletionClaim(text)) {
    text = stripUnverifiedClaims(text, input.fallbackText);
  }

  const metadata = {
    planning_attempted: plan.blockPresent,
    parse_error: plan.parseError,
    dropped_for_bound: plan.droppedForBound,
    proposed: plan.actions.map((a) => a.name),
    allowed: decisions.filter((d) => d.status === 'allowed').map((d) => d.name),
    planned: decisions.filter((d) => d.status === 'planned').map((d) => ({ name: d.name, reason: d.reason })),
    blocked: decisions.filter((d) => d.status === 'blocked').map((d) => ({ name: d.name, reason: d.reason })),
    decisions: decisions.map((d) => ({
      name: d.name, status: d.status, reason: d.reason,
      arguments: d.arguments, idempotency_key: d.idempotencyKey,
    })),
    executions: executions.map((e) => ({
      name: e.name, ok: e.ok, reason: e.reason, duration_ms: e.durationMs, idempotency_key: e.idempotencyKey,
    })),
    human_takeover_blocked: decisions.some((d) => d.reason === 'human_takeover'),
  } as Record<string, unknown>;

  return { text, decisions, executions, handoffExecuted, anySideEffectExecuted, anyFailure, metadata };
}
