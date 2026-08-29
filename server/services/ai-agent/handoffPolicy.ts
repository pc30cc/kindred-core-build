/**
 * AI Agent — adaptive human-handoff policy.
 *
 * Replaces the rigid `keyword → immediate handoff` rule with three explicit
 * policies, while keeping every existing workspace byte-compatible.
 *
 *   immediate     A clear human request hands off right away. No model call.
 *                 This is the LEGACY behaviour of handoff_on_human_request.
 *
 *   assist_first  On the FIRST explicit human request the assistant may make
 *                 exactly one brief, useful attempt ("tell me the topic and
 *                 I may solve it here; otherwise I'll pass you on"). It must
 *                 never claim the transfer already happened. The second
 *                 request always hands off.
 *
 *   adaptive      Same as assist_first, but the single assist attempt is
 *                 skipped whenever conversation state already proves a human
 *                 is needed: repeated request, a failed AI solution, the
 *                 visitor rejecting AI, or mandatory routing.
 *
 * BACKWARD COMPATIBILITY (§53): `ai_agent_settings.handoff_policy` is
 * nullable. NULL is resolved at read time from the legacy flag:
 *
 *   handoff_on_human_request = true   → 'immediate'   (unchanged behaviour)
 *   handoff_on_human_request = false  → 'adaptive'    (AI never had a
 *                                        keyword handoff to lose here)
 *
 * Nothing changes for an existing workspace until an owner explicitly picks
 * a policy.
 */
import type { AgentSettings } from './settings.js';
import type { WorkingMemory } from './workingMemory.js';

export type HandoffPolicy = 'immediate' | 'assist_first' | 'adaptive';

export function resolveHandoffPolicy(settings: Partial<AgentSettings>): HandoffPolicy {
  const raw = (settings as any)?.handoff_policy;
  if (raw === 'immediate' || raw === 'assist_first' || raw === 'adaptive') return raw;
  // Legacy mapping — see the header note.
  return (settings as any)?.handoff_on_human_request === false ? 'adaptive' : 'immediate';
}

export function resolveMaxAssistAttempts(settings: Partial<AgentSettings>): number {
  const raw = Number((settings as any)?.max_assist_attempts);
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return Math.min(Math.floor(raw), 3);
}

/** Visitor says some variant of "no, I want a real person / stop the bot". */
const AI_REJECTION_PATTERNS = [
  /\b(not|don'?t want).{0,20}\b(bot|robot|ai|machine)\b/i,
  /\b(real|actual|human) (person|being|agent|operator)\b/i,
  /\b(stop|quit).{0,15}\b(bot|ai)\b/i,
  /(نمی‌?خوام|نمیخوام).{0,20}(ربات|هوش مصنوعی|بات)/,
  /(آدم|انسان|اپراتور) (واقعی|زنده)/,
  /(میگم|گفتم).{0,20}(اپراتور|انسان|پشتیبان)/,
  /(gerçek|canlı) (insan|kişi|temsilci)/i,
  /bot (istemiyorum|değil)/i,
];

export function looksLikeAiRejection(text: string): boolean {
  const t = String(text || '');
  return AI_REJECTION_PATTERNS.some((r) => r.test(t));
}

export type HandoffDecisionKind = 'handoff' | 'assist_once' | 'continue';

export interface HandoffPolicyInput {
  policy: HandoffPolicy;
  /** Deterministic: the current message matches a configured human keyword. */
  explicitHumanRequest: boolean;
  visitorText: string;
  memory: Pick<WorkingMemory, 'handoffRequestCount' | 'assistAttemptCount' | 'resolutionAttempts' | 'failedResources'>;
  maxAssistAttempts: number;
  /** Routing rule / workflow already demands a human — always wins. */
  mandatoryHuman?: boolean;
}

export interface HandoffPolicyDecision {
  kind: HandoffDecisionKind;
  reason: string;
  /** Handoff request count AFTER counting this turn. */
  handoffRequestCount: number;
  policy: HandoffPolicy;
}

/**
 * Pure. Given the policy plus durable conversation state, decide whether
 * this turn hands off, makes one assist attempt, or is not a human request
 * at all.
 *
 * Invariant (§19): a repeated explicit human request can NEVER be deflected.
 */
export function decideHandoff(input: HandoffPolicyInput): HandoffPolicyDecision {
  const { policy, explicitHumanRequest, memory, maxAssistAttempts } = input;

  if (!explicitHumanRequest && !input.mandatoryHuman) {
    return {
      kind: 'continue',
      reason: 'no_human_request',
      handoffRequestCount: memory.handoffRequestCount,
      policy,
    };
  }

  const count = explicitHumanRequest ? memory.handoffRequestCount + 1 : memory.handoffRequestCount;

  if (input.mandatoryHuman) {
    return { kind: 'handoff', reason: 'mandatory_routing', handoffRequestCount: count, policy };
  }

  if (policy === 'immediate') {
    return { kind: 'handoff', reason: 'policy_immediate', handoffRequestCount: count, policy };
  }

  // Repeated explicit request always wins — never trap the visitor.
  if (count > 1) {
    return { kind: 'handoff', reason: 'repeated_human_request', handoffRequestCount: count, policy };
  }
  if (memory.assistAttemptCount >= maxAssistAttempts) {
    return { kind: 'handoff', reason: 'assist_budget_exhausted', handoffRequestCount: count, policy };
  }

  if (policy === 'adaptive') {
    if (looksLikeAiRejection(input.visitorText)) {
      return { kind: 'handoff', reason: 'visitor_rejected_ai', handoffRequestCount: count, policy };
    }
    if (memory.resolutionAttempts.some((a) => a.status === 'failed') || memory.failedResources.length) {
      return { kind: 'handoff', reason: 'previous_solution_failed', handoffRequestCount: count, policy };
    }
  }

  return { kind: 'assist_once', reason: 'first_request_assist', handoffRequestCount: count, policy };
}

/**
 * Wording for the single assist-first attempt. Deliberately NOT a promise
 * that a transfer already happened (§18, §33).
 */
export function assistFirstMessage(locale: string): string {
  const l = String(locale || 'en').toLowerCase().split('-')[0];
  if (l === 'fa') {
    return 'حتماً. اگر بگید موضوع دقیقاً چیه، شاید همین‌جا سریع‌تر حلش کنیم؛ در غیر این‌صورت به همکارانم ارجاعش می‌دم.';
  }
  if (l === 'tr') {
    return 'Tabii. Konuyu kısaca yazarsanız belki burada daha hızlı çözebiliriz; olmazsa ekip arkadaşlarıma aktarırım.';
  }
  return "Of course. If you tell me what it's about, we might sort it out faster right here — otherwise I'll pass you on to a colleague.";
}

export function handoffPolicyMeta(d: HandoffPolicyDecision): Record<string, unknown> {
  return {
    handoff_policy: d.policy,
    handoff_decision: d.kind,
    handoff_decision_reason: d.reason,
    handoff_request_count: d.handoffRequestCount,
  };
}
